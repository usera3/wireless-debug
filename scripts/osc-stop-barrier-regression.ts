import { strict as assert } from 'node:assert';
import { crc16 } from '../src/lib/crc16';
import { FrameRouter } from '../src/lib/frameRouter';
import { buildStopOsc } from '../src/lib/oscilloscope';
import { waitForOscStopBarrier } from '../src/lib/oscStopBarrier';

function makeOscFrame(frameLen: number): Uint8Array {
  const payload = new Uint8Array(frameLen - 10);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 13) & 0xff;
  const crc = crc16(payload);
  const frame = new Uint8Array(frameLen);
  frame.set([0xff, 0x77, 0xaa, 0x55]);
  frame.set(payload, 4);
  frame[frameLen - 6] = crc & 0xff;
  frame[frameLen - 5] = crc >> 8;
  frame.set([0xff, 0x77, 0xaa, 0x55], frameLen - 4);
  return frame;
}

const router = new FrameRouter();
const oscFrames: Uint8Array[] = [];
let sent = false;
let finalized = false;
let framesAtFinalize = 0;

router.setFrameLen(250);
router.onOscFrame((frame) => oscFrames.push(frame));

const stopping = waitForOscStopBarrier({
  timeoutMs: 100,
  subscribe: (handler) => router.subscribeModbusFrame(handler),
  send: () => { sent = true; },
}).then((result) => {
  finalized = true;
  framesAtFinalize = oscFrames.length;
  return result;
});

assert.equal(sent, true, 'the stop request must be sent after registering the ACK waiter');
assert.equal(finalized, false);

const finalFrame = makeOscFrame(250);
router.feed(finalFrame.slice(0, 3));
router.feed(finalFrame.slice(3));
await Promise.resolve();
assert.equal(oscFrames.length, 1, 'the final split frame must still be parsed while stop is pending');
assert.equal(finalized, false, 'a waveform frame is not a stop barrier');

router.feed(buildStopOsc());
assert.equal(await stopping, 'ack');
assert.equal(finalized, true);
assert.equal(framesAtFinalize, 1, 'cleanup may run only after the final ordered frame');

let timeoutFinalized = false;
const timedOut = waitForOscStopBarrier({
  timeoutMs: 10,
  subscribe: (handler) => router.subscribeModbusFrame(handler),
  send: () => {},
}).then((result) => {
  timeoutFinalized = true;
  return result;
});
assert.equal(await timedOut, 'timeout');
assert.equal(timeoutFinalized, true, 'missing ACK must fall back to bounded cleanup');

console.log('osc stop barrier regression passed');
