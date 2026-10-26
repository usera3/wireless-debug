import { useEffect, useRef, useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { waitForMatchingModbusFrame } from '../lib/modbusRequest';
import { useConnectionStore } from '../store/connectionStore';

const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 500;

// 需要轮询的 alias 列表（仅状态显示）
export const DASHBOARD_ALIASES = [
  'MotorSpd',
  'MotorIq',
  'Vdc',
  'MotorPower',
  'PcbTemp',
  'AlmCode',
] as const;

function waitModbusFrame(signal?: AbortSignal): Promise<Uint8Array> {
  return waitForMatchingModbusFrame({ timeoutMs: TIMEOUT_MS, signal });
}

async function readOne(
  param: ParamDef,
  setValue: (alias: string, val: number) => void,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const count = param.isFloat ? 2 : 1;
  const frame = buildReadHolding(param.regAddr, count);
  const waitP = waitModbusFrame(signal);
  wsClient.send(frame);
  const resp = await waitP;
  if (!isCurrent()) return;
  const regs = parseReadResponse(resp);
  if (!regs) return;

  let raw: number;
  if (param.isFloat) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint16(0, regs[0], false);
    view.setUint16(2, regs[1], false);
    raw = view.getFloat32(0, false);
  } else {
    raw = param.signed ? (regs[0] >= 0x8000 ? regs[0] - 0x10000 : regs[0]) : regs[0];
  }

  const actual = param.isFloat ? raw : raw / Math.pow(10, param.decimals);
  setValue(param.alias, actual);
}

export function useDashboardPoller(enabled: boolean = false) {
  const params = useParamStore((s) => s.params);
  const setValue = useParamStore((s) => s.setValue);
  const connected = useConnectionStore((s) => s.connected);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // 解析 alias → ParamDef 映射
  function getParamByAlias(alias: string): ParamDef | undefined {
    return paramsRef.current.find((p) => p.alias === alias);
  }

  // 启动/停止轮询（仅在 enabled=true 时运行）
  useEffect(() => {
    if (!enabled || !connected) return;

    const controller = new AbortController();
    const generation = wsClient.generation;
    const isCurrent = () => !controller.signal.aborted
      && useConnectionStore.getState().connected && wsClient.generation === generation;
    let busy = false;
    const pollOnce = async () => {
      if (busy || !isCurrent()) return;
      busy = true;
      try {
        for (const alias of DASHBOARD_ALIASES) {
          if (!isCurrent()) break;
          const param = getParamByAlias(alias);
          if (!param) continue;
          try {
            await readOne(param, setValue, controller.signal, isCurrent);
          } catch {
            // 单个参数读失败不中断当前连接的轮询
          }
        }
      } finally {
        busy = false;
      }
    };

    // 立即读一次（同步状态）
    pollOnce();

    const timer = setInterval(pollOnce, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  // 参数通过 paramsRef 读取，连接/使能变化时独立重建轮询生命周期。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, enabled, setValue]);

  /** 写入单个寄存器（实际值） */
  const writeParam = useCallback(
    async (alias: string, actual: number): Promise<void> => {
      if (!useConnectionStore.getState().connected) return;
      const param = getParamByAlias(alias);
      if (!param) return;
      const raw = Math.round(actual * Math.pow(10, param.decimals));
      const unsigned = raw < 0 ? raw + 0x10000 : raw;
      const frame = buildWriteSingle(param.regAddr, unsigned & 0xffff);
      const waitP = waitModbusFrame();
      wsClient.send(frame);
      await waitP;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { writeParam };
}
