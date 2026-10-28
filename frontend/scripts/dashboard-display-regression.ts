import assert from 'node:assert/strict';
import { dashboardScale, buildDashboardTrend } from '../src/lib/dashboardDisplay';
assert.deepEqual(dashboardScale('0.01A', 0), { factor: .01, decimals: 2, unit: 'A' });
assert.deepEqual(dashboardScale('0.1V', 1), { factor: .1, decimals: 2, unit: 'V' });
assert.deepEqual(dashboardScale('rpm', 0), { factor: 1, decimals: 0, unit: 'rpm' });
assert.equal(dashboardScale('rpm', 101).decimals, 10, 'bad table precision cannot crash formatting');
assert.equal(dashboardScale('rpm', NaN).decimals, 0);
assert.equal(dashboardScale('0.01A', Infinity).decimals, 2);
assert.equal(dashboardScale('rpm', -1).decimals, 0);
assert.equal(.33 / dashboardScale('0.01A').factor, 33);
const trend = buildDashboardTrend([
  { receivedAt: 10_000, value: 100 }, { receivedAt: 12_000, value: 200 },
  { receivedAt: 20_000, value: null }, { receivedAt: 30_000, value: 300 },
  { receivedAt: 31_000, value: 300 },
], 60_000, 1);
assert.equal(trend.segments.length, 2, 'null splits paths');
assert.equal(trend.segments[0][1].x - trend.segments[0][0].x, 20, '2 seconds uses 2/60 of 600px chart');
assert.equal(trend.segments[1][1].x - trend.segments[1][0].x, 10, '1 second has half the x distance');
assert.ok(trend.segments.flat().every(point => point.y > 20 && point.y < 220), 'extrema padded so peaks cannot clip');
assert.equal(buildDashboardTrend([], 60000, 1).segments.length, 0, 'no fake history');
assert.equal(buildDashboardTrend([{ receivedAt: 0, value: 10 }], 61000, 1).segments.length, 0, 'old history excluded');
console.log('dashboard display passed: reversible units, timestamp x-axis, gap segmentation, padded extrema');
