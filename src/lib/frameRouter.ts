import { wsClient } from './wsClient';

type OscFrameHandler = (frame: Uint8Array) => void;
type ModbusFrameHandler = (frame: Uint8Array) => void;

const OSC_HEADER = [0xff, 0x77, 0xaa, 0x55];

export class FrameRouter {
  private buf = new Uint8Array(0);
  private frameLen = 130;
  private oscHandler: OscFrameHandler = () => {};
  private modbusHandler: ModbusFrameHandler = () => {};

  setFrameLen(n: number) {
    this.frameLen = n;
  }

  onOscFrame(h: OscFrameHandler) {
    this.oscHandler = h;
  }

  onModbusFrame(h: ModbusFrameHandler) {
    this.modbusHandler = h;
  }

  feed(chunk: Uint8Array) {
    // 追加 chunk 到 buf
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    this.tryConsume();
  }

  private tryConsume() {
    while (this.buf.length > 0) {
      const isOscHeader =
        this.buf.length >= 4 &&
        OSC_HEADER.every((b, i) => this.buf[i] === b);

      if (isOscHeader) {
        // 等待完整示波帧
        if (this.buf.length < this.frameLen) break;

        const oscFrame = this.buf.slice(0, this.frameLen);
        const rest = this.buf.slice(this.frameLen);
        this.buf = rest; // 保留剩余，继续循环

        this.oscHandler(oscFrame);

        // 帧尾附带的 Modbus 响应（直接消费，不再累积）
        if (rest.length > 0 && !OSC_HEADER.every((b, i) => rest[i] === b)) {
          this.modbusHandler(rest);
          this.buf = new Uint8Array(0);
        }
      } else {
        // 不是示波帧头，整段作为 Modbus 响应
        this.modbusHandler(this.buf);
        this.buf = new Uint8Array(0);
        break;
      }
    }
  }
}

export const frameRouter = new FrameRouter();

// 将 frameRouter 接入 wsClient
wsClient.onFrame((chunk) => frameRouter.feed(chunk));
