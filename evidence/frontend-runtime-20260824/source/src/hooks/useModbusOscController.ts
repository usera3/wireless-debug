import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { useModbusOscStore } from '../store/modbusOscStore';
import { frameRouter } from '../lib/frameRouter';
import { completeOscSample } from '../lib/modbusOscSample';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { useConnectionStore } from '../store/connectionStore';
import { waitForMatchingModbusFrame } from '../lib/modbusRequest';
import {
  modbusOscCycleAction,
  modbusOscResponseTimeoutMs,
} from '../lib/modbusOscTransportPolicy';

function waitModbusFrame(
  timeoutMs: number,
  expectedRegisterCount: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return waitForMatchingModbusFrame({
    timeoutMs,
    signal,
    matches: (frame) => (
      parseReadResponse(frame, expectedRegisterCount, { allowBadCrc: true }) != null
    ),
  });
}

// 模块级 timer，切页不会丢失，stop 始终能清掉
let modbusOscTimer: ReturnType<typeof setInterval> | null = null;
let modbusOscBusy = false;
let modbusOscAbortController: AbortController | null = null;
let modbusOscConsecutiveFailures = 0;

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
    const target = resolveConnectionTarget(
      useConnectionStore.getState().url,
      window.location.origin,
    );
    const responseTimeoutMs = modbusOscResponseTimeoutMs(target.kind);
    modbusOscAbortController?.abort();
    modbusOscAbortController = new AbortController();
    modbusOscConsecutiveFailures = 0;
    const signal = modbusOscAbortController.signal;
    resetHistory(pageParams.map((param) => param.alias), 1000 / Math.max(100, currentInterval));
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
      let cycleError: Error | null = null;
      try {
        for (const chunk of chunks) {
          const addrs = chunk.map((p) => p.regAddr);
          const minAddr = Math.min(...addrs);
          const maxAddr = Math.max(...chunk.map((p) => p.regAddr + registerWidth(p) - 1));
          const count = maxAddr - minAddr + 1;

          const frame = buildReadHolding(minAddr, count);
          const waitP = waitModbusFrame(responseTimeoutMs, count, signal);
          recordIoRequest();
          wsClient.send(frame);
          const resp = await waitP;
          recordIoResponse(resp.length);
          const regs = parseReadResponse(resp, count, { allowBadCrc: true });
          if (!regs) {
            throw new Error('响应格式错误');
          }

          for (const p of chunk) {
            const value = decodeParamValue(p, regs, minAddr);
            if (value == null) continue;
            samples[p.alias] = value;
          }
        }

        if (Object.keys(samples).length === 0) {
          throw new Error('未解析到有效参数');
        }
      } catch (err) {
        if (!signal.aborted) {
          cycleError = err instanceof Error ? err : new Error('通信错误');
          recordIoError(cycleError.message || '通信错误');
        }
      } finally {
        modbusOscBusy = false;
        if (!signal.aborted) {
          modbusOscConsecutiveFailures = cycleError ? modbusOscConsecutiveFailures + 1 : 0;
          const cycleAction = modbusOscCycleAction(
            target.kind,
            cycleError !== null,
            modbusOscConsecutiveFailures,
          );
          if (cycleAction === 'append') {
            const completedSamples = completeOscSample(
              pageParams.map((param) => param.alias),
              samples,
            );
            pushSamples(completedSamples);
            recordIoSamples(pageParams.length);
          }
          if (cycleAction === 'stop') {
            if (modbusOscTimer) clearInterval(modbusOscTimer);
            modbusOscTimer = null;
            modbusOscAbortController?.abort();
            modbusOscAbortController = null;
            setRunning(false);
          }
        }
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
    modbusOscAbortController?.abort();
    modbusOscAbortController = null;
    modbusOscConsecutiveFailures = 0;
    if (modbusOscTimer) {
      clearInterval(modbusOscTimer);
      modbusOscTimer = null;
    }
    modbusOscBusy = false;
    setRunning(false);
  }, [setRunning]);

  return { start, stop };
}
