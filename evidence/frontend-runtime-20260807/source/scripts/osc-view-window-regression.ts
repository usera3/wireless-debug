import assert from 'node:assert/strict';
import { useOscStore } from '../src/store/oscStore';
import { useModbusOscStore } from '../src/store/modbusOscStore';

const addressStore = useOscStore.getState();
const parameterStore = useModbusOscStore.getState();

addressStore.setViewWindowSeconds(0.25);
assert.equal(
  useOscStore.getState().viewWindowSeconds,
  0.25,
  'address oscilloscope must preserve a valid sub-second view window',
);

parameterStore.setViewWindowSeconds(0.25);
assert.equal(
  useModbusOscStore.getState().viewWindowSeconds,
  0.25,
  'parameter oscilloscope must preserve a valid sub-second view window',
);

addressStore.setViewWindowSeconds(1 / 6000);
assert.equal(
  useOscStore.getState().viewWindowSeconds,
  1 / 6000,
  'address oscilloscope must allow a window down to one high-rate sample interval',
);

parameterStore.setViewWindowSeconds(Number.NaN);
assert.equal(
  useModbusOscStore.getState().viewWindowSeconds,
  10,
  'invalid parameter view windows must still fall back to the default',
);

console.log('osc view window regression passed');
