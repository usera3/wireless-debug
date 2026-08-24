import { strict as assert } from 'node:assert';
import { OscLiveFeed } from '../src/lib/oscLiveFeed';

function batch(ch1: number[], ch2: number[]): Map<number, number[]> {
  return new Map([
    [1, ch1],
    [2, ch2],
  ]);
}

const feed = new OscLiveFeed();
feed.reset({
  channelNos: [1, 2],
  sampleRate: 1000,
  maxBufferedSamples: 4,
});

feed.push(batch([10, 11], [20, 21]), 1_000);
feed.push(batch([12, 13], [22, 23]), 1_002);
feed.push(batch([14, 15], [24, 25]), 1_004);

assert.equal(feed.bufferedFrames, 2, 'oldest frame should be dropped when the live queue is full');
assert.equal(feed.bufferedSamples, 4);
assert.equal(feed.droppedSamples, 2);

const first = feed.drainFrame();
assert.ok(first, 'first frame should drain');
assert.deepEqual(first?.timestamps, [1_001, 1_002]);
assert.deepEqual(first?.batch.get(1), [12, 13]);
assert.deepEqual(first?.batch.get(2), [22, 23]);

const second = feed.drainFrame();
assert.ok(second, 'second frame should drain');
assert.deepEqual(second?.timestamps, [1_003, 1_004]);
assert.deepEqual(second?.batch.get(1), [14, 15]);
assert.deepEqual(second?.batch.get(2), [24, 25]);

assert.equal(feed.drainFrame(), null);

feed.setEnabled(false);
feed.push(batch([30], [40]), 2_000);
assert.equal(feed.bufferedFrames, 0, 'disabled live feed must ignore incoming frames');

feed.setEnabled(true);
feed.push(batch([31], [41]), 2_001);
assert.equal(feed.bufferedFrames, 1, 're-enabled live feed should accept new frames');
assert.deepEqual(feed.drainFrame()?.batch.get(1), [31]);

console.log('osc live feed regression passed');
