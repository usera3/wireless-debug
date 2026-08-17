import { appendCrc, crc16, verifyCrc } from './crc16';
import {
  decodeOscChannelValue,
  getOscChannelType,
  type OscChannelDescriptor,
} from './oscChannelTypes';

const SLAVE = 0xff;

/** 功能码 0x04 read-input-register 通用构建 */
function buildFC04(regAddr: number): Uint8Array {
  const buf = new Uint8Array([SLAVE, 0x04, (regAddr >> 8) & 0xff, regAddr & 0xff, 0x00, 0x01]);
  return appendCrc(buf);
}

export const buildQueryMaxChannels = () => buildFC04(0x0001);
export const buildQueryFrameLen    = () => buildFC04(0x0000);
export const buildQuerySampleRate  = () => buildFC04(0x0002);

/** 0x75 设置通道：channelNo 从 1 开始，paramType 见协议表 */
export function buildSetChannel(channelNo: number, paramType: number, varAddr: number): Uint8Array {
  const buf = new Uint8Array([
    SLAVE, 0x75, channelNo, paramType,
    (varAddr >> 8) & 0xff, varAddr & 0xff,
  ]);
  return appendCrc(buf);
}

export const buildStartOsc  = () => appendCrc(new Uint8Array([SLAVE, 0x71, 0, 0, 0, 0]));
export const buildStopOsc   = () => appendCrc(new Uint8Array([SLAVE, 0x72, 0, 0, 0, 0]));
export const buildHeartbeat = () => appendCrc(new Uint8Array([SLAVE, 0x08, 0, 0, 0, 0]));

/** 0x73 调整采样通信速率 */
export function buildSetBaudRate(bytesPerSec: number): Uint8Array {
  const buf = new Uint8Array(6);
  buf[0] = SLAVE; buf[1] = 0x73;
  new DataView(buf.buffer).setUint32(2, bytesPerSec);
  return appendCrc(buf);
}

/** 解析 0x04 响应返回 16-bit 值 */
export function parseFC04Response(frame: Uint8Array): number | null {
  if (!verifyCrc(frame) || frame[1] !== 0x04 || frame[2] !== 0x02) return null;
  return (frame[3] << 8) | frame[4];
}

export interface OscFrame {
  channels: number[][];  // channels[i][sampleIndex]
  rawData: Uint8Array;
}

export interface ParseOscDataFrameOptions {
  requireCrc?: boolean;
}

/** 解析示波数据帧，返回各通道按采样点排列的原始值数组
 *
 * 帧结构（frameLen 字节，不含尾部附加 Modbus）：
 *   [FF 77 AA 55 - 4B] [payload] [CRC_lo CRC_hi - 2B] [FF 77 AA 55 - 4B]
 *    head(4)           data(N)    crc(2)                tail(4)
 *
 * frameLen = 4 + N + 2 + 4 = N + 10，故 payload 长度 = frameLen - 10
 * CRC 计算范围：payload 部分
 */
export function parseOscDataFrame(
  data: Uint8Array,
  channels: OscChannelDescriptor[],
  options: ParseOscDataFrameOptions = {},
): OscFrame | null {
  const MAGIC = [0xff, 0x77, 0xaa, 0x55];
  const HEADER_LEN = 4;
  const CRC_LEN = 2;
  const FOOTER_LEN = 4;
  const OVERHEAD = HEADER_LEN + CRC_LEN + FOOTER_LEN; // 10

  if (data.length < OVERHEAD) return null;

  const headerValid = MAGIC.every((byte, index) => data[index] === byte);

  // payload 范围：[4 .. data.length - 6)，CRC 在 [data.length-6 .. data.length-4)
  const payloadStart = HEADER_LEN;
  const crcOffset = data.length - FOOTER_LEN - CRC_LEN; // data.length - 6
  const payload = data.slice(payloadStart, crcOffset);

  // CRC 校验（payload 部分）
  const crcLo = data[crcOffset];
  const crcHi = data[crcOffset + 1];
  const calcCrc = crc16(payload);
  const crcValid = crcLo === (calcCrc & 0xff) && crcHi === ((calcCrc >> 8) & 0xff);
  const footerValid = MAGIC.every(
    (byte, index) => data[data.length - FOOTER_LEN + index] === byte,
  );
  if (!headerValid && !footerValid) return null;
  if (!crcValid && (options.requireCrc || !headerValid || !footerValid)) return null;

  const stridePerSample = channels.reduce(
    (total, channel) => total + getOscChannelType(channel.typeKey).byteWidth,
    0,
  );
  if (stridePerSample === 0) return null;
  const sampleCount = Math.floor(payload.length / stridePerSample);
  const channelData: number[][] = channels.map(() => []);
  const view = new DataView(payload.buffer, payload.byteOffset);

  for (let s = 0; s < sampleCount; s++) {
    let offset = s * stridePerSample;
    channels.forEach((channel, ci) => {
      const definition = getOscChannelType(channel.typeKey);
      channelData[ci].push(decodeOscChannelValue(view, offset, channel));
      offset += definition.byteWidth;
    });
  }
  return { channels: channelData, rawData: payload };
}
