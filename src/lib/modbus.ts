import { appendCrc, verifyCrc } from './crc16';

const SLAVE = 0xff;

/** 功能码 0x03：读保持寄存器 */
export function buildReadHolding(startAddr: number, count: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x03;
  buf[2] = (startAddr >> 8) & 0xff; buf[3] = startAddr & 0xff;
  buf[4] = (count >> 8) & 0xff;     buf[5] = count & 0xff;
  return appendCrc(buf);
}

/** 功能码 0x06：写单个保持寄存器 */
export function buildWriteSingle(addr: number, value: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x06;
  buf[2] = (addr >> 8) & 0xff;  buf[3] = addr & 0xff;
  buf[4] = (value >> 8) & 0xff; buf[5] = value & 0xff;
  return appendCrc(buf);
}

/** 功能码 0x10：写多个保持寄存器 */
export function buildWriteMultiple(startAddr: number, values: number[]): Uint8Array {
  const byteCount = values.length * 2;
  const buf = new Uint8Array(7 + byteCount);
  buf[0] = SLAVE; buf[1] = 0x10;
  buf[2] = (startAddr >> 8) & 0xff; buf[3] = startAddr & 0xff;
  buf[4] = 0; buf[5] = values.length;
  buf[6] = byteCount;
  values.forEach((v, i) => {
    buf[7 + i * 2] = (v >> 8) & 0xff;
    buf[8 + i * 2] = v & 0xff;
  });
  return appendCrc(buf);
}

interface ParseReadResponseOptions {
  allowBadCrc?: boolean;
}

/** 解析 0x03 响应，返回寄存器值数组 */
export function parseReadResponse(
  frame: Uint8Array,
  expectedRegisterCount?: number,
  options: ParseReadResponseOptions = {},
): number[] | null {
  if ((!options.allowBadCrc && !verifyCrc(frame)) || frame[1] !== 0x03 || frame.length < 5) return null;
  const byteCount = frame[2];
  if (byteCount % 2 !== 0) return null;
  if (expectedRegisterCount != null && byteCount !== expectedRegisterCount * 2) return null;
  if (frame.length !== 3 + byteCount + 2) return null;

  const regs: number[] = [];
  for (let i = 0; i < byteCount; i += 2) {
    regs.push((frame[3 + i] << 8) | frame[4 + i]);
  }
  return regs;
}
