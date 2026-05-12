type FrameHandler = (frame: Uint8Array) => void;
type RawHook = (data: Uint8Array) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: FrameHandler[] = [];
  private rawSendHooks: RawHook[] = [];

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

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  private onData(chunk: Uint8Array) {
    // 直接把每个 WS 消息分发给所有 handler，由 frameRouter 自行维护跨消息 buffer
    this.handlers.forEach((h) => h(chunk));
  }
}

export const wsClient = new WsClient();