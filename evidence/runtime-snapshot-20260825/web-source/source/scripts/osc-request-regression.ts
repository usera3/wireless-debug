import assert from 'node:assert/strict';
import { waitForOscResponse, waitForOscResponseWithRetry } from '../src/lib/oscRequest';
import { buildSetChannel } from '../src/lib/oscilloscope';

type Handler = (frame: Uint8Array) => void;

class TestFrameSource {
  private handlers = new Set<Handler>();

  subscribe(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(frame: number[]) {
    const data = new Uint8Array(frame);
    this.handlers.forEach((handler) => handler(data));
  }
}

async function main() {
  const source = new TestFrameSource();
  const request = new Uint8Array([0xff, 0x04, 0x00, 0x00, 0x00, 0x01, 0x24, 0x14]);
  const unrelated = [0xff, 0x75, 0x01, 0x00, 0x00, 0x00, 0x98, 0x23];
  const matching = [0xff, 0x04, 0x02, 0x00, 0xfa, 0x10, 0xa7];
  const wrongValue = [0xff, 0x04, 0x02, 0x00, 0x0c, 0x90, 0xe1];
  let sent = false;

  const pending = waitForOscResponse({
    request,
    timeoutMs: 80,
    subscribe: (handler) => source.subscribe(handler),
    send: () => { sent = true; },
  });

  assert.equal(sent, true, 'request should be sent after the waiter is registered');
  setTimeout(() => source.emit(unrelated), 5);
  setTimeout(() => source.emit(matching), 30);

  const response = await pending;
  assert.deepEqual([...response], matching, 'unrelated frames must not satisfy the request');

  const validated = waitForOscResponse({
    request,
    timeoutMs: 80,
    subscribe: (handler) => source.subscribe(handler),
    send: () => {},
    acceptResponse: (frame) => frame[3] === 0x00 && frame[4] >= 0x80,
  });
  setTimeout(() => source.emit(wrongValue), 5);
  setTimeout(() => source.emit(matching), 20);
  assert.deepEqual(
    [...await validated],
    matching,
    'same-function stale responses with implausible values must be ignored',
  );

  const channelRequest = buildSetChannel(1, 0x03, 0x1000);
  const staleChannelAck = buildSetChannel(1, 0x00, 0x0000);
  const channelPending = waitForOscResponse({
    request: channelRequest,
    timeoutMs: 80,
    subscribe: (handler) => source.subscribe(handler),
    send: () => {},
  });
  setTimeout(() => source.emit([...staleChannelAck]), 5);
  setTimeout(() => source.emit([...channelRequest]), 20);
  assert.deepEqual(
    [...await channelPending],
    [...channelRequest],
    'a stale ACK for the same channel but a different type/address must be ignored',
  );

  await assert.rejects(
    waitForOscResponse({
      request,
      timeoutMs: 20,
      subscribe: (handler) => source.subscribe(handler),
      send: () => {},
    }),
    /查询帧长响应超时/,
  );

  let attempts = 0;
  const retried = waitForOscResponseWithRetry({
    request,
    timeoutMs: 15,
    retryDelayMs: 2,
    retries: 1,
    subscribe: (handler) => source.subscribe(handler),
    send: () => {
      attempts += 1;
      if (attempts === 2) setTimeout(() => source.emit(matching), 3);
    },
  });
  assert.deepEqual([...await retried], matching, 'an idempotent handshake request should retry once after timeout');
  assert.equal(attempts, 2, 'the request should be sent exactly twice when the first attempt times out');

  console.log('osc request regression checks passed');
}

await main();
