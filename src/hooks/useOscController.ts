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

// 模块级心跳 timer，与组件生命周期无关，切页不会丢失
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// RAF 限流：缓冲区 + 动画帧句柄
let oscBuffer: Map<number, number[]> = new Map();
let rafHandle: number | null = null;

export function useOscController() {
  const {
    setRunning,
    setSampleRate,
    setMaxChannels,
    setFrameLen,
    frameLen,
    batchPushSamples,
    clearWaveData,
    commRateLimit,
  } = useOscStore();

  /** 依次查询设备信息，再设置通道，最后开始采样 */
  const start = useCallback(async (channels: ChannelConfig[]) => {
    clearWaveData();

    // 单请求-响应辅助：发送帧，等待 Modbus 响应（超时 1000ms）
    function sendAndWait(frame: Uint8Array): Promise<Uint8Array> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wsClient.removeHandler(handler);
          reject(new Error('timeout'));
        }, 1000);

        const handler = (data: Uint8Array) => {
          clearTimeout(timer);
          wsClient.removeHandler(handler);
          resolve(data);
        };
        wsClient.onFrame(handler);
        wsClient.send(frame);
      });
    }

    try {
      // 1. 查询帧长
      const flResp = await sendAndWait(buildQueryFrameLen());
      const fl = parseFC04Response(flResp);
      if (fl != null) setFrameLen(fl);
      frameRouter.setFrameLen(fl ?? frameLen);

      // 2. 查询最大通道数
      const mcResp = await sendAndWait(buildQueryMaxChannels());
      const mc = parseFC04Response(mcResp);
      if (mc != null) setMaxChannels(mc);

      // 3. 设置各通道
      for (const ch of channels) {
        await sendAndWait(buildSetChannel(ch.channelNo, ch.paramType, ch.varAddr));
      }

      // 3.5 若设置了通讯速率限制，发送 0x73；部分设备不支持该功能码，允许超时/错误
      if (commRateLimit !== 0) {
        try {
          await sendAndWait(buildSetBaudRate(commRateLimit));
        } catch {
          console.warn('[osc] 0x73 not supported by device, ignored');
        }
      }

      // 4. 查询采样率
      const srResp = await sendAndWait(buildQuerySampleRate());
      const sr = parseFC04Response(srResp);
      if (sr != null) setSampleRate(sr);

      // 5. 开始采样
      wsClient.send(buildStartOsc());
      setRunning(true);

      // 注册示波数据帧 handler：只写 buffer，不触发 store
      oscBuffer = new Map();
      const channelWidths = channels.map((c) => c.byteWidth);
      frameRouter.onOscFrame((frame) => {
        const osc = parseOscDataFrame(frame, channelWidths);
        if (!osc) return;
        osc.channels.forEach((samples, idx) => {
          if (!channels[idx]) return;
          const chNo = channels[idx].channelNo;
          const existing = oscBuffer.get(chNo) ?? [];
          existing.push(...samples);
          oscBuffer.set(chNo, existing);
        });
      });

      // RAF flush：每个动画帧把 buffer 一次性写入 store
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      const flush = () => {
        if (oscBuffer.size > 0) {
          batchPushSamples(oscBuffer);
          oscBuffer = new Map();
        }
        rafHandle = requestAnimationFrame(flush);
      };
      rafHandle = requestAnimationFrame(flush);

      // 6. 心跳 2s（模块级，切页不会停）
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        wsClient.send(buildHeartbeat());
      }, 1000);
    } catch (err) {
      console.error('[osc] start failed', err);
    }
  }, [clearWaveData, frameLen, batchPushSamples, setFrameLen, setMaxChannels, setRunning, setSampleRate, commRateLimit]);

  const stop = useCallback(() => {
    wsClient.send(buildStopOsc());
    setRunning(false);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    oscBuffer = new Map();
    frameRouter.onOscFrame(() => {}); // 清除示波 handler
  }, [setRunning]);

  return { start, stop };
}