import { strict as assert } from 'node:assert';
import { oscPlotPointBudget } from '../src/lib/oscRenderBudget';

assert.equal(oscPlotPointBudget(0), 2400);
assert.equal(oscPlotPointBudget(1), 2400);
assert.equal(oscPlotPointBudget(2), 2400);
assert.equal(oscPlotPointBudget(4), 1200);
assert.equal(oscPlotPointBudget(12), 512);

console.log('osc render budget regression passed');
