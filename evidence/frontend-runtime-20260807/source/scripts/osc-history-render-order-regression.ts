import { strict as assert } from 'node:assert';
import { OscHistory } from '../src/lib/oscHistory';

const history = new OscHistory();
history.reset([1], 1_000, 10);
const values = Array.from({ length: 128 }, (_, index) => index);
values.splice(0, 4, 100, 50, -100, 0);
history.appendBatch(new Map([[1, values]]));

const data = history.buildAlignedData([1], 0, 0.128, 64);
assert.deepEqual(
  data[1].slice(0, 2),
  [100, -100],
  'a bucket must emit max before min when that is their temporal order',
);
console.log('osc history render order regression passed');
