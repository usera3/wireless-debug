type FrameHandler = (frame: Uint8Array) => void;
type RawHook = (data: Uint8Array) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: FrameHandler[] = [];
  private buffer = new Uint8Array(0);
  private rawSendHooks: RawHook[] = [];
  private rawRecvHooks: RawHook[] = [];

  connect(url: string) {
    if (this.ws) this.disconnect();
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => this.onData(new Uint8Array(e.data as ArrayBuffer));
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }

  send(data: Uint8Array) {
    this.rawSendHooks.forEach((h) => h(data));
    this.ws?.send(data);
  }

  onFrame(handler: FrameHandler) {
    this.handlers.push(handler);
  }

  removeHandler(handler: FrameHandler) {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** 注册原始发送钩子（调试用） */
  onRawSend(hook: RawHook) { this.rawSendHooks.push(hook); }
  /** 注册原始接收钩子（调试用） */
  onRawReceive(hook: RawHook) { this.rawRecvHooks.push(hook); }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  private onData(chunk: Uint8Array) {
    this.rawRecvHooks.forEach((h) => h(chunk));
    // 追加到 buffer，分发给所有 handler（具体分帧由上层负责）
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this.handlers.forEach((h) => h(this.buffer));
    this.buffer = new Uint8Array(0); // 交由 handler 决定消费
  }
}

export const wsClient = new WsClient();