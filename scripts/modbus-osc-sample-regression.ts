import { strict as assert } from 'node:assert';
import { completeOscSample } from '../src/lib/modbusOscSample';

assert.deepEqual(
  completeOscSample(['CH1', 'CH2', 'CH3', 'CH4'], {}),
  { CH1: 0, CH2: 0, CH3: 0, CH4: 0 },
  'a timeout cycle must append a zero for every configured channel',
);

assert.deepEqual(
  completeOscSample(['CH1', 'CH2', 'CH3', 'CH4'], { CH1: 12.5, CH3: -2 }),
  { CH1: 12.5, CH2: 0, CH3: -2, CH4: 0 },
  'partial responses must preserve real values and zero-fill missing channels',
);

console.log('modbus osc sample regression passed');
