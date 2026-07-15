import { useCallback, useRef } from 'react';
import { wsClient } from '../lib/wsClient';
import { buildReadHolding, buildWriteSingle, buildWriteMultiple, parseReadResponse } from '../lib/modbus';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { buildParamReadBatches, decodeParamBatchValues } from '../lib/paramBatchRead';
import { waitForMatchingModbusFrame } from '../lib/modbusRequest';

const PARAM_MODBUS_TIMEOUT_MS = 3500;

export function useModbusOps() {
  const setValue = useParamStore((s) => s.setValue);
  // 队列：同一时刻只有一个 pending 请求
  const pendingRef = useRef(false);

  function waitReadResponse(expectedRegisterCount: number): Promise<Uint8Array> {
    return waitForMatchingModbusFrame({
      timeoutMs: PARAM_MODBUS_TIMEOUT_MS,
      matches: (frame) => parseReadResponse(frame, expectedRegisterCount, { allowBadCrc: true }) != null,
    });
  }

  function waitWriteResponse(functionCode: 0x06 | 0x10): Promise<Uint8Array> {
    return waitForMatchingModbusFrame({
      timeoutMs: PARAM_MODBUS_TIMEOUT_MS,
      matches: (frame) => frame.length === 8 && frame[0] === 0xff && frame[1] === functionCode,
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
        const waitP = waitReadResponse(count);
        wsClient.send(frame);
        const resp = await waitP;
        const regs = parseReadResponse(resp, count, { allowBadCrc: true });
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

  /** 批量读寄存器，连续地址会合并成一次 Modbus 读取 */
  const readRegisters = useCallback(
    async (params: ParamDef[]): Promise<number> => {
      if (pendingRef.current) throw new Error('busy');
      pendingRef.current = true;
      try {
        let updated = 0;
        for (const batch of buildParamReadBatches(params)) {
          const frame = buildReadHolding(batch.startAddr, batch.count);
          const waitP = waitReadResponse(batch.count);
          wsClient.send(frame);
          const resp = await waitP;
          const regs = parseReadResponse(resp, batch.count, { allowBadCrc: true });
          if (!regs) throw new Error('bad response');

          for (const [alias, actual] of decodeParamBatchValues(batch, regs)) {
            setValue(alias, actual);
            updated += 1;
          }
        }
        return updated;
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
        let functionCode: 0x06 | 0x10;
        if (param.isFloat) {
          const buf = new ArrayBuffer(4);
          new DataView(buf).setFloat32(0, actual, false);
          const view = new DataView(buf);
          frame = buildWriteMultiple(param.regAddr, [view.getUint16(0, false), view.getUint16(2, false)]);
          functionCode = 0x10;
        } else {
          const raw = Math.round(actual * Math.pow(10, param.decimals));
          const unsigned = raw < 0 ? raw + 0x10000 : raw;
          frame = buildWriteSingle(param.regAddr, unsigned & 0xffff);
          functionCode = 0x06;
        }
        const waitP = waitWriteResponse(functionCode);
        wsClient.send(frame);
        await waitP;
      } finally {
        pendingRef.current = false;
      }
    },
    [],
  );

  return { readRegister, readRegisters, writeRegister };
}
