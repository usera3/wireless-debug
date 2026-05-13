import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import {
  buildQueryFrameLen,
  buildQueryMaxChannels,
  buildQuerySampleRate,
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

export function useOscController() {
  const {
    setRunning,
    setSampleRate,
    setMaxChannels,
    setFrameLen,
    frameLen,
    pushSamples,
    clearWaveData,
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

      // 4. 查询采样率
      const srResp = await sendAndWait(buildQuerySampleRate());
      const sr = parseFC04Response(srResp);
      if (sr != null) setSampleRate(sr);

      // 5. 开始采样
      wsClient.send(buildStartOsc());
      setRunning(true);

      // 注册示波数据帧 handler
      const channelWidths = channels.map((c) => c.byteWidth);
      frameRouter.onOscFrame((frame) => {
        const osc = parseOscDataFrame(frame, channelWidths);
        if (!osc) return;
        osc.channels.forEach((samples, idx) => {
          if (channels[idx]) pushSamples(channels[idx].channelNo, samples);
        });
      });

      // 6. 心跳 2s（模块级，切页不会停）
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        wsClient.send(buildHeartbeat());
      }, 2000);
    } catch (err) {
      console.error('[osc] start failed', err);
    }
  }, [clearWaveData, frameLen, pushSamples, setFrameLen, setMaxChannels, setRunning, setSampleRate]);

  const stop = useCallback(() => {
    wsClient.send(buildStopOsc());
    setRunning(false);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    frameRouter.onOscFrame(() => {}); // 清除示波 handler
  }, [setRunning]);

  return { start, stop };
}