import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import {
  buildQueryFrameLen,
  buildQueryMaxChannels,
  buildQuerySampleRate,
  buildSetBaudRate,
  buildSetChannel,
  buildStartOsc,
  buildHeartbeat,
  parseFC04Response,
  parseOscDataFrame,
} from '../lib/oscilloscope';
import { useOscStore, ChannelConfig } from '../store/oscStore';
import { frameRouter } from '../lib/frameRouter';
import { waitForOscResponse, waitForOscResponseWithRetry } from '../lib/oscRequest';
import { configureOscChannels } from '../lib/oscChannelHandshake';
import { getOscChannelType, validateOscChannelConfigs } from '../lib/oscChannelTypes';
import { OscJitterBuffer } from '../lib/oscJitterBuffer';
import {
  OscStopBarrierSequence,
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
let stopBarrierSequence = new OscStopBarrierSequence();
let lastStopBarrierPromise: Promise<OscStopBarrierResult> | null = null;
let stopBarrierTargetKey: string | null = null;
let stopBarrierConnectionGeneration: number | null = null;

// 接收回调只写缓冲，固定节奏统一触发 store 和图表更新。
const oscPlaybackBuffer = new OscJitterBuffer();
const STORE_FLUSH_INTERVAL_MS = 50;
const LOCAL_OSC_TARGET_LATENCY_MS = 200;
const CLOUD_OSC_TARGET_LATENCY_MS = 300;
const OSC_HANDSHAKE_TIMEOUT_MS = 8000;
const OSC_STOP_DRAIN_TIMEOUT_MS = 2500;
const OSC_QUERY_RETRY_DELAY_MS = 250;

function queueOscStopBarrier(): Promise<OscStopBarrierResult> {
  const expectedGeneration = stopBarrierConnectionGeneration ?? wsClient.generation;
  const barrier = stopBarrierSequence.wait({
    timeoutMs: OSC_STOP_DRAIN_TIMEOUT_MS,
    subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
    send: (request) => {
      if (wsClient.generation === expectedGeneration) wsClient.send(request);
    },
    isCurrent: () => wsClient.generation === expectedGeneration,
  });
  lastStopBarrierPromise = barrier;
  return barrier;
}

function stopStoreFlushTimer() {
  if (!storeFlushTimer) return;
  clearInterval(storeFlushTimer);
  storeFlushTimer = null;
}

function startStoreFlushTimer(
  appendSamples: (batch: Map<number, number[]>) => void,
) {
  stopStoreFlushTimer();
  storeFlushTimer = setInterval(() => {
    const drained = oscPlaybackBuffer.drainDue(performance.now());
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

  /** 查询设备能力、确认通道配置，最后开始采样。 */
  const start = useCallback(async (channels: ChannelConfig[]) => {
    if (stopPromise) await stopPromise;
    else if (lastStopBarrierPromise) await lastStopBarrierPromise;
    const target = resolveConnectionTarget(connectionUrl, window.location.origin);
    const targetKey = target.kind === 'invalid' ? connectionUrl : target.wsUrl;
    const connectionGeneration = wsClient.generation;
    if (
      stopBarrierTargetKey !== targetKey ||
      stopBarrierConnectionGeneration !== connectionGeneration
    ) {
      stopBarrierSequence = new OscStopBarrierSequence();
      lastStopBarrierPromise = null;
      stopBarrierTargetKey = targetKey;
      stopBarrierConnectionGeneration = connectionGeneration;
    }
    stopStoreFlushTimer();
    resetHistory(channels);
    setStartError(null);
    frameRouter.reset();

    // 能力查询允许重试；通道配置会改变设备累计槽位，不能重复发送。
    function sendAndWaitOnce(
      frame: Uint8Array,
      acceptResponse?: (response: Uint8Array) => boolean,
    ): Promise<Uint8Array> {
      return waitForOscResponse({
        request: frame,
        timeoutMs: OSC_HANDSHAKE_TIMEOUT_MS,
        subscribe: (handler) => frameRouter.subscribeModbusFrame(handler),
        send: (request) => wsClient.send(request),
        acceptResponse,
      });
    }

    function sendAndWaitWithRetry(
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

      return sendAndWaitWithRetry(frame, acceptResponse);
    }

    async function stopAndDrainPreviousRun(waitForAck = true) {
      const stopping = queueOscStopBarrier();
      if (!waitForAck) {
        frameRouter.reset();
        return;
      }
      await stopping;
      frameRouter.reset();
    }

    function registerOscHandler() {
      const channelDescs = channels.map((channel) => ({ typeKey: channel.typeKey }));
      let decodeFailed = false;
      frameRouter.onOscFrame((frame) => {
        if (decodeFailed) return;
        try {
          const osc = parseOscDataFrame(frame, channelDescs);
          if (!osc) return;

          const batch = new Map<number, number[]>();
          osc.channels.forEach((samples, idx) => {
            const channel = channels[idx];
            if (channel) batch.set(channel.channelNo, samples);
          });
          oscPlaybackBuffer.appendBatch(batch);
        } catch (error) {
          decodeFailed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          stopStoreFlushTimer();
          oscPlaybackBuffer.clear();
          frameRouter.onOscFrame(() => {});
          setRunning(false);
          setStartError(
            `地址示波器解码失败：${error instanceof Error ? error.message : '数据类型不匹配'}`,
          );
          console.error('[osc] frame decode failed', error);
          void queueOscStopBarrier();
        }
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
      const cachedCapabilities = oscCapabilityCache.read(target);
      const startupMode = selectOscStartupMode(target, cachedCapabilities);
      await stopAndDrainPreviousRun(target.kind !== 'cloud');

      let capabilities = cachedCapabilities;
      if (startupMode === 'cloud-cached' && capabilities) {
        applyCapabilities(capabilities);
      } else {
        // 冷启动只串行读取三个解析所必需的能力值。
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

      validateOscChannelConfigs(
        channels.map(({ channelNo, varAddr, typeKey }) => ({ channelNo, varAddr, typeKey })),
        capabilities.maxChannels,
      );

      const channelRequests = channels.map((channel) => buildSetChannel(
        channel.channelNo,
        getOscChannelType(channel.typeKey).paramType,
        channel.varAddr,
      ));
      await configureOscChannels(
        channelRequests,
        target.kind === 'cloud' ? 'parallel' : 'serial',
        (request) => sendAndWaitOnce(request),
      );

      // 4.5 若设置了通讯速率限制，发送 0x73；部分设备不支持该功能码，允许超时/错误
      if (commRateLimit !== 0) {
        if (target.kind === 'cloud') wsClient.send(buildSetBaudRate(commRateLimit));
        else try { await sendAndWaitWithRetry(buildSetBaudRate(commRateLimit)); }
        catch { console.warn('[osc] 0x73 not supported by device, ignored'); }
      }

      oscPlaybackBuffer.reset({
        channelNos: channels.map((channel) => channel.channelNo),
        sampleRate: capabilities.sampleRate,
        targetLatencyMs: target.kind === 'cloud'
          ? CLOUD_OSC_TARGET_LATENCY_MS
          : LOCAL_OSC_TARGET_LATENCY_MS,
        resumeLatencyMs: 100,
        tickMs: STORE_FLUSH_INTERVAL_MS,
        nowMs: performance.now(),
      });
      registerOscHandler();
      startStoreFlushTimer(appendSamples);
      wsClient.send(buildStartOsc());
      setRunning(true);

      // 6. 心跳 2s（模块级，切页不会停）
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        wsClient.send(buildHeartbeat());
      }, 1000);
    } catch (err) {
      console.error('[osc] start failed', err);
      queueOscStopBarrier();
      stopStoreFlushTimer();
      oscPlaybackBuffer.clear();
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

    stopPromise = queueOscStopBarrier().then(() => {
      setRunning(false);
      stopStoreFlushTimer();
      const playbackTail = oscPlaybackBuffer.drainAll();
      if (playbackTail) appendSamples(playbackTail.batch);
      oscPlaybackBuffer.clear();
      frameRouter.onOscFrame(() => {}); // 清除示波 handler
      frameRouter.reset();
    }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }, [appendSamples, setRunning, setStartError]);

  return { start, stop };
}
