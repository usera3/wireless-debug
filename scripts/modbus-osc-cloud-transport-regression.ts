import { strict as assert } from 'node:assert';
import {
  CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES,
  modbusOscCycleAction,
  modbusOscResponseTimeoutMs,
} from '../src/lib/modbusOscTransportPolicy';

assert.equal(CLOUD_MODBUS_OSC_MAX_CONSECUTIVE_FAILURES, 3);
assert.equal(modbusOscResponseTimeoutMs('local'), 1000);
assert.equal(modbusOscResponseTimeoutMs('cloud'), 2800);
assert.equal(modbusOscCycleAction('cloud', false, 0), 'append');
assert.equal(modbusOscCycleAction('cloud', true, 1), 'continue');
assert.equal(modbusOscCycleAction('cloud', true, 2), 'continue');
assert.equal(modbusOscCycleAction('cloud', true, 3), 'stop');
assert.equal(modbusOscCycleAction('local', true, 1), 'append');

console.log('modbus osc cloud transport regression passed');
