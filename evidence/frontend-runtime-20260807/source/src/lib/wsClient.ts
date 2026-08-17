type FrameHandler = (frame: Uint8Array) => void;
type RawHook = (data: Uint8Array) => void;
type StateHook = () => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private handlers: FrameHandler[] = [];
  private rawSendHooks: RawHook[] = [];
  private openHook: StateHook = () => {};
  private closeHook: StateHook = () => {};

  connect(url: string) {
    if (this.ws) this.disconnect();
    const socket = new WebSocket(url);
    this.ws = socket;
    this.connectionGeneration += 1;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.ws === socket) this.openHook();
    };
    const closeCurrentSocket = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.connectionGeneration += 1;
      this.closeHook();
    };
    socket.onclose = closeCurrentSocket;
    socket.onerror = closeCurrentSocket;
    socket.onmessage = (e) => {
      if (this.ws === socket) this.onData(new Uint8Array(e.data as ArrayBuffer));
    };
  }

  disconnect() {
    const socket = this.ws;
    this.ws = null;
    this.connectionGeneration += 1;
    socket?.close();
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

  get generation(): number {
    return this.connectionGeneration;
  }

  onOpen(hook: StateHook) { this.openHook = hook; }
  onClose(hook: StateHook) { this.closeHook = hook; }

  private onData(chunk: Uint8Array) {
    // 直接把每个 WS 消息分发给所有 handler，由 frameRouter 自行维护跨消息 buffer
    this.handlers.forEach((h) => h(chunk));
  }
}

export const wsClient = new WsClient();
