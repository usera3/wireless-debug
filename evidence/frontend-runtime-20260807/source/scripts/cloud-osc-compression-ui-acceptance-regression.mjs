import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync('scripts/cloud-osc-compression-ui-acceptance.mjs', 'utf8');

for (const token of [
  "process.argv.includes('--dry-run')",
  "process.env.TARGET_MODE || 'cloud'",
  'PARAM_DURATION_MS',
  'ADDRESS_DURATION_MS',
  'PLAYWRIGHT_PROXY_SERVER',
  'async function sampleFor',
  'function parseCache',
  "locator('input[type=file]').first().setInputFiles(paramTable)",
  "getByRole('button', { name: /参数示波器/ })",
  "getByRole('button', { name: /地址示波器/ })",
  "configureAddressChannels(page, ['C52C', '0000', '0000', '0000'])",
  "socket.url().includes('/ws/device/')",
  '60_000 * addressDurationMs / 1000',
  'addressCacheSeconds >= 30',
  'page.screenshot',
  'writeFileSync',
]) {
  assert.ok(source.includes(token), `cloud UI acceptance missing contract: ${token}`);
}

assert.ok(
  source.indexOf("process.argv.includes('--dry-run')") < source.indexOf("requireFromRunner('playwright')"),
  'dry-run gate must execute before Playwright is loaded',
);
assert.match(
  source,
  /sampleFor[\s\S]*waitForTimeout\(1000\)[\s\S]*状态:\s*\\s\*运行中/,
  'soak must check running state every second',
);
assert.match(
  source,
  /if \(targetMode === 'cloud'\) \{[\s\S]{0,200}username && password/,
  'credentials must be required only for cloud mode',
);
assert.ok(source.includes('process.env.CLOUD_HTTP_USER'));
assert.ok(source.includes('process.env.CLOUD_HTTP_PASSWORD'));
assert.match(
  source,
  /proxyServer[\s\S]*proxy:\s*proxyServer\s*\?\s*\{\s*server:\s*proxyServer\s*\}/,
  'cloud UI acceptance must allow an explicit Chromium proxy without changing local defaults',
);

console.log('cloud compression UI acceptance contract passed');
