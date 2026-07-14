import { strict as assert } from 'node:assert';
import { OscHistory } from '../src/lib/oscHistory';

const history = new OscHistory();
history.reset([1], 1000, 10);
history.appendBatchAt(new Map([[1, Array.from({ length: 100 }, (_, i) => i)]]), 100);
history.appendBatchAt(new Map([[1, Array.from({ length: 100 }, (_, i) => 100 + i)]]), 2100);

const stats = history.getStats();
assert.equal(stats.latestSampleIndex, 2100);
assert.equal(stats.latestSampleIndex / stats.sampleRate, 2.1);

const data = history.buildAlignedData([1], 0, 2.1, 3000);
assert.equal(data[0].at(-1), 2.099);
assert.equal(data[1][50], 50);
assert.equal(data[1][500], null);
assert.equal(data[1][2050], 150);

const exported = history.exportColumns([1]);
assert.equal(exported.startSampleIndex, 0);
assert.equal(exported.columns[0].length, 2100);
assert.equal(exported.columns[0][50], 50);
assert.equal(exported.columns[0][500], null);
assert.equal(exported.columns[0][2050], 150);

console.log('osc real-time axis regression passed');
