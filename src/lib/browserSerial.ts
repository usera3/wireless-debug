/** Structural Web Serial types: importing this module never accesses browser globals. */
export interface BrowserSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits: 8; stopBits: 1; parity: 'none'; flowControl: 'none' }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: number | string };
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

export interface BrowserSerialApi extends EventTarget {
  getPorts(): Promise<BrowserSerialPort[]>;
  requestPort(): Promise<BrowserSerialPort>;
}

const MAX_QUEUED_BYTES = 1048576;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
export const serialConnectionCancelled = () => new DOMException('Connection changed', 'AbortError');

export function validateSerialBaud(baud: number): void {
  if (!Number.isInteger(baud) || baud < 1200 || baud > 5000000) {
    throw new Error('Serial baud rate must be an integer from 1200 to 5000000');
  }
}

/** Cleanup failure is not a transient open error: another owner must not be created. */
export class SerialCleanupError extends Error {
  constructor(errors: Error[]) {
    super(`Serial cleanup failed: ${errors.map(error => error.message).join('; ')}`);
    this.name = 'SerialCleanupError';
  }
}

/** One owner for one open attempt, including cleanup of a late successful open. */
export class BrowserSerialConnection {
  private cancelled = false;
  private opened = false;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private reading?: Promise<void>;
  private writing?: Promise<void>;
  private readFailed = false;
  private writeFailed = false;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private state = 0;
  private readonly removed: EventListener = () => this.fail(new Error('Serial device disconnected'));

  constructor(
    private readonly port: BrowserSerialPort,
    private readonly onData: (data: Uint8Array) => void,
    private readonly onFault: (error: Error) => void,
  ) {}

  get readyState() { return this.state; }

  open(baudRate: number): Promise<void> {
    this.opening = this.doOpen(baudRate);
    return this.opening;
  }

  private async doOpen(baudRate: number) {
    if (this.cancelled) throw serialConnectionCancelled();
    validateSerialBaud(baudRate);
    await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.opened = true;
    if (this.cancelled) throw serialConnectionCancelled();
    if (!this.port.readable || !this.port.writable) throw new Error('Serial readable/writable streams are unavailable');
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    // Reads continuously observe errors; the writable can fail even while no write is pending.
    void this.reader.closed.catch(() => {});
    void this.writer.closed.catch(error => {
      if (this.cancelled) return;
      this.writeFailed = true;
      this.fail(asError(error));
    });
    this.port.addEventListener?.('disconnect', this.removed);
    this.state = 1;
    this.reading = this.readLoop();
  }

  private fail(error: Error) {
    if (this.cancelled) return;
    this.onFault(error);
  }

  private async readLoop() {
    try {
      while (!this.cancelled) {
        const { value, done } = await this.reader!.read();
        if (this.cancelled) return;
        if (done) { this.fail(new Error('Serial readable stream ended')); return; }
        this.onData(value);
      }
    } catch (error) {
      this.readFailed = true;
      this.fail(asError(error));
    }
  }

  send(data: Uint8Array) {
    if (this.cancelled || this.state !== 1) throw new Error('Serial connection is not open');
    if (this.queuedBytes + data.byteLength > MAX_QUEUED_BYTES) {
      const error = new Error(`Serial write queue exceeds ${MAX_QUEUED_BYTES} bytes`);
      this.fail(error);
      throw error;
    }
    this.queue.push(data.slice());
    this.queuedBytes += data.byteLength;
    if (!this.writing) this.writing = this.writeLoop();
  }

  private async writeLoop() {
    try {
      while (!this.cancelled && this.queue.length) {
        const bytes = this.queue.shift()!;
        await this.writer!.write(bytes);
        this.queuedBytes -= bytes.byteLength;
      }
    } catch (error) {
      this.writeFailed = true;
      this.fail(asError(error));
    } finally {
      this.writing = undefined;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelled = true;
    this.state = 3;
    this.queue = [];
    this.port.removeEventListener?.('disconnect', this.removed);
    this.closing = this.cleanup();
    return this.closing;
  }

  private async cleanup() {
    // Failed open is reported by open(); only a successful open confers port ownership.
    await this.opening?.catch(() => {});
    const operations: Promise<unknown>[] = [];
    if (this.reader && !this.readFailed) operations.push(this.reader.cancel());
    if (this.writer && !this.writeFailed) operations.push(this.writer.abort());
    if (this.reading) operations.push(this.reading);
    if (this.writing) operations.push(this.writing);
    const errors: Error[] = [];
    const settled = await Promise.allSettled(operations);
    settled.forEach(result => { if (result.status === 'rejected') errors.push(asError(result.reason)); });
    try { this.reader?.releaseLock(); } catch (error) { errors.push(asError(error)); }
    try { this.writer?.releaseLock(); } catch (error) { errors.push(asError(error)); }
    if (this.opened) {
      try { await this.port.close(); } catch (error) { errors.push(asError(error)); }
    }
    if (errors.length) throw new SerialCleanupError(errors);
  }
}
