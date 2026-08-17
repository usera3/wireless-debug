import { strict as assert } from 'node:assert';
import { OscJitterBuffer } from '../src/lib/oscJitterBuffer';

function samples(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

function batch(start: number, count: number): Map<number, number[]> {
  return new Map([
    [1, samples(start, count)],
    [2, samples(10_000 + start, count)],
  ]);
}

function appendDrain(target: number[], drain: ReturnType<OscJitterBuffer['drainDue']>) {
  assert.ok(drain, 'each pacing tick must produce a batch while the jitter reserve covers the receive gap');
  target.push(...(drain.batch.get(1) ?? []));
}

const buffer = new OscJitterBuffer();
buffer.reset({
  channelNos: [1, 2],
  sampleRate: 1000,
  targetLatencyMs: 300,
  resumeLatencyMs: 100,
  tickMs: 50,
  nowMs: 0,
});

const played: number[] = [];
buffer.appendBatch(batch(0, 400));
for (const nowMs of [0, 50, 100, 150, 200]) {
  appendDrain(played, buffer.drainDue(nowMs));
}

buffer.appendBatch(batch(400, 200));
for (const nowMs of [250, 300, 350, 400]) {
  appendDrain(played, buffer.drainDue(nowMs));
}

const tail = buffer.drainAll();
assert.ok(tail);
assert.deepEqual([...played, ...(tail.batch.get(1) ?? [])], samples(0, 600));
assert.deepEqual(tail.batch.get(2)?.at(-1), 10_599);
assert.equal(buffer.bufferedSamples, 0);

const resumeBuffer = new OscJitterBuffer();
resumeBuffer.reset({
  channelNos: [1, 2],
  sampleRate: 1000,
  targetLatencyMs: 300,
  resumeLatencyMs: 100,
  tickMs: 50,
  nowMs: 0,
});
resumeBuffer.appendBatch(batch(0, 300));

let resumeAt = 0;
for (let tick = 0; tick < 20 && resumeBuffer.bufferedSamples > 0; tick++) {
  resumeBuffer.drainDue(resumeAt);
  resumeAt += 50;
}
assert.equal(resumeBuffer.bufferedSamples, 0, 'test setup must produce one real underrun');

resumeBuffer.appendBatch(batch(300, 99));
assert.equal(
  resumeBuffer.drainDue(resumeAt),
  null,
  'a true underrun must wait for the 100 ms resume reserve',
);
resumeBuffer.appendBatch(batch(399, 1));
assert.ok(
  resumeBuffer.drainDue(resumeAt + 50),
  'playback must resume at 100 ms instead of rebuilding the full 300 ms initial reserve',
);

console.log('osc jitter buffer regression passed');
