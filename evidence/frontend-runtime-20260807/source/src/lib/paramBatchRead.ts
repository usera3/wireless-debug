import type { ParamDef } from '../store/paramStore';

export interface ParamReadBatch {
  startAddr: number;
  count: number;
  params: ParamDef[];
}

const DEFAULT_MAX_REGISTERS = 60;

function registerCount(param: ParamDef): number {
  return param.isFloat ? 2 : 1;
}

export function buildParamReadBatches(
  params: ParamDef[],
  maxRegisters = DEFAULT_MAX_REGISTERS,
): ParamReadBatch[] {
  const sorted = [...params].sort((a, b) => a.regAddr - b.regAddr);
  const batches: ParamReadBatch[] = [];

  for (const param of sorted) {
    const size = registerCount(param);
    const last = batches[batches.length - 1];
    if (!last) {
      batches.push({ startAddr: param.regAddr, count: size, params: [param] });
      continue;
    }

    const lastEnd = last.startAddr + last.count;
    const nextEnd = Math.max(lastEnd, param.regAddr + size);
    const canMerge = param.regAddr <= lastEnd && (nextEnd - last.startAddr) <= maxRegisters;
    if (canMerge) {
      last.count = nextEnd - last.startAddr;
      last.params.push(param);
    } else {
      batches.push({ startAddr: param.regAddr, count: size, params: [param] });
    }
  }

  return batches;
}

export function decodeParamBatchValues(
  batch: ParamReadBatch,
  registers: number[],
): Array<[string, number]> {
  const values: Array<[string, number]> = [];
  for (const param of batch.params) {
    const offset = param.regAddr - batch.startAddr;
    let raw: number;

    if (param.isFloat) {
      if (offset < 0 || offset + 1 >= registers.length) continue;
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      view.setUint16(0, registers[offset], false);
      view.setUint16(2, registers[offset + 1], false);
      raw = view.getFloat32(0, false);
    } else {
      if (offset < 0 || offset >= registers.length) continue;
      raw = registers[offset];
      if (param.signed && raw >= 0x8000) raw -= 0x10000;
    }

    const actual = param.isFloat ? raw : raw / Math.pow(10, param.decimals);
    values.push([param.alias, actual]);
  }
  return values;
}
