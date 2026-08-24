import { useEffect, useRef, useCallback } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { frameRouter } from '../lib/frameRouter';

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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      frameRouter.onModbusFrame(() => {});
      reject(new Error('timeout'));
    }, TIMEOUT_MS);
    frameRouter.onModbusFrame((frame) => {
      clearTimeout(timer);
      frameRouter.onModbusFrame(() => {});
      resolve(frame);
    });
  });
}

async function readOne(param: ParamDef, setValue: (alias: string, val: number) => void): Promise<void> {
  const count = param.isFloat ? 2 : 1;
  const frame = buildReadHolding(param.regAddr, count);
  const waitP = waitModbusFrame();
  wsClient.send(frame);
  const resp = await waitP;
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
    dashBusy = true;
    try {
      for (const alias of DASHBOARD_ALIASES) {
        const param = getParamByAlias(alias);
        if (!param) continue;
        try {
          await readOne(param, setValue);
        } catch {
          // 单个参数读失败不中断整个轮询
        }
      }
    } finally {
      dashBusy = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setValue]);

  // 启动/停止轮询（仅在 enabled=true 时运行）
  useEffect(() => {
    if (dashTimer) clearInterval(dashTimer);
    dashBusy = false;

    if (!enabled) return;

    // 立即读一次（同步状态）
    pollOnce();

    dashTimer = setInterval(pollOnce, POLL_INTERVAL_MS);

    return () => {
      if (dashTimer) {
        clearInterval(dashTimer);
        dashTimer = null;
      }
    };
  // pollOnce 是 useCallback 稳定引用，connected/enabled 变化时重启轮询
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { writeParam };
}