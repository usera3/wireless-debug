import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { useModbusOscStore } from '../store/modbusOscStore';
import { frameRouter } from '../lib/frameRouter';
import { completeOscSample } from '../lib/modbusOscSample';
import { oscLiveFeed } from '../lib/oscLiveFeed';

/** 等待一个匹配当前 FC03 请求的 Modbus 响应帧，超时 reject */
function waitModbusFrame(timeoutMs: number, expectedRegisterCount: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      frameRouter.onModbusFrame(() => {});
      reject(new Error('modbus timeout'));
    }, timeoutMs);

    frameRouter.onModbusFrame((frame) => {
      if (parseReadResponse(frame, expectedRegisterCount, { allowBadCrc: true }) == null) return;
      clearTimeout(timer);
      frameRouter.onModbusFrame(() => {});
      resolve(frame);
    });
  });
}

// 模块级 timer，切页不会丢失，stop 始终能清掉
let modbusOscTimer: ReturnType<typeof setInterval> | null = null;
let modbusOscBusy = false;

const MODBUS_TIMEOUT_MS = 1000; // 单次 Modbus 响应超时，与采样间隔无关

function registerWidth(param: ParamDef): number {
  return param.isFloat ? 2 : 1;
}

function decodeParamValue(param: ParamDef, regs: number[], minAddr: number): number | null {
  const offset = param.regAddr - minAddr;
  if (offset < 0 || offset + registerWidth(param) > regs.length) return null;

  if (param.isFloat) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint16(0, regs[offset], false);
    view.setUint16(2, regs[offset + 1], false);
    return view.getFloat32(0, false);
  }

  const raw = regs[offset];
  const signed = param.signed ? (raw >= 0x8000 ? raw - 0x10000 : raw) : raw;
  return signed / Math.pow(10, param.decimals);
}

export function useModbusOscController() {
  const {
    selectedPage,
    setRunning,
    pushSamples,
    resetHistory,
    resetIoStats,
    recordIoRequest,
    recordIoResponse,
    recordIoSamples,
    recordIoError,
  } =
    useModbusOscStore();
  const params = useParamStore((s) => s.params);

  const start = useCallback((overridePage?: string) => {
    const page = overridePage ?? selectedPage;
    const pageParams = params.filter((p) => p.page === page);
    if (pageParams.length === 0) return;

    if (overridePage && overridePage !== selectedPage) {
      useModbusOscStore.getState().setSelectedPage(overridePage);
    }

    const { interval: currentInterval, readChunkSize: currentChunkSize } = useModbusOscStore.getState();
    const aliases = pageParams.map((param) => param.alias);
    const sampleRate = 1000 / Math.max(100, currentInterval);
    resetHistory(aliases, sampleRate);
    oscLiveFeed.reset({
      channelNos: aliases.map((_, index) => index + 1),
      sampleRate,
      maxBufferedSamples: Math.max(200, Math.ceil(sampleRate * 20)),
    });
    oscLiveFeed.setEnabled(true);
    resetIoStats();
    frameRouter.reset();
    setRunning(true);

    // 从 store 直接读最新值，避免闭包拿到旧值

    // 将参数按地址排序后分组；readChunkSize=0 表示不分组（整页一次读）
    const sorted = [...pageParams].sort((a, b) => a.regAddr - b.regAddr);
    const chunkSize = currentChunkSize > 0 ? currentChunkSize : sorted.length;
    const chunks: typeof pageParams[] = [];
    for (let i = 0; i < sorted.length; i += chunkSize) {
      chunks.push(sorted.slice(i, i + chunkSize));
    }

    if (modbusOscTimer) clearInterval(modbusOscTimer);

    const pollOnce = async () => {
      if (modbusOscBusy) return;
      modbusOscBusy = true;
      const samples: Record<string, number> = {};
      try {
        for (const chunk of chunks) {
          const addrs = chunk.map((p) => p.regAddr);
          const minAddr = Math.min(...addrs);
          const maxAddr = Math.max(...chunk.map((p) => p.regAddr + registerWidth(p) - 1));
          const count = maxAddr - minAddr + 1;

          const frame = buildReadHolding(minAddr, count);
          const waitP = waitModbusFrame(MODBUS_TIMEOUT_MS, count);
          recordIoRequest();
          wsClient.send(frame);
          const resp = await waitP;
          recordIoResponse(resp.length);
          const regs = parseReadResponse(resp, count, { allowBadCrc: true });
          if (!regs) {
            recordIoError('响应格式错误');
            continue;
          }

          for (const p of chunk) {
            const value = decodeParamValue(p, regs, minAddr);
            if (value == null) continue;
            samples[p.alias] = value;
          }
        }

        if (Object.keys(samples).length === 0) {
          recordIoError('未解析到有效参数');
        }
      } catch (err) {
        recordIoError((err as Error).message || '通信错误');
      } finally {
        const completedSamples = completeOscSample(
          aliases,
          samples,
        );
        const liveBatch = new Map<number, number[]>();
        aliases.forEach((alias, index) => {
          liveBatch.set(index + 1, [completedSamples[alias] ?? Number.NaN]);
        });
        oscLiveFeed.push(liveBatch, performance.now());
        pushSamples(completedSamples);
        recordIoSamples(pageParams.length);
        modbusOscBusy = false;
      }
    };

    void pollOnce();
    modbusOscTimer = setInterval(() => {
      void pollOnce();
    }, currentInterval);
  }, [
    params,
    selectedPage,
    resetHistory,
    resetIoStats,
    setRunning,
    pushSamples,
    recordIoRequest,
    recordIoResponse,
    recordIoSamples,
    recordIoError,
  ]);

  const stop = useCallback(() => {
    if (modbusOscTimer) {
      clearInterval(modbusOscTimer);
      modbusOscTimer = null;
    }
    frameRouter.onModbusFrame(() => {}); // 释放 handler
    modbusOscBusy = false;
    oscLiveFeed.clear();
    oscLiveFeed.setEnabled(false);
    setRunning(false);
  }, [setRunning]);

  return { start, stop };
}
