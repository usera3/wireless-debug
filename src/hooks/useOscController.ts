import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import {
  buildQueryFrameLen,
  buildQueryMaxChannels,
  buildQuerySampleRate,
  buildSetBaudRate,
  buildSetChannel,
  buildStartOsc,
  buildStopOsc,
  buildHeartbeat,
  parseFC04Response,
  parseOscDataFrame,
} from '../lib/oscilloscope';
import { useOscStore, ChannelConfig } from '../store/oscStore';
import { frameRouter } from '../lib/frameRouter';
import { waitForOscResponse, waitForOscResponseWithRetry } from '../lib/oscRequest';
import { OscRealtimeBuffer } from '../lib/oscRealtimeBuffer';
import { OscJitterBuffer } from '../lib/oscJitterBuffer';
import {
  waitForOscStopBarrier,
  waitForSequencedOscStopBarrier,
  type OscStopBarrierResult,
} from '../lib/oscStopBarrier';
import { useConnectionStore } from '../store/connectionStore';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import {
  oscCapabilityCache,
  selectOscStartupMode,
  type OscCapabilities,
} from '../lib/oscCapabilityCache';

// 模块级心跳 timer，与组件生命周期无关，切页不会丢失
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let storeFlushTimer: ReturnType<typeof setInterval> | null = null;
let stopPromise: Promise<void> | null = null;
let startupStopPromise: Promise<OscStopBarrierResult> | null = null;

// 接收回调只写缓冲，固定节奏统一触发 store 和图表更新。
const oscBuffer = new OscRealtimeBuffer();
const cloudJitterBuffer = new OscJitterBuffer();
const STORE_FLUSH_INTERVAL_MS = 50;
const OSC_HANDSHAKE_TIMEOUT_MS = 8000;
const OSC_STOP_DRAIN_TIMEOUT_MS = 2500;
const OSC_QUERY_RETRY_DELAY_MS = 250;

function stopStoreFlushTimer() {
  if (!storeFlushTimer) return;
  clearInterval(storeFlushTimer);
  storeFlushTimer = null;
}

function startStoreFlushTimer(
  appendSamples: (batch: Map<number, number[]>) => void,
  useCloudJitter: boolean,
) {
  stopStoreFlushTimer();
  storeFlushTimer = setInterval(() => {
    const drained = useCloudJitter
      ? cloudJitterBuffer.drainDue(performance.now())
      : oscBuffer.drain(performance.now());
    if (drained) appendSamples(drained.batch);
  }, STORE_FLUSH_INTERVAL_MS);
}

export function useOscController() {
  const connectionUrl = useConnectionStore((state) => state.url);
  const {
    setRunning,
    setSampleRate,
    setMaxChannels,
    setFrameLen,
    appendSamples,
    resetHistory,
    commRateLimit,
    setStartError,
  } = useOscStore();

  /** 依次查询设备信息，再设置通道，最后开始采样 */
  const start = useCallback(async (channels: ChannelConfig[]) => {
    if (startupStopPromise) {
      await startupStopPromise;
      startupStopPromise = null;
    }
    stopStoreFlushTimer();
    resetHistory(channels);
    setStartError(null);
    frameRouter.reset();

    // 单请求-响应辅助：只接受与当前请求匹配的完整 Modbus 响应。
    function sendAndWait(
      frame: Uint8Array,
      acceptResponse?: (response: Uint8Array) => boolean,
    ): Promise<Uint8Array> {
      return waitForOscResponseWithRetry({
        request: frame,
        timeoutMs: OSC_HANDSHAKE_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: OSC_QUERY_RETRY_DELAY_MS,
        subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
        send: (request) => wsClient.send(request),
        acceptResponse,
      });
    }

    async function queryWithRetry(
      frame: Uint8Array,
      acceptValue: (value: number) => boolean,
    ): Promise<Uint8Array> {
      const acceptResponse = (response: Uint8Array) => {
        const value = parseFC04Response(response);
        return value != null && acceptValue(value);
      };

      return sendAndWait(frame, acceptResponse);
    }

    async function stopAndDrainPreviousRun(waitForAck = true) {
      if (!waitForAck) {
        startupStopPromise = waitForOscStopBarrier({
          timeoutMs: OSC_STOP_DRAIN_TIMEOUT_MS,
          subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
          send: (request) => wsClient.send(request),
        });
        frameRouter.reset();
        return;
      }
      try {
        await waitForOscResponse({
          request: buildStopOsc(),
          timeoutMs: OSC_STOP_DRAIN_TIMEOUT_MS,
          subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
          send: (request) => wsClient.send(request),
        });
      } catch {
        // 设备本来就未运行时可能不回停止帧，继续执行初始化即可。
      } finally {
        frameRouter.reset();
      }
    }

    function registerOscHandler(useCloudJitter: boolean) {
      const channelDescs = channels.map((c) => ({ byteWidth: c.byteWidth, paramType: c.paramType }));
      frameRouter.onOscFrame((frame) => {
        const osc = parseOscDataFrame(frame, channelDescs);
        if (!osc) return;

        if (useCloudJitter) {
          const batch = new Map<number, number[]>();
          osc.channels.forEach((samples, idx) => {
            const channel = channels[idx];
            if (channel) batch.set(channel.channelNo, samples);
          });
          cloudJitterBuffer.appendBatch(batch);
          return;
        }

        const receivedAt = performance.now();
        osc.channels.forEach((samples, idx) => {
          if (!channels[idx]) return;
          oscBuffer.append(channels[idx].channelNo, samples, receivedAt);
        });
      });
    }

    function applyCapabilities(capabilities: OscCapabilities) {
      setFrameLen(capabilities.frameLen);
      setMaxChannels(capabilities.maxChannels);
      setSampleRate(capabilities.sampleRate);
      resetHistory(channels, capabilities.sampleRate);
      frameRouter.setFrameLen(capabilities.frameLen);
    }

    try {
      const target = resolveConnectionTarget(connectionUrl, window.location.origin);
      const cachedCapabilities = oscCapabilityCache.read(target);
      const startupMode = selectOscStartupMode(target, cachedCapabilities);
      await stopAndDrainPreviousRun(target.kind !== 'cloud');

      let capabilities = cachedCapabilities;
      if (startupMode === 'cloud-cached' && capabilities) {
        applyCapabilities(capabilities);
      } else {
        // 冷启动只串行读取三个解析所必需的能力值；云端通道配置不再逐个等待 ACK。
        const flResp = await queryWithRetry(buildQueryFrameLen(), (value) => value >= 32 && value <= 512);
        const mcResp = await queryWithRetry(buildQueryMaxChannels(), (value) => value >= 1 && value <= 32);
        const srResp = await queryWithRetry(buildQuerySampleRate(), (value) => value >= 100 && value <= 100000);
        const fl = parseFC04Response(flResp);
        const mc = parseFC04Response(mcResp);
        const sr = parseFC04Response(srResp);
        if (fl == null || mc == null || sr == null) throw new Error('示波器能力查询结果无效');
        capabilities = { frameLen: fl, maxChannels: mc, sampleRate: sr };
        applyCapabilities(capabilities);
        oscCapabilityCache.write(target, capabilities);
      }

      // 云端按序连续发送，局域网继续逐个确认。
      for (const ch of channels) {
        const request = buildSetChannel(ch.channelNo, ch.paramType, ch.varAddr);
        if (target.kind === 'cloud') wsClient.send(request);
        else await sendAndWait(request);
      }

      // 4.5 若设置了通讯速率限制，发送 0x73；部分设备不支持该功能码，允许超时/错误
      if (commRateLimit !== 0) {
        if (target.kind === 'cloud') wsClient.send(buildSetBaudRate(commRateLimit));
        else try { await sendAndWait(buildSetBaudRate(commRateLimit)); }
        catch { console.warn('[osc] 0x73 not supported by device, ignored'); }
      }

      const useCloudJitter = target.kind === 'cloud';
      if (useCloudJitter) {
        oscBuffer.clear();
        cloudJitterBuffer.reset({
          channelNos: channels.map((channel) => channel.channelNo),
          sampleRate: capabilities.sampleRate,
          targetLatencyMs: 300,
          resumeLatencyMs: 100,
          tickMs: STORE_FLUSH_INTERVAL_MS,
          nowMs: performance.now(),
        });
      } else {
        cloudJitterBuffer.clear();
        oscBuffer.reset(performance.now());
      }
      registerOscHandler(useCloudJitter);
      startStoreFlushTimer(appendSamples, useCloudJitter);
      wsClient.send(buildStartOsc());
      setRunning(true);

      // 6. 心跳 2s（模块级，切页不会停）
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        wsClient.send(buildHeartbeat());
      }, 1000);
    } catch (err) {
      console.error('[osc] start failed', err);
      startupStopPromise = waitForSequencedOscStopBarrier(startupStopPromise, {
        timeoutMs: OSC_STOP_DRAIN_TIMEOUT_MS,
        subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
        send: (request) => wsClient.send(request),
      });
      stopStoreFlushTimer();
      oscBuffer.clear();
      cloudJitterBuffer.clear();
      frameRouter.reset();
      setStartError(err instanceof Error ? err.message : '地址示波器启动失败');
      setRunning(false);
    }
  }, [connectionUrl, appendSamples, resetHistory, setFrameLen, setMaxChannels, setRunning, setSampleRate, setStartError, commRateLimit]);

  const stop = useCallback(() => {
    if (stopPromise) return stopPromise;
    setStartError(null);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    stopPromise = waitForSequencedOscStopBarrier(startupStopPromise, {
      timeoutMs: OSC_STOP_DRAIN_TIMEOUT_MS,
      subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
      send: (request) => wsClient.send(request),
    }).then(() => {
      setRunning(false);
      stopStoreFlushTimer();
      const drained = oscBuffer.drain(performance.now());
      if (drained) appendSamples(drained.batch);
      const cloudTail = cloudJitterBuffer.drainAll();
      if (cloudTail) appendSamples(cloudTail.batch);
      oscBuffer.clear();
      cloudJitterBuffer.clear();
      frameRouter.onOscFrame(() => {}); // 清除示波 handler
      frameRouter.reset();
    }).finally(() => {
      startupStopPromise = null;
      stopPromise = null;
    });
    return stopPromise;
  }, [appendSamples, setRunning, setStartError]);

  return { start, stop };
}
