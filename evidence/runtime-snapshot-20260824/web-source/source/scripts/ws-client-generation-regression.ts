import { strict as assert } from 'node:assert';
import { WsClient } from '../src/lib/wsClient';

class FakeWebSocket {
  static readonly CLOSED = 3;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  binaryType: BinaryType = 'blob';
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send() {}
}

globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

const client = new WsClient();
let openEvents = 0;
let closeEvents = 0;
let receivedFrames = 0;
client.onOpen(() => { openEvents += 1; });
client.onClose(() => { closeEvents += 1; });
client.onFrame(() => { receivedFrames += 1; });

const initialGeneration = client.generation;
client.connect('ws://target-a/ws');
const targetAGeneration = client.generation;
const targetASocket = FakeWebSocket.instances.at(-1)!;
assert.ok(targetAGeneration > initialGeneration);

client.connect('ws://target-b/ws');
const targetBGeneration = client.generation;
const targetBSocket = FakeWebSocket.instances.at(-1)!;
assert.ok(targetBGeneration > targetAGeneration);

targetASocket.onopen?.();
targetASocket.onmessage?.({ data: new Uint8Array([1]).buffer } as MessageEvent<ArrayBuffer>);
targetASocket.onclose?.();
targetASocket.onerror?.();
assert.equal(client.generation, targetBGeneration);
assert.equal(openEvents, 0);
assert.equal(closeEvents, 0);
assert.equal(receivedFrames, 0);

targetBSocket.onopen?.();
targetBSocket.onmessage?.({ data: new Uint8Array([1]).buffer } as MessageEvent<ArrayBuffer>);
assert.equal(openEvents, 1);
assert.equal(receivedFrames, 1);

targetBSocket.onerror?.();
const closedTargetBGeneration = client.generation;
targetBSocket.onclose?.();
assert.ok(closedTargetBGeneration > targetBGeneration);
assert.equal(client.generation, closedTargetBGeneration);
assert.equal(closeEvents, 1);

client.connect('ws://target-c/ws');
const targetCGeneration = client.generation;
client.disconnect();
assert.ok(client.generation > targetCGeneration);

console.log('ws client generation regression passed');
