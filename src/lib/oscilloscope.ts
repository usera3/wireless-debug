import { appendCrc, crc16, verifyCrc } from './crc16';

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

/** 解析示波数据帧，返回各通道按采样点排列的原始值数组 */
export interface OscFrame {
  channels: number[][];  // channels[i][sampleIndex]
  rawData: Uint8Array;
}

export function parseOscDataFrame(
  data: Uint8Array,
  channelWidths: number[], // 每通道占字节数：2/4/8
): OscFrame | null {
  if (data.length < 10) return null;
  // 验证帧头帧尾
  const hdr = [0xff, 0x77, 0xaa, 0x55];
  for (let i = 0; i < 4; i++) {
    if (data[i] !== hdr[i] || data[data.length - 4 + i] !== hdr[i]) return null;
  }
  const dataSection = data.slice(4, data.length - 6); // 去掉头尾和CRC
  const crcBytes = data.slice(data.length - 6, data.length - 4);
  const calcCrc = crc16(dataSection);
  if (crcBytes[0] !== (calcCrc & 0xff) || crcBytes[1] !== ((calcCrc >> 8) & 0xff)) return null;

  const stridePerSample = channelWidths.reduce((a, b) => a + b, 0);
  const sampleCount = Math.floor(dataSection.length / stridePerSample);
  const channels: number[][] = channelWidths.map(() => []);
  const view = new DataView(dataSection.buffer, dataSection.byteOffset);

  for (let s = 0; s < sampleCount; s++) {
    let offset = s * stridePerSample;
    channelWidths.forEach((w, ci) => {
      const val =
        w === 2 ? view.getInt16(offset, false)
        : w === 4 ? view.getFloat32(offset, false)
        : view.getFloat64(offset, false);
      channels[ci].push(val);
      offset += w;
    });
  }
  return { channels, rawData: dataSection };
}
