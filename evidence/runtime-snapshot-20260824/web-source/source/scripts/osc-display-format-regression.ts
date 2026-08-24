import assert from 'node:assert/strict';
import {
  formatOscAxisValue,
  formatOscHoverTime,
  formatOscValue,
} from '../src/lib/oscDisplay';

const firstTick = formatOscAxisValue(11.5511, 0.0001);
const nextTick = formatOscAxisValue(11.5512, 0.0001);
assert.notEqual(firstTick, nextTick, 'adjacent sub-millisecond ticks must remain distinguishable');
assert.equal(firstTick, '11.5511');
assert.equal(nextTick, '11.5512');
assert.equal(formatOscAxisValue(11.5, 0.5), '11.5');
assert.equal(formatOscHoverTime(11.5511, 0.0001), '11.551100 s');
assert.equal(formatOscValue(24133), '24,133');
assert.equal(formatOscValue(null), '--');

console.log('osc display formatting regression passed');
