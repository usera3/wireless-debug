import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
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

const controller = readFileSync('src/hooks/useModbusOscController.ts', 'utf8');
assert.match(controller, /waitForMatchingModbusFrame/);
assert.match(controller, /let modbusOscAbortController: AbortController \| null = null/);
assert.match(controller, /let modbusOscConsecutiveFailures = 0/);
assert.match(controller, /cycleError \? modbusOscConsecutiveFailures \+ 1 : 0/);
assert.match(controller, /modbusOscCycleAction\([\s\S]*modbusOscConsecutiveFailures/);
assert.match(controller, /if \(cycleAction === 'append'\)[\s\S]*pushSamples/);
assert.match(controller, /modbusOscAbortController\?\.abort\(\)/);

const pageSource = readFileSync('src/components/ModbusOscPage.tsx', 'utf8');
assert.match(pageSource, /shouldStopOscOnDisconnect/);
assert.match(
  pageSource,
  /if \(!connected && running && shouldStopOscOnDisconnect\(connectionKind\)\) stop\(\)/,
  'only local connection loss must stop parameter polling immediately',
);

const oscPageSource = readFileSync('src/components/OscilloscoperPage.tsx', 'utf8');
assert.match(oscPageSource, /shouldStopOscOnDisconnect/);
assert.match(
  oscPageSource,
  /if \(!connected && running && shouldStopOscOnDisconnect\(connectionTarget\.kind\)\) stop\(\)/,
  'cloud address sampling must survive transient browser reconnects',
);

console.log('modbus osc cloud transport regression passed');
