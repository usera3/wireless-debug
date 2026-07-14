import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/components/CloudPlatformPage.tsx', 'utf8');
for (const marker of [
  'export function CloudPlatformPage',
  '/api/devices',
  'cloudDeviceConsolePath',
  '设备总览',
  '打开控制台',
]) {
  assert.ok(page.includes(marker), `CloudPlatformPage missing marker: ${marker}`);
}

const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes('currentRuntimeInfo'), 'App must use runtime mode detection');
assert.ok(app.includes('CloudPlatformPage'), 'App must render cloud platform page');

console.log('cloud platform component regression passed');
