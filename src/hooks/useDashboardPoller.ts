import { useEffect, useRef, useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { waitForMatchingModbusFrame } from '../lib/modbusRequest';
import { registerConnectionCleanup } from '../lib/connectionLifecycle';

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

function waitModbusFrame(): Promise<Uint8Array> {
  return waitForMatchingModbusFrame({ timeoutMs: TIMEOUT_MS });
}

async function readOne(param: ParamDef, setValue: (alias: string, val: number) => void): Promise<void> {
  const generation = wsClient.generation;
  const count = param.isFloat ? 2 : 1;
  const frame = buildReadHolding(param.regAddr, count);
  const waitP = waitModbusFrame();
  wsClient.send(frame);
  const resp = await waitP;
  if (wsClient.generation !== generation) throw new DOMException('Connection changed', 'AbortError');
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

let dashTimer: ReturnType<typeof setInterval> | null = null;
let dashBusy = false;
let pollEpoch = 0;
registerConnectionCleanup(() => {
  pollEpoch++;
  dashBusy = false;
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = null;
});

export function useDashboardPoller(enabled: boolean = false) {
  const params = useParamStore((s) => s.params);
  const setValue = useParamStore((s) => s.setValue);
  const connected = wsClient.readyState === WebSocket.OPEN;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // 解析 alias → ParamDef 映射
  function getParamByAlias(alias: string): ParamDef | undefined {
    return paramsRef.current.find((p) => p.alias === alias);
  }

  const pollOnce = useCallback(async () => {
    if (dashBusy) return;
    const epoch = pollEpoch;
    const generation = wsClient.generation;
    dashBusy = true;
    try {
      for (const alias of DASHBOARD_ALIASES) {
        if (epoch !== pollEpoch || generation !== wsClient.generation) return;
        const param = getParamByAlias(alias);
        if (!param) continue;
        try {
          await readOne(param, setValue);
        } catch {
          // 单个参数读失败不中断整个轮询
        }
      }
    } finally {
      if (epoch === pollEpoch) dashBusy = false;
    }
  }, [setValue]);

  // 启动/停止轮询（仅在 enabled=true 时运行）
  useEffect(() => {
    pollEpoch++;
    if (dashTimer) clearInterval(dashTimer);
    dashBusy = false;

    if (!enabled || !connected) return;

    // 立即读一次（同步状态）
    pollOnce();

    dashTimer = setInterval(pollOnce, POLL_INTERVAL_MS);

    return () => {
      pollEpoch++;
      if (dashTimer) {
        clearInterval(dashTimer);
        dashTimer = null;
      }
    };
  // pollOnce 是 useCallback 稳定引用，connected/enabled 变化时重启轮询
  }, [pollOnce, connected, enabled]);

  /** 写入单个寄存器（实际值） */
  const writeParam = useCallback(
    async (alias: string, actual: number): Promise<void> => {
      const param = getParamByAlias(alias);
      if (!param) return;
      const raw = Math.round(actual * Math.pow(10, param.decimals));
      const unsigned = raw < 0 ? raw + 0x10000 : raw;
      const frame = buildWriteSingle(param.regAddr, unsigned & 0xffff);
      const waitP = waitModbusFrame();
      wsClient.send(frame);
      await waitP;
    },
    [],
  );

  return { writeParam };
}
