import { useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, parseReadResponse } from '../lib/modbus';
import { useParamStore } from '../store/paramStore';
import { useModbusOscStore } from '../store/modbusOscStore';
import { frameRouter } from '../lib/frameRouter';

/** 等待一个 Modbus 响应帧，超时 reject */
function waitModbusFrame(timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      frameRouter.onModbusFrame(() => {});
      reject(new Error('modbus timeout'));
    }, timeoutMs);

    frameRouter.onModbusFrame((frame) => {
      clearTimeout(timer);
      frameRouter.onModbusFrame(() => {});
      resolve(frame);
    });
  });
}

// 模块级 timer，切页不会丢失，stop 始终能清掉
let modbusOscTimer: ReturnType<typeof setInterval> | null = null;
let modbusOscBusy = false;

export function useModbusOscController() {
  const { running, interval, selectedPage, setRunning, pushSamples, clearWaveData } =
    useModbusOscStore();
  const params = useParamStore((s) => s.params);

  const start = useCallback(() => {
    const pageParams = params.filter((p) => p.page === selectedPage);
    if (pageParams.length === 0) return;

    clearWaveData();
    setRunning(true);

    const addrs = pageParams.map((p) => p.regAddr);
    const minAddr = Math.min(...addrs);
    const maxAddr = Math.max(...addrs);
    const count = maxAddr - minAddr + 1; // 无 float，每参数 1 个寄存器

    if (modbusOscTimer) clearInterval(modbusOscTimer);
    modbusOscTimer = setInterval(async () => {
      if (modbusOscBusy) return;
      modbusOscBusy = true;
      try {
        const frame = buildReadHolding(minAddr, count);
        const waitP = waitModbusFrame(interval);
        wsClient.send(frame);
        const resp = await waitP;
        const regs = parseReadResponse(resp);
        if (!regs) return;

        const samples: Record<string, number> = {};
        for (const p of pageParams) {
          const offset = p.regAddr - minAddr;
          if (offset < 0 || offset >= regs.length) continue;
          const raw = regs[offset];
          const signed = p.signed ? (raw >= 0x8000 ? raw - 0x10000 : raw) : raw;
          const actual = signed / Math.pow(10, p.decimals);
          samples[p.alias] = actual;
        }
        pushSamples(samples);
      } catch {
        // 超时或通信错误，本次跳过
      } finally {
        modbusOscBusy = false;
      }
    }, interval);
  }, [params, selectedPage, interval, clearWaveData, setRunning, pushSamples]);

  const stop = useCallback(() => {
    if (modbusOscTimer) {
      clearInterval(modbusOscTimer);
      modbusOscTimer = null;
    }
    frameRouter.onModbusFrame(() => {}); // 释放 handler
    modbusOscBusy = false;
    setRunning(false);
  }, [setRunning]);

  return { start, stop, running };
}