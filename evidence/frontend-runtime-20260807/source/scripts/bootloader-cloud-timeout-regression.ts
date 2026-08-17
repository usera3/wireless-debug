import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendCrc } from '../src/lib/crc16';
import { frameRouter } from '../src/lib/frameRouter';
import * as bootloaderClientModule from '../src/lib/blModbusClient';
import { BlModbusClient } from '../src/lib/blModbusClient';
import { wsClient } from '../src/lib/wsClient';

type TimeoutPolicy = (kind: 'local' | 'cloud' | 'invalid') => number;
type ConfigurableClient = new (slaveId?: number, responseTimeoutMs?: number) => BlModbusClient;

const timeoutPolicy = (
  bootloaderClientModule as typeof bootloaderClientModule & {
    bootloaderResponseTimeoutMs?: TimeoutPolicy;
  }
).bootloaderResponseTimeoutMs;

assert.equal(typeof timeoutPolicy, 'function', 'bootloader timeout policy should be exported');
assert.ok(timeoutPolicy);
assert.equal(timeoutPolicy('local'), 500, 'local bootloader commands should keep the fast timeout');
assert.equal(timeoutPolicy('cloud'), 5000, 'cloud bootloader commands need room for MQTT round trips');
assert.equal(timeoutPolicy('invalid'), 500, 'invalid targets should use the conservative local fallback');

const response = appendCrc(new Uint8Array([0xff, 0x65, 0x00]));
const originalSend = wsClient.send.bind(wsClient);

try {
  wsClient.send = () => {
    setTimeout(() => frameRouter.feed(response), 650);
  };

  const Client = BlModbusClient as ConfigurableClient;
  const cloudResult = await new Client(0xff, timeoutPolicy('cloud')).enterBootloaderMode();
  assert.equal(cloudResult.success, true, 'a delayed cloud response should still be accepted');

  let localAttempts = 0;
  wsClient.send = () => {
    localAttempts += 1;
    setTimeout(() => frameRouter.feed(response), 1_200);
  };
  await assert.rejects(
    new Client(0xff, timeoutPolicy('local')).enterBootloaderMode(),
    /响应超时/,
    'a response outside both bounded local attempts should still fail',
  );
  assert.equal(localAttempts, 2, 'the local transition should have exactly one retry');
  await new Promise((resolve) => setTimeout(resolve, 800));

  let enterAttempts = 0;
  wsClient.send = () => {
    enterAttempts += 1;
    if (enterAttempts === 2) {
      setTimeout(() => frameRouter.feed(response), 0);
    }
  };

  const transitionResult = await new Client(0xff, 20).enterBootloaderMode();
  assert.equal(
    transitionResult.success,
    true,
    'entering Bootloader should recover when the application transition drops the first ACK',
  );
  assert.equal(
    enterAttempts,
    2,
    'only the timed-out Bootloader transition command should be retried once',
  );
} finally {
  wsClient.send = originalSend;
}

const flasherSource = readFileSync('src/lib/flasher.ts', 'utf8');
assert.match(
  flasherSource,
  /new BlModbusClient\(slaveId,\s*options\.responseTimeoutMs\)/,
  'Flasher should forward the selected transport timeout to BlModbusClient',
);

const pageSource = readFileSync('src/components/BootloaderPage.tsx', 'utf8');
assert.match(
  pageSource,
  /bootloaderResponseTimeoutMs\(currentConnectionTarget\(\)\.kind\)/,
  'BootloaderPage should select its timeout from the active connection target',
);

console.log('bootloader cloud timeout regression passed');
