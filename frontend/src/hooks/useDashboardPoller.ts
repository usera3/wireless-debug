import { useEffect, useRef, useCallback, useState, useSyncExternalStore } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { waitForMatchingModbusFrame } from '../lib/modbusRequest';
import { useConnectionStore } from '../store/connectionStore';

const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 500;
const HISTORY_WINDOW_MS = 60_000;
const MAX_HISTORY_POINTS = 240;

export type DashboardReading = { value: number; receivedAt: number };
export type DashboardPoint = { receivedAt: number; value: number | null };
type Identity = { params: ParamDef[]; url: string; generation: number };
type Telemetry = Pick<Identity, 'params' | 'url'> & {
  readings: Record<string, DashboardReading>;
  speedHistory: DashboardPoint[];
};

// 需要轮询的 alias 列表（仅状态显示）
export const DASHBOARD_ALIASES = [
  'MotorSpd',
  'MotorIq',
  'Vdc',
  'MotorPower',
  'PcbTemp',
  'AlmCode',
] as const;

function appendPoint(history: DashboardPoint[], point: DashboardPoint): DashboardPoint[] {
  const recent = history.filter(item => item.receivedAt >= point.receivedAt - HISTORY_WINDOW_MS);
  if (point.value === null && recent[recent.length - 1]?.value === null) return recent;
  return [...recent, point].slice(-MAX_HISTORY_POINTS);
}

function readValue(param: ParamDef, response: Uint8Array): number | null {
  const regs = parseReadResponse(response, param.isFloat ? 2 : 1);
  if (response[0] !== 0xff || !regs) return null;
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
  return Number.isFinite(actual) ? actual : null;
}

export function useDashboardPoller(enabled: boolean = false) {
  const params = useParamStore((s) => s.params);
  const setValue = useParamStore((s) => s.setValue);
  const connected = useConnectionStore((s) => s.connected);
  const url = useConnectionStore((s) => s.url);
  // A close/open in one React batch may leave connected=true throughout the
  // render. Observe the socket generation separately so the new loop starts.
  const generation = useSyncExternalStore(useCallback(notify => {
    const unreset = wsClient.onConnectionReset(notify);
    const unconnection = useConnectionStore.subscribe(notify);
    return () => { unreset(); unconnection(); };
  }, []), () => wsClient.generation);
  const [telemetry, setTelemetry] = useState<Telemetry>(() => ({ params, url, readings: {}, speedHistory: [] }));
  const active = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const queue = useRef<(Identity & { tail: Promise<void> }) | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requests.current.forEach(controller => controller.abort());
    };
  }, []);

  useEffect(() => {
    setTelemetry(previous => previous.params === params && previous.url === url
      ? previous : { params, url, readings: {}, speedHistory: [] });
  }, [params, url]);

  const isCurrent = useCallback((identity: Identity) => active.current
    && useConnectionStore.getState().connected
    && useConnectionStore.getState().url === identity.url
    && useParamStore.getState().params === identity.params
    && wsClient.generation === identity.generation, []);

  // Only this mounted dashboard's reads/writes are serialized. Modbus RTU read
  // responses contain no requested address; this is not global bus arbitration.
  const request = useCallback(async (
    identity: Identity,
    frame: Uint8Array,
    matches: (response: Uint8Array) => boolean,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!queue.current || queue.current.params !== identity.params
      || queue.current.url !== identity.url || queue.current.generation !== identity.generation) {
      queue.current = { ...identity, tail: Promise.resolve() };
    }
    const session = queue.current;
    const task = session.tail.then(async () => {
      if (!isCurrent(identity) || signal?.aborted) throw new Error('连接或参数表已变更，请重试');
      const controller = new AbortController();
      requests.current.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const unreset = wsClient.onConnectionReset(abort);
      const unparams = useParamStore.subscribe(state => {
        if (state.params !== identity.params) abort();
      });
      const unconnection = useConnectionStore.subscribe(state => {
        if (!state.connected || state.url !== identity.url) abort();
      });
      const wait = waitForMatchingModbusFrame({ timeoutMs: TIMEOUT_MS, signal: controller.signal, matches });
      try {
        try {
          if (!wsClient.send(frame)) throw new Error('发送失败，请检查连接');
        } catch (error) {
          controller.abort();
          await wait.catch(() => {});
          throw error;
        }
        const response = await wait;
        if (!isCurrent(identity) || controller.signal.aborted || signal?.aborted) {
          throw new Error('连接或参数表已变更，请重试');
        }
        return response;
      } finally {
        signal?.removeEventListener('abort', abort);
        unreset(); unparams(); unconnection();
        requests.current.delete(controller);
      }
    });
    session.tail = task.then(() => {}, () => {});
    return task;
  }, [isCurrent]);

  const addGap = useCallback((identity: Pick<Identity, 'params' | 'url'>) => {
    const receivedAt = Date.now();
    setTelemetry(previous => previous.params === identity.params && previous.url === identity.url
      ? { ...previous, speedHistory: appendPoint(previous.speedHistory, { receivedAt, value: null }) }
      : previous);
  }, []);

  useEffect(() => wsClient.onConnectionReset(() => addGap({ params, url })), [params, url, addGap]);

  useEffect(() => {
    if (!enabled || !connected) {
      setTelemetry(previous => previous.params === params && previous.url === url && previous.speedHistory.length > 0
        ? { ...previous, speedHistory: appendPoint(previous.speedHistory, { receivedAt: Date.now(), value: null }) }
        : previous);
    }
  }, [enabled, connected, params, url]);

  // 启动/停止轮询（仅在 enabled=true 时运行）
  useEffect(() => {
    if (!enabled || !connected) return;

    const controller = new AbortController();
    const identity = { params, url, generation };
    const canRead = () => !controller.signal.aborted && isCurrent(identity);
    let busy = false;
    const pollOnce = async () => {
      if (busy || !canRead()) return;
      busy = true;
      try {
        for (const alias of DASHBOARD_ALIASES) {
          if (!canRead()) break;
          const param = params.find(item => item.alias === alias);
          if (!param) continue;
          try {
            const response = await request(identity,
              buildReadHolding(param.regAddr, param.isFloat ? 2 : 1),
              frame => readValue(param, frame) !== null, controller.signal);
            if (!canRead()) break;
            const value = readValue(param, response);
            if (value === null) continue;
            const receivedAt = Date.now();
            setValue(alias, value);
            setTelemetry(previous => {
              const current = previous.params === params && previous.url === url
                ? previous : { params, url, readings: {}, speedHistory: [] };
              return { ...current, readings: { ...current.readings, [alias]: { value, receivedAt } },
                speedHistory: alias === 'MotorSpd'
                  ? appendPoint(current.speedHistory, { receivedAt, value }) : current.speedHistory };
            });
          } catch {
            if (canRead() && alias === 'MotorSpd') addGap(identity);
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
  }, [connected, enabled, params, url, generation, setValue, request, isCurrent, addGap]);

  /** 写入单个寄存器（实际值） */
  const writeParam = useCallback(
    async (alias: string, actual: number): Promise<void> => {
      const connection = useConnectionStore.getState();
      if (!connection.connected) throw new Error('设备未连接');
      const currentParams = useParamStore.getState().params;
      const param = currentParams.find(item => item.alias === alias);
      if (!param) throw new Error('参数表缺少此指令');
      if (param.readOnly) throw new Error('此参数为只读');
      if (param.isFloat) throw new Error('此指令不支持浮点写入');
      if (!Number.isFinite(actual)) throw new Error('请输入有效数值');
      if (!Number.isInteger(param.regAddr) || param.regAddr < 0 || param.regAddr > 0xffff
        || !Number.isInteger(param.decimals) || param.decimals < 0 || param.decimals > 15
        || !Number.isFinite(param.min) || !Number.isFinite(param.max) || param.min > param.max) {
        throw new Error('参数定义无效');
      }
      if (actual < param.min || actual > param.max) throw new Error('设定值超出参数表范围');
      const scaled = actual * Math.pow(10, param.decimals);
      const raw = Math.round(scaled);
      if (Math.abs(scaled - raw) > 1e-7) throw new Error('数值精度与参数表不一致');
      if (!Number.isSafeInteger(raw) || raw < (param.signed ? -32768 : 0) || raw > (param.signed ? 32767 : 65535)) {
        throw new Error('设定值超出寄存器范围');
      }
      const unsigned = raw < 0 ? raw + 0x10000 : raw;
      const frame = buildWriteSingle(param.regAddr, unsigned);
      await request({ params: currentParams, url: connection.url, generation: wsClient.generation }, frame,
        response => response.length === frame.length && response.every((byte, index) => byte === frame[index]));
    },
    [request],
  );

  const visible = telemetry.params === params && telemetry.url === url;
  return { writeParam, readings: visible ? telemetry.readings : {}, speedHistory: visible ? telemetry.speedHistory : [] };
}
