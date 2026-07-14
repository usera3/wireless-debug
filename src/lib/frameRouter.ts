import { wsClient } from './wsClient';
import { verifyCrc } from './crc16';

type OscFrameHandler = (oscFrame: Uint8Array) => void;
type ModbusFrameHandler = (frame: Uint8Array) => void;
type RxLogHook = (frame: Uint8Array, type: 'osc' | 'modbus') => void;

/**
 * 示波帧结构（frameLen 由设备配置，不含尾部附加 Modbus）：
 *
 *   [FF 77 AA 55]  [osc payload: frameLen-10 bytes]  [CRC_lo CRC_hi]  [FF 77 AA 55]  [mbLen: 1 byte]  [modbus: mbLen bytes]
 *    4 bytes            payload_len                     2 bytes           4 bytes         1 byte           mbLen bytes
 *
 * 完整示波帧占字节数：frameLen + 1 + mbLen
 *   （frameLen 已包含头4+payload+CRC2+尾4，即头尾共10字节 + payload）
 *
 * CRC 计算范围：[osc payload] 部分（不含头尾）
 */

const OSC_MAGIC = new Uint8Array([0xff, 0x77, 0xaa, 0x55]);
const MAGIC_LEN = 4;
const FIXED_MODBUS_RESPONSE_LEN: Record<number, number> = {
  0x06: 8,
  0x10: 8,
  0x65: 5,
  0x66: 13,
  0x67: 7,
  0x68: 5,
  0x69: 5,
  0x6a: 5,
  0x70: 5,
  0x71: 8,
  0x72: 8,
  0x73: 8,
  0x75: 8,
  0x08: 8,
};

function matchMagic(buf: Uint8Array, offset: number): boolean {
  if (offset + MAGIC_LEN > buf.length) return false;
  for (let i = 0; i < MAGIC_LEN; i++) {
    if (buf[offset + i] !== OSC_MAGIC[i]) return false;
  }
  return true;
}

function expectedModbusFrameLength(buf: Uint8Array, offset: number): number | null {
  const remaining = buf.length - offset;
  if (remaining < 2) return null;

  const fc = buf[offset + 1];
  if ((fc & 0x80) !== 0) return 5;

  if (fc === 0x03 || fc === 0x04) {
    if (remaining < 3) return null;
    return 3 + buf[offset + 2] + 2;
  }

  return FIXED_MODBUS_RESPONSE_LEN[fc] ?? null;
}

function isLengthFramedReadResponse(buf: Uint8Array, offset: number, expectedLength: number): boolean {
  const fc = buf[offset + 1];
  if (fc !== 0x03 && fc !== 0x04) return false;
  if (buf.length - offset < expectedLength || expectedLength < 5) return false;
  return 3 + buf[offset + 2] + 2 === expectedLength;
}

export class FrameRouter {
  private buf = new Uint8Array(0);
  /** 设备上报的帧长（含头4+payload+CRC2+尾4，不含附加 Modbus） */
  private frameLen = 130;

  private oscHandler: OscFrameHandler = () => {};
  private modbusHandler: ModbusFrameHandler = () => {};
  private modbusSubscribers = new Set<ModbusFrameHandler>();
  private rxLogHooks: RxLogHook[] = [];

  setFrameLen(n: number) {
    this.frameLen = n;
  }

  onOscFrame(h: OscFrameHandler) {
    this.oscHandler = h;
  }

  onModbusFrame(h: ModbusFrameHandler) {
    this.modbusHandler = h;
  }

  subscribeModbusFrame(h: ModbusFrameHandler) {
    this.modbusSubscribers.add(h);
    return () => this.modbusSubscribers.delete(h);
  }

  /** 注册 RX 解析后日志钩子（调试用），每个完整识别帧触发一次 */
  onRxLog(hook: RxLogHook) {
    this.rxLogHooks.push(hook);
  }

  /** 喂入新数据，追加到内部 buffer 后触发解析 */
  feed(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    this.tryConsume();
  }

  /** 清空内部 buffer（连接断开时调用） */
  reset() {
    this.buf = new Uint8Array(0);
  }

  private tryConsume() {
    while (this.buf.length > 0) {
      const modbusAtStart = this.consumeModbusAtStart();
      if (modbusAtStart === 'consumed') {
        continue;
      }
      if (modbusAtStart === 'wait') {
        break;
      }

      // ── 寻找 osc 帧头 ─────────────────────────────────────────────────────
      const headerPos = this.findMagic(0);

      if (headerPos < 0) {
        // buffer 中无任何 osc 帧头，按 Modbus 帧长消费完整帧；不完整尾包继续等待。
        const consumed = this.dispatchModbus(this.buf);
        this.buf = this.buf.slice(consumed);
        if (this.buf.length > 512) {
          this.buf = this.buf.slice(-3);
        }
        return;
      }

      if (headerPos > 0) {
        // 帧头前有 Modbus 数据或垃圾字节，先尽量分发完整 Modbus 帧。
        this.dispatchModbus(this.buf.slice(0, headerPos));
        this.buf = this.buf.slice(headerPos);
        continue;
      }

      // ── buf 开头即为 osc 帧头 ─────────────────────────────────────────────
      // 最少需要 frameLen 字节才能读到完整的 osc 帧（含尾部 magic）
      if (this.buf.length < this.frameLen) {
        // 云端停止采样时，上一轮示波尾包可能只留下 footer magic，随后紧跟
        // 下一轮 Modbus 响应。若后方已有 CRC 完整的 Modbus 帧，丢弃残留尾包恢复同步。
        const recoveryOffset = this.findCompleteModbusOffset(MAGIC_LEN);
        if (recoveryOffset >= 0) {
          this.buf = this.buf.slice(recoveryOffset);
          continue;
        }
        // 数据不够且尚无可恢复的控制响应，等待更多数据。
        break;
      }

      // 校验尾部 magic（offset = frameLen - 4）
      const tailOffset = this.frameLen - MAGIC_LEN;
      if (!matchMagic(this.buf, tailOffset)) {
        // 尾部 magic 对不上：当前头可能是误码，跳过这1字节重新扫描
        this.buf = this.buf.slice(1);
        continue;
      }

      // mbLen 可选：紧跟帧尾之后若存在且首字节不是 0xFF（新帧头），则视为 mbLen 字节
      // 若下一字节是 0xFF 或 buffer 已无更多字节，则本帧无附加 Modbus 数据
      const hasMbLen =
        this.buf.length > this.frameLen &&
        this.buf[this.frameLen] !== 0xff;
      const mbLen = hasMbLen ? this.buf[this.frameLen] : 0;

      // 完整帧所需字节 = frameLen + (hasMbLen ? 1 + mbLen : 0)
      const totalNeeded = this.frameLen + (hasMbLen ? 1 + mbLen : 0);
      if (this.buf.length < totalNeeded) {
        // 附加 Modbus 数据还没到齐，等待
        break;
      }

      // ── 提取各部分 ────────────────────────────────────────────────────────
      const oscFrame = this.buf.slice(0, this.frameLen);

      // CRC 校验：payload = oscFrame[4 .. frameLen-6)，CRC = oscFrame[frameLen-6 .. frameLen-4)
      // 帧结构: head(4) + payload(frameLen-10) + CRC(2) + footer(4) = frameLen
      const crcOffset = this.frameLen - MAGIC_LEN - 2; // frameLen - 6
      const crcValid = verifyCrc(oscFrame.slice(MAGIC_LEN, crcOffset + 2));

      if (!crcValid) {
        // CRC 错误：跳过1字节重新寻找帧头，实现误码恢复
        this.buf = this.buf.slice(1);
        continue;
      }

      // 分发示波帧（含完整头尾 CRC，供 parseOscDataFrame 使用）
      this.oscHandler(oscFrame);
      this.rxLogHooks.forEach((h) => h(oscFrame, 'osc'));

      // 分发附加 Modbus 数据（若有）
      if (hasMbLen && mbLen > 0) {
        const mbData = this.buf.slice(this.frameLen + 1, this.frameLen + 1 + mbLen);
        this.dispatchModbus(mbData);
      }

      // 消费这一帧
      this.buf = this.buf.slice(totalNeeded);
    }
  }

  private consumeModbusAtStart(): 'consumed' | 'wait' | 'none' {
    if (this.buf.length < 2 || this.buf[0] !== 0xff || matchMagic(this.buf, 0)) {
      return 'none';
    }

    const fc = this.buf[1];
    if ((fc === 0x03 || fc === 0x04) && this.buf.length < 3) {
      return 'wait';
    }

    const expectedLength = expectedModbusFrameLength(this.buf, 0);
    if (expectedLength == null || expectedLength > 260) {
      return 'none';
    }
    if (this.buf.length < expectedLength) {
      return 'wait';
    }

    const candidate = this.buf.slice(0, expectedLength);
    if (!verifyCrc(candidate) && !isLengthFramedReadResponse(this.buf, 0, expectedLength)) {
      return 'none';
    }

    this.dispatchModbusFrame(candidate);
    this.buf = this.buf.slice(expectedLength);
    return 'consumed';
  }

  /**
   * 在 buf 中从 startPos 开始寻找 OSC_MAGIC，返回偏移量。
   * 找不到返回 -1。
   * 注意：最后3字节不足以完整匹配，不算。
   */
  private findMagic(startPos: number): number {
    for (let i = startPos; i <= this.buf.length - MAGIC_LEN; i++) {
      if (matchMagic(this.buf, i)) return i;
    }
    // 检查 buffer 末尾是否有 magic 前缀（不要丢弃）
    return -1;
  }

  /**
   * 将数据按照标准 Modbus RTU 响应帧分割后依次分发。
   * 返回已消费字节数；尾部不完整帧会保留在主 buffer 中等待后续 WS 分片。
   */
  private dispatchModbus(data: Uint8Array): number {
    if (data.length === 0) return 0;

    let offset = 0;
    while (offset < data.length) {
      const remaining = data.length - offset;

      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      if (remaining < 3) break;

      const expectedLength = expectedModbusFrameLength(data, offset);

      if (expectedLength != null) {
        if (expectedLength > 260) {
          offset += 1;
          continue;
        }
        if (remaining < expectedLength) break;

        const candidate = data.slice(offset, offset + expectedLength);
        if (verifyCrc(candidate) || isLengthFramedReadResponse(data, offset, expectedLength)) {
          this.dispatchModbusFrame(candidate);
          offset += expectedLength;
          continue;
        }

        offset += 1;
        continue;
      }

      const fallbackLength = this.findCrcFrameLength(data, offset);
      if (fallbackLength == null) {
        offset += 1;
        continue;
      }

      this.dispatchModbusFrame(data.slice(offset, offset + fallbackLength));
      offset += fallbackLength;
    }

    return offset;
  }

  private findCrcFrameLength(data: Uint8Array, offset: number): number | null {
    const maxLen = Math.min(data.length - offset, 256);
    for (let len = 4; len <= maxLen; len++) {
      const candidate = data.slice(offset, offset + len);
      if (verifyCrc(candidate)) return len;
    }
    return null;
  }

  private findCompleteModbusOffset(startOffset: number): number {
    for (let offset = startOffset; offset < this.buf.length; offset++) {
      if (this.buf[offset] !== 0xff) continue;
      const expectedLength = expectedModbusFrameLength(this.buf, offset);
      if (expectedLength == null || expectedLength > 260) continue;
      if (offset + expectedLength > this.buf.length) continue;
      if (verifyCrc(this.buf.slice(offset, offset + expectedLength))) return offset;
    }
    return -1;
  }

  private dispatchModbusFrame(frame: Uint8Array) {
    this.modbusHandler(frame);
    this.modbusSubscribers.forEach((handler) => handler(frame));
    this.rxLogHooks.forEach((h) => h(frame, 'modbus'));
  }
}

export const frameRouter = new FrameRouter();

// 将 frameRouter 接入 wsClient
wsClient.onFrame((chunk) => frameRouter.feed(chunk));
