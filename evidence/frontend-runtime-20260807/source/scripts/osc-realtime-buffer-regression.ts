import { strict as assert } from 'node:assert';
import { OscRealtimeBuffer } from '../src/lib/oscRealtimeBuffer';

const buffer = new OscRealtimeBuffer();
buffer.reset(1_000);
buffer.append(1, [10, 20], 1_040);
assert.equal(buffer.shouldFlush(1_040, 50), false);

buffer.append(1, [30, 40], 11_000);
assert.equal(buffer.shouldFlush(11_000, 50), true);

const drained = buffer.drain(11_000);
assert.ok(drained);
assert.equal(drained.elapsedMs, 10_000);
assert.deepEqual(drained.batch.get(1), [10, 20, 30, 40]);
assert.equal(buffer.drain(11_100), null);

console.log('osc realtime buffer regression passed');
