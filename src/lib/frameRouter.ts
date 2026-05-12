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

function matchMagic(buf: Uint8Array, offset: number): boolean {
  if (offset + MAGIC_LEN > buf.length) return false;
  for (let i = 0; i < MAGIC_LEN; i++) {
    if (buf[offset + i] !== OSC_MAGIC[i]) return false;
  }
  return true;
}

export class FrameRouter {
  private buf = new Uint8Array(0);
  /** 设备上报的帧长（含头4+payload+CRC2+尾4，不含附加 Modbus） */
  private frameLen = 130;

  private oscHandler: OscFrameHandler = () => {};
  private modbusHandler: ModbusFrameHandler = () => {};
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
      // ── 寻找 osc 帧头 ─────────────────────────────────────────────────────
      const headerPos = this.findMagic(0);

      if (headerPos < 0) {
        // buffer 中无任何 osc 帧头，全部作为 Modbus 数据分发
        this.dispatchModbus(this.buf);
        this.buf = new Uint8Array(0);
        return;
      }

      if (headerPos > 0) {
        // 帧头前有垃圾字节，先作为 Modbus 数据分发（可能是上一轮的 Modbus 响应）
        this.dispatchModbus(this.buf.slice(0, headerPos));
        this.buf = this.buf.slice(headerPos);
        continue;
      }

      // ── buf 开头即为 osc 帧头 ─────────────────────────────────────────────
      // 最短需要：frameLen + 1（mbLen 字节）
      const minNeeded = this.frameLen + 1;
      if (this.buf.length < minNeeded) {
        // 数据不够，等待更多数据
        break;
      }

      // 校验尾部 magic（offset = frameLen - 4）
      const tailOffset = this.frameLen - MAGIC_LEN;
      if (!matchMagic(this.buf, tailOffset)) {
        // 尾部 magic 对不上：当前头可能是误码，跳过这1字节重新扫描
        this.buf = this.buf.slice(1);
        continue;
      }

      // 读 mbLen
      const mbLen = this.buf[this.frameLen];

      // 完整帧所需字节 = frameLen + 1(mbLen) + mbLen
      const totalNeeded = this.frameLen + 1 + mbLen;
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
      if (mbLen > 0) {
        const mbData = this.buf.slice(this.frameLen + 1, this.frameLen + 1 + mbLen);
        this.dispatchModbus(mbData);
      }

      // 消费这一帧
      this.buf = this.buf.slice(totalNeeded);
    }
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
   * 将数据按照标准 Modbus RTU 帧分割后依次分发。
   * Modbus RTU 帧：[addr 0xff][fc][...][CRC_lo][CRC_hi]，最短 4 字节。
   * 如果无法确定边界，整块分发（让上层自行处理）。
   */
  private dispatchModbus(data: Uint8Array) {
    if (data.length === 0) return;

    if (verifyCrc(data)) {
      this.modbusHandler(data);
      this.rxLogHooks.forEach((h) => h(data, 'modbus'));
      return;
    }

    let offset = 0;
    while (offset < data.length) {
      let found = false;
      for (let len = 4; len <= Math.min(data.length - offset, 256); len++) {
        const candidate = data.slice(offset, offset + len);
        if (verifyCrc(candidate)) {
          this.modbusHandler(candidate);
          this.rxLogHooks.forEach((h) => h(candidate, 'modbus'));
          offset += len;
          found = true;
          break;
        }
      }
      if (!found) {
        this.modbusHandler(data.slice(offset));
        this.rxLogHooks.forEach((h) => h(data.slice(offset), 'modbus'));
        break;
      }
    }
  }
}

export const frameRouter = new FrameRouter();

// 将 frameRouter 接入 wsClient
wsClient.onFrame((chunk) => frameRouter.feed(chunk));