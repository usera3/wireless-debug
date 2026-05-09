import { useCallback, useRef } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, buildWriteMultiple, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { frameRouter } from '../lib/frameRouter';

const TIMEOUT_MS = 1000;

export function useModbusOps() {
  const setValue = useParamStore((s) => s.setValue);
  // 队列：同一时刻只有一个 pending 请求
  const pendingRef = useRef(false);

  /** 等待 Modbus 响应帧，超时 reject */
  function waitModbus(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frameRouter.onModbusFrame(() => {});
        reject(new Error('modbus timeout'));
      }, TIMEOUT_MS);

      frameRouter.onModbusFrame((frame) => {
        clearTimeout(timer);
        frameRouter.onModbusFrame(() => {});
        resolve(frame);
      });
    });
  }

  /** 读寄存器，返回已换算的实际值 */
  const readRegister = useCallback(
    async (param: ParamDef): Promise<number> => {
      if (pendingRef.current) throw new Error('busy');
      pendingRef.current = true;
      try {
        const count = param.isFloat ? 2 : 1;
        const frame = buildReadHolding(param.regAddr, count);
        const waitP = waitModbus();
        wsClient.send(frame);
        const resp = await waitP;
        const regs = parseReadResponse(resp);
        if (!regs) throw new Error('bad response');

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
        return actual;
      } finally {
        pendingRef.current = false;
      }
    },
    [setValue],
  );

  /** 写寄存器，输入为已换算的实际值 */
  const writeRegister = useCallback(
    async (param: ParamDef, actual: number): Promise<void> => {
      if (pendingRef.current) throw new Error('busy');
      pendingRef.current = true;
      try {
        let frame: Uint8Array;
        if (param.isFloat) {
          const buf = new ArrayBuffer(4);
          new DataView(buf).setFloat32(0, actual, false);
          const view = new DataView(buf);
          frame = buildWriteMultiple(param.regAddr, [view.getUint16(0, false), view.getUint16(2, false)]);
        } else {
          const raw = Math.round(actual * Math.pow(10, param.decimals));
          const unsigned = raw < 0 ? raw + 0x10000 : raw;
          frame = buildWriteSingle(param.regAddr, unsigned & 0xffff);
        }
        const waitP = waitModbus();
        wsClient.send(frame);
        await waitP;
      } finally {
        pendingRef.current = false;
      }
    },
    [],
  );

  return { readRegister, writeRegister };
}
