import { strict as assert } from 'node:assert';
import { crc16 } from '../src/lib/crc16';
import { FrameRouter } from '../src/lib/frameRouter';
import { buildStopOsc } from '../src/lib/oscilloscope';
import {
  OscStopBarrierSequence,
  waitForOscStopBarrier,
} from '../src/lib/oscStopBarrier';

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

const sequencedRouter = new FrameRouter();
const sequencedFrames: Uint8Array[] = [];
const sequencedStops = new OscStopBarrierSequence();
let stopRequests = 0;
sequencedRouter.setFrameLen(250);
sequencedRouter.onOscFrame((frame) => sequencedFrames.push(frame));

sequencedStops.wait({
  timeoutMs: 100,
  subscribe: (handler) => sequencedRouter.subscribeModbusFrame(handler),
  send: () => { stopRequests += 1; },
});
const currentStop = sequencedStops.wait({
  timeoutMs: 100,
  subscribe: (handler) => sequencedRouter.subscribeModbusFrame(handler),
  send: () => { stopRequests += 1; },
});
assert.equal(stopRequests, 1, 'the current stop must not overlap the startup stop waiter');

sequencedRouter.feed(buildStopOsc());
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stopRequests, 2, 'the current stop is sent only after the stale startup ACK is consumed');

const sequencedTail = makeOscFrame(250);
sequencedRouter.feed(sequencedTail.slice(0, 3));
sequencedRouter.feed(sequencedTail.slice(3));
assert.equal(sequencedFrames.length, 1);
sequencedRouter.feed(buildStopOsc());
assert.equal(await currentStop, 'ack');
assert.equal(sequencedFrames.length, 1, 'the current ACK must follow the final frame');

const timeoutDebtRouter = new FrameRouter();
const timeoutDebtFrames: Uint8Array[] = [];
const timeoutDebtSequence = new OscStopBarrierSequence();
let timeoutDebtRequests = 0;
timeoutDebtRouter.setFrameLen(250);
timeoutDebtRouter.onOscFrame((frame) => timeoutDebtFrames.push(frame));

const timedOutStartupStop = timeoutDebtSequence.wait({
  timeoutMs: 10,
  subscribe: (handler) => timeoutDebtRouter.subscribeModbusFrame(handler),
  send: () => { timeoutDebtRequests += 1; },
});
assert.equal(await timedOutStartupStop, 'timeout');

let timeoutDebtStopResolved = false;
const stopAfterStartupTimeout = timeoutDebtSequence.wait({
  timeoutMs: 100,
  subscribe: (handler) => timeoutDebtRouter.subscribeModbusFrame(handler),
  send: () => { timeoutDebtRequests += 1; },
}).then((result) => {
  timeoutDebtStopResolved = true;
  return result;
});
await Promise.resolve();
await Promise.resolve();
assert.equal(timeoutDebtRequests, 2);

timeoutDebtRouter.feed(buildStopOsc());
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  timeoutDebtStopResolved,
  false,
  'a stale ACK after startup timeout must not release the runtime stop barrier',
);

const timeoutDebtTail = makeOscFrame(250);
timeoutDebtRouter.feed(timeoutDebtTail.slice(0, 3));
timeoutDebtRouter.feed(timeoutDebtTail.slice(3));
assert.equal(timeoutDebtFrames.length, 1);
timeoutDebtRouter.feed(buildStopOsc());
assert.equal(await stopAfterStartupTimeout, 'ack');
assert.equal(timeoutDebtFrames.length, 1, 'the runtime ACK must follow the timeout-path tail');

const targetSwitchRouter = new FrameRouter();
const targetSwitchSequence = new OscStopBarrierSequence();
let connectionGeneration = 1;
let targetSwitchRequests = 0;
const targetAOptions = {
  timeoutMs: 20,
  subscribe: (handler: (frame: Uint8Array) => void) => targetSwitchRouter.subscribeModbusFrame(handler),
  send: () => { targetSwitchRequests += 1; },
  isCurrent: () => connectionGeneration === 1,
};

const activeTargetAStop = targetSwitchSequence.wait(targetAOptions);
const queuedTargetAStop = targetSwitchSequence.wait(targetAOptions);
assert.equal(targetSwitchRequests, 1);

connectionGeneration = 2;
targetSwitchRouter.feed(buildStopOsc());
assert.equal(await activeTargetAStop, 'superseded');
assert.equal(await queuedTargetAStop, 'superseded');
assert.equal(
  targetSwitchRequests,
  1,
  'a deferred target-A stop must not be sent through target B',
);

console.log('osc stop barrier regression passed');
