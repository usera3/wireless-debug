import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  modbusOscCycleAction,
  modbusOscResponseTimeoutMs,
  shouldStopModbusOscOnError,
} from '../src/lib/modbusOscTransportPolicy';

assert.equal(modbusOscResponseTimeoutMs('local'), 1000);
assert.equal(modbusOscResponseTimeoutMs('cloud'), 2800);
assert.equal(shouldStopModbusOscOnError('local'), false);
assert.equal(shouldStopModbusOscOnError('cloud'), true);
assert.equal(modbusOscCycleAction('cloud', false), 'append');
assert.equal(modbusOscCycleAction('cloud', true), 'stop');
assert.equal(modbusOscCycleAction('local', true), 'append');

const controller = readFileSync('src/hooks/useModbusOscController.ts', 'utf8');
assert.match(
  controller,
  /const cycleAction = modbusOscCycleAction\(target\.kind, cycleError !== null\)[\s\S]*if \(cycleAction === 'append'\) \{[\s\S]*pushSamples\(completedSamples\)[\s\S]*recordIoSamples/,
  'failed cloud cycles must not append fabricated samples while local behavior stays unchanged',
);
assert.match(
  controller,
  /if \(cycleAction === 'stop'\)[\s\S]*clearInterval\(modbusOscTimer\)[\s\S]*setRunning\(false\)/,
  'a hard cloud transport failure must stop parameter sampling',
);

console.log('modbus osc cloud transport regression passed');
