import { wsClient } from './wsClient';
import { verifyCrc } from './crc16';

type OscFrameHandler = (oscFrame: Uint8Array) => void;
type ModbusFrameHandler = (frame: Uint8Array) => void;
type RxLogHook = (frame: Uint8Array, type: 'osc' | 'modbus') => void;
type OscFrameResolution = {
  frameLen: number;
  consumedLen: number;
  frame: Uint8Array;
  embeddedModbus: Uint8Array[];
};
type EmbeddedModbusCandidate = { offset: number; length: number; frame: Uint8Array };

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
const OSC_FOOTER_ANCHORED_PREFIX = new Uint8Array([0x5f, 0x05, 0x01, 0xf4]);
const MAGIC_LEN = 4;
const OSC_MIN_FRAME_LEN = MAGIC_LEN + 2 + MAGIC_LEN;
const OSC_MAX_AUTODETECT_FRAME_LEN = 2048;
const MAX_INTERLEAVED_MODBUS_FRAMES = 4;
const MAX_INTERLEAVED_MODBUS_BYTES = 64;
const MAX_INTERLEAVED_CANDIDATES = 12;
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

function matchesPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length === 0 || data.length > prefix.length) return false;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

function trailingMagicPrefixLength(data: Uint8Array): number {
  for (let length = Math.min(MAGIC_LEN - 1, data.length); length > 0; length--) {
    const start = data.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (data[start + index] !== OSC_MAGIC[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
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

function isValidOscFrame(data: Uint8Array, frameLen: number): boolean {
  if (frameLen < OSC_MIN_FRAME_LEN || data.length < frameLen) return false;
  const headerValid = matchMagic(data, 0);
  const footerValid = matchMagic(data, frameLen - MAGIC_LEN);
  if (!headerValid && !footerValid) return false;
  const crcOffset = frameLen - MAGIC_LEN - 2;
  return verifyCrc(data.slice(MAGIC_LEN, crcOffset + 2));
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

      // Footer-anchored osc blocks do not start with 0xFF. Preserve a partial
      // block until frameLen bytes are available instead of discarding it as
      // non-Modbus data. A complete Modbus response still takes precedence.
      if (this.buf[0] !== 0xff && this.buf.length < this.frameLen) {
        if (this.buf[0] === OSC_FOOTER_ANCHORED_PREFIX[0]) {
          break;
        }
        const prefixLength = Math.min(this.buf.length, OSC_FOOTER_ANCHORED_PREFIX.length);
        if (matchesPrefix(this.buf.slice(0, prefixLength), OSC_FOOTER_ANCHORED_PREFIX)) {
          break;
        }
        const recoveryOffset = this.findCompleteModbusOffset(0);
        if (recoveryOffset >= 0) {
          this.buf = this.buf.slice(recoveryOffset);
          continue;
        }
        break;
      }

      // ── 寻找 osc 帧头 ─────────────────────────────────────────────────────
      const startsWithOscAnchor = this.startsWithOscAnchor();
      const resolvedAtStart = startsWithOscAnchor ? this.resolveOscFrame() : null;
      if (resolvedAtStart === 'wait') {
        break;
      }
      const completeOscOffset = resolvedAtStart != null ? 0 : this.findCompleteOscOffset(1);
      const headerPos = completeOscOffset >= 0 ? completeOscOffset : this.findMagic(0);

      if (headerPos < 0) {
        // buffer 中无任何 osc 帧头，按 Modbus 帧长消费完整帧；不完整尾包继续等待。
        const preservedBytes = trailingMagicPrefixLength(this.buf);
        const dispatchEnd = this.buf.length - preservedBytes;
        const consumed = this.dispatchModbus(this.buf.slice(0, dispatchEnd));
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
        // 云端停止采样时，上一轮可能只留下 footer magic + mbLen + Modbus。
        // 只识别紧邻 magic 的长度帧，不能扫描未收全的示波 payload。
        if (this.consumeLengthPrefixedModbusAfterMagic()) {
          continue;
        }
        // 数据不够且尚无可恢复的控制响应，等待更多数据。
        break;
      }

      const oscFrame = resolvedAtStart ?? this.resolveOscFrame();
      if (oscFrame === 'wait') {
        break;
      }
      if (oscFrame == null) {
        const recoveryOffset = this.findCompleteModbusOffset(MAGIC_LEN);
        if (recoveryOffset >= 0) {
          this.buf = this.buf.slice(recoveryOffset);
          continue;
        }

        if (this.buf.length < this.maxAutoDetectFrameLen()) {
          break;
        }

        // 既不是当前配置长度，也找不到后续 magic 能确认的真实长度：
        // 当前头可能是误码，跳过1字节重新扫描。
        this.buf = this.buf.slice(1);
        continue;
      }

      if (oscFrame.frameLen !== this.frameLen) {
        this.frameLen = oscFrame.frameLen;
      }

      // mbLen 可选，且其 payload 必须从 Modbus 从站地址 0xFF 开始。
      // Footer-anchored osc blocks 以 0x5F... 开始，不能把 0x5F 误当作长度 95。
      const nextOffset = oscFrame.consumedLen;
      const nextByte = this.buf[nextOffset];
      const hasMbLen =
        this.buf.length > nextOffset &&
        nextByte !== 0xff &&
        (nextByte === 0 || (this.buf.length > nextOffset + 1 && this.buf[nextOffset + 1] === 0xff));
      const mbLen = hasMbLen ? nextByte : 0;

      // 完整帧所需字节 = frameLen + (hasMbLen ? 1 + mbLen : 0)
      const totalNeeded = oscFrame.consumedLen + (hasMbLen ? 1 + mbLen : 0);
      if (this.buf.length < totalNeeded) {
        // 附加 Modbus 数据还没到齐，等待
        break;
      }

      // ── 提取各部分 ────────────────────────────────────────────────────────
      const oscPayloadFrame = oscFrame.frame;

      oscFrame.embeddedModbus.forEach((frame) => this.dispatchModbusFrame(frame));

      // 分发示波帧（含完整头尾 CRC，供 parseOscDataFrame 使用）
      this.oscHandler(oscPayloadFrame);
      this.rxLogHooks.forEach((h) => h(oscPayloadFrame, 'osc'));

      // 分发附加 Modbus 数据（若有）
      if (hasMbLen && mbLen > 0) {
        const mbData = this.buf.slice(oscFrame.consumedLen + 1, oscFrame.consumedLen + 1 + mbLen);
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

  private consumeLengthPrefixedModbusAfterMagic(): boolean {
    const lengthOffset = MAGIC_LEN;
    const payloadOffset = lengthOffset + 1;
    if (!matchMagic(this.buf, 0) || this.buf.length <= payloadOffset) return false;

    const mbLen = this.buf[lengthOffset];
    if (mbLen <= 0 || this.buf[payloadOffset] !== 0xff) return false;
    if (this.buf.length < payloadOffset + mbLen) return false;

    const candidate = this.buf.slice(payloadOffset, payloadOffset + mbLen);
    const expectedLength = expectedModbusFrameLength(candidate, 0);
    if (expectedLength !== mbLen) return false;
    if (!verifyCrc(candidate) && !isLengthFramedReadResponse(candidate, 0, expectedLength)) {
      return false;
    }

    this.dispatchModbusFrame(candidate);
    this.buf = this.buf.slice(payloadOffset + mbLen);
    return true;
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

  private findCompleteOscOffset(startOffset: number): number {
    for (let offset = startOffset; offset <= this.buf.length - OSC_MIN_FRAME_LEN; offset++) {
      const footerPrefix = this.buf.slice(offset, offset + OSC_FOOTER_ANCHORED_PREFIX.length);
      if (!matchMagic(this.buf, offset) && !matchesPrefix(footerPrefix, OSC_FOOTER_ANCHORED_PREFIX)) {
        continue;
      }
      if (isValidOscFrame(this.buf.slice(offset), this.frameLen)) return offset;
    }
    return -1;
  }

  private startsWithOscAnchor(): boolean {
    return this.buf.length > 0 &&
      (this.buf[0] === OSC_MAGIC[0] || this.buf[0] === OSC_FOOTER_ANCHORED_PREFIX[0]);
  }

  private resolveOscFrame(): OscFrameResolution | 'wait' | null {
    if (this.isValidOscFrameLen(this.frameLen)) {
      return {
        frameLen: this.frameLen,
        consumedLen: this.frameLen,
        frame: this.buf.slice(0, this.frameLen),
        embeddedModbus: [],
      };
    }

    const interleaved = this.resolveInterleavedOscFrame(this.frameLen);
    if (interleaved.resolution != null) {
      return interleaved.resolution;
    }
    if (interleaved.wait) {
      return 'wait';
    }

    const scanLimit = Math.min(this.buf.length, this.maxAutoDetectFrameLen());
    const configuredTailOffset = Math.max(OSC_MIN_FRAME_LEN - MAGIC_LEN, this.frameLen - MAGIC_LEN);
    for (let tailOffset = configuredTailOffset + 1; tailOffset <= scanLimit - MAGIC_LEN; tailOffset += 1) {
      if (!matchMagic(this.buf, tailOffset)) continue;
      const candidateLen = tailOffset + MAGIC_LEN;
      if (this.isValidOscFrameLen(candidateLen)) {
        return {
          frameLen: candidateLen,
          consumedLen: candidateLen,
          frame: this.buf.slice(0, candidateLen),
          embeddedModbus: [],
        };
      }
    }

    return null;
  }

  private isValidOscFrameLen(frameLen: number): boolean {
    return isValidOscFrame(this.buf, frameLen);
  }

  private resolveInterleavedOscFrame(
    frameLen: number,
  ): { resolution: OscFrameResolution | null; wait: boolean } {
    if (!this.startsWithOscAnchor()) return { resolution: null, wait: false };

    const scanLimit = Math.min(this.buf.length, frameLen + MAX_INTERLEAVED_MODBUS_BYTES);
    const candidates: EmbeddedModbusCandidate[] = [];
    for (let offset = 1; offset < scanLimit && candidates.length < MAX_INTERLEAVED_CANDIDATES; offset++) {
      if (this.buf[offset] !== 0xff) continue;
      const expectedLength = expectedModbusFrameLength(this.buf, offset);
      if (expectedLength == null || expectedLength > MAX_INTERLEAVED_MODBUS_BYTES) continue;
      if (offset + expectedLength > this.buf.length) continue;
      const frame = this.buf.slice(offset, offset + expectedLength);
      if (verifyCrc(frame)) {
        candidates.push({ offset, length: expectedLength, frame });
      }
    }

    let resolution: OscFrameResolution | null = null;
    let wait = false;
    const search = (
      startIndex: number,
      selected: EmbeddedModbusCandidate[],
      removedBytes: number,
    ) => {
      if (resolution != null) return;
      if (selected.length > 0) {
        const consumedLen = frameLen + removedBytes;
        if (consumedLen > this.buf.length) {
          wait = true;
        } else {
          const reconstructed = this.reconstructOscFrame(frameLen, consumedLen, selected);
          if (reconstructed != null && isValidOscFrame(reconstructed, frameLen)) {
            resolution = {
              frameLen,
              consumedLen,
              frame: reconstructed,
              embeddedModbus: selected.map((candidate) => candidate.frame),
            };
            return;
          }
        }
      }

      if (selected.length >= MAX_INTERLEAVED_MODBUS_FRAMES) return;
      const previousEnd = selected.length === 0
        ? 0
        : selected[selected.length - 1].offset + selected[selected.length - 1].length;
      for (let index = startIndex; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (candidate.offset < previousEnd) continue;
        const nextRemovedBytes = removedBytes + candidate.length;
        if (nextRemovedBytes > MAX_INTERLEAVED_MODBUS_BYTES) continue;
        if (candidate.offset + candidate.length > frameLen + nextRemovedBytes) continue;
        search(index + 1, [...selected, candidate], nextRemovedBytes);
        if (resolution != null) return;
      }
    };

    search(0, [], 0);
    return { resolution, wait };
  }

  private reconstructOscFrame(
    frameLen: number,
    consumedLen: number,
    removed: EmbeddedModbusCandidate[],
  ): Uint8Array | null {
    const frame = new Uint8Array(frameLen);
    let sourceOffset = 0;
    let targetOffset = 0;
    for (const candidate of removed) {
      if (candidate.offset < sourceOffset || candidate.offset + candidate.length > consumedLen) {
        return null;
      }
      const segment = this.buf.slice(sourceOffset, candidate.offset);
      if (targetOffset + segment.length > frameLen) return null;
      frame.set(segment, targetOffset);
      targetOffset += segment.length;
      sourceOffset = candidate.offset + candidate.length;
    }

    const tailLength = frameLen - targetOffset;
    if (sourceOffset + tailLength !== consumedLen) return null;
    frame.set(this.buf.slice(sourceOffset, consumedLen), targetOffset);
    return frame;
  }

  private maxAutoDetectFrameLen(): number {
    return Math.min(
      OSC_MAX_AUTODETECT_FRAME_LEN,
      Math.max(this.frameLen * 2, this.frameLen + 512),
    );
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
