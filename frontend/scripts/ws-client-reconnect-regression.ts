import { strict as assert } from 'node:assert';
import { frameRouter } from '../src/lib/frameRouter';
import { wsClient } from '../src/lib/wsClient';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  binaryType: BinaryType = 'blob';
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(data: Uint8Array) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    this.sent.push(data);
  }
}

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

const scheduled: ScheduledTask[] = [];
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalRandom = Math.random;

globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
  const task: ScheduledTask = {
    callback: callback as () => void,
    delayMs: Number(delay ?? 0),
    cancelled: false,
  };
  scheduled.push(task);
  return task as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
  (handle as unknown as ScheduledTask).cancelled = true;
}) as typeof clearTimeout;
Math.random = () => 1;

try {
  const client = wsClient;
  let openEvents = 0;
  let closeEvents = 0;
  client.onOpen(() => { openEvents += 1; });
  client.onClose(() => { closeEvents += 1; });

  client.connect('ws://192.168.4.1/ws');
  const first = FakeWebSocket.instances.at(-1)!;
  assert.equal(client.send(new Uint8Array([0x01])), false,
    'send while CONNECTING should fail without throwing');
  assert.equal(first.sent.length, 0);
  first.readyState = FakeWebSocket.OPEN;
  first.onopen?.();
  assert.equal(openEvents, 1);
  assert.equal(client.send(new Uint8Array([0x02])), true);
  assert.equal(first.sent.length, 1);

  // Leave an oscilloscope header fragment in the parser. The next socket must
  // not be allowed to finish a frame that began on this connection.
  frameRouter.setFrameLen(10);
  let oscFrames = 0;
  frameRouter.onOscFrame(() => { oscFrames += 1; });
  const oldPrefix = new Uint8Array([0xff, 0x77]);
  first.onmessage?.({ data: oldPrefix.buffer } as MessageEvent<ArrayBuffer>);

  first.onerror?.();
  assert.equal(closeEvents, 1);
  const firstRetry = scheduled.find((task) => !task.cancelled);
  assert.ok(firstRetry, 'unexpected disconnect should schedule a reconnect');
  assert.ok(firstRetry.delayMs > 0, 'reconnect should not spin immediately');

  firstRetry.callback();
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances.at(-1)!;
  assert.equal(second.url, 'ws://192.168.4.1/ws');
  second.readyState = FakeWebSocket.OPEN;
  second.onopen?.();
  assert.equal(openEvents, 2);
  const newSuffix = new Uint8Array([0xaa, 0x55, 0xff, 0xff, 0xff, 0x77, 0xaa, 0x55]);
  second.onmessage?.({ data: newSuffix.buffer } as MessageEvent<ArrayBuffer>);
  assert.equal(oscFrames, 0,
    'a reconnect must discard an incomplete frame from the previous socket');

  second.onclose?.();
  const secondRetry = scheduled.find((task) => !task.cancelled && task !== firstRetry);
  assert.ok(secondRetry, 'a later link loss should still schedule recovery');
  const socketCountBeforeManualDisconnect = FakeWebSocket.instances.length;
  client.disconnect();
  assert.equal(secondRetry.cancelled, true, 'manual disconnect should cancel recovery');
  secondRetry.callback();
  assert.equal(FakeWebSocket.instances.length, socketCountBeforeManualDisconnect,
    'a cancelled retry must not create another socket');

  // Repeated failures must retain bounded backoff even at maximum positive jitter.
  client.connect('ws://192.168.4.1/ws');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onerror?.();
    const retry = [...scheduled].reverse().find((task) => !task.cancelled);
    assert.ok(retry, `retry ${attempt} should be scheduled`);
    assert.ok(retry.delayMs <= 5000, 'reconnect delay must honor the 5 second cap');
    retry.cancelled = true;
    retry.callback();
  }
  client.disconnect();

  console.log('ws client reconnect regression passed');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Math.random = originalRandom;
}
