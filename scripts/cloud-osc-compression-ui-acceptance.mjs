import { strict as assert } from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const dryRun = process.argv.includes('--dry-run');
const targetMode = process.env.TARGET_MODE || 'cloud';
const paramDurationMs = Number(process.env.PARAM_DURATION_MS || 300_000);
const addressDurationMs = Number(process.env.ADDRESS_DURATION_MS || 60_000);
const url = process.env.CLOUD_REMOTE_URL || (
  targetMode === 'local'
    ? 'http://192.168.4.1/orig/i.html'
    : 'https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html'
);
const paramTable = process.env.PARAM_TABLE ||
  '/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx';
const outputPath = process.env.UI_ACCEPTANCE_OUTPUT ||
  '/tmp/cloud-waveform-compression-ui.json';
const screenshotPath = process.env.UI_ACCEPTANCE_SCREENSHOT ||
  '/tmp/cloud-waveform-compression-ui.png';
const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER || '';
const username = process.env.CLOUD_HTTP_USER || '';
const password = process.env.CLOUD_HTTP_PASSWORD || '';

assert.ok(['cloud', 'local'].includes(targetMode), `invalid TARGET_MODE: ${targetMode}`);
assert.ok(Number.isFinite(paramDurationMs) && paramDurationMs > 0);
assert.ok(Number.isFinite(addressDurationMs) && addressDurationMs > 0);
assert.ok(existsSync(paramTable), `parameter table missing: ${paramTable}`);

if (dryRun) {
  console.log('cloud compression UI acceptance dry-run passed');
  process.exit(0);
}

if (targetMode === 'cloud') {
  assert.ok(username && password, 'cloud credentials must be supplied through the environment');
}

const runner = process.env.WIRELESS_DEBUG_PW_RUNNER ||
  '/tmp/wireless_debug_playwright_runner';
const requireFromRunner = createRequire(`${runner}/runner.js`);
const { chromium } = requireFromRunner('playwright');

function toBuffer(payload) {
  const value = payload && typeof payload === 'object' && 'payload' in payload
    ? payload.payload
    : payload;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'binary');
  return Buffer.alloc(0);
}

function parseParamStatus(text) {
  const io = text.match(/请求\/响应:\s*(\d+)\/(\d+)/);
  const samples = text.match(/样本:\s*(\d+)/);
  return {
    requests: Number(io?.[1] || 0),
    responses: Number(io?.[2] || 0),
    samples: Number(samples?.[1] || 0),
    running: /状态:\s*运行中/.test(text),
  };
}

function parseCache(text) {
  const match = text.match(
    /缓存:\s*([0-9.]+)(s|min)\s*\/\s*([0-9.]+)\s*(MB|GB)/,
  );
  if (!match) return { seconds: 0, megabytes: 0 };
  const seconds = Number(match[1]) * (match[2] === 'min' ? 60 : 1);
  const megabytes = Number(match[3]) * (match[4] === 'GB' ? 1024 : 1);
  return { seconds, megabytes };
}

async function sampleFor(page, durationMs, parseStatus) {
  const deadline = Date.now() + durationMs;
  let becameRunning = false;
  let stoppedEarly = false;
  let latestText = '';
  let latestStatus = null;
  const observations = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    latestText = await page.locator('body').innerText();
    const running = /状态:\s*运行中/.test(latestText);
    if (running) becameRunning = true;
    else if (becameRunning) stoppedEarly = true;
    latestStatus = parseStatus(latestText);
    observations.push({
      elapsedMs: durationMs - Math.max(0, deadline - Date.now()),
      running,
    });
  }
  return { becameRunning, stoppedEarly, latestText, latestStatus, observations };
}

async function configureAddressChannels(page, addresses) {
  const selects = page.locator('select');
  await selects.first().selectOption(String(addresses.length));
  const textInputs = page.locator('input[type=text]');
  assert.ok(await textInputs.count() >= addresses.length * 2, 'address channel inputs missing');
  for (const [index, address] of addresses.entries()) {
    await textInputs.nth(index * 2).fill(address);
    await textInputs.nth(index * 2 + 1).fill(`CH${index + 1}`);
  }
}

const browser = await chromium.launch({
  headless: true,
  args: proxyServer
    ? []
    : ['--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*'],
  proxy: proxyServer ? { server: proxyServer } : undefined,
});
const authorization = username && password
  ? Buffer.from(`${username}:${password}`).toString('base64')
  : '';
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  extraHTTPHeaders: authorization ? { Authorization: `Basic ${authorization}` } : {},
});
const page = await context.newPage();
const errors = [];
let wsRxBytes = 0;

page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('websocket', (socket) => {
  if (!socket.url().includes('/ws/device/')) return;
  socket.on('framereceived', (payload) => {
    wsRxBytes += toBuffer(payload).length;
  });
});

const result = { targetMode, url, paramDurationMs, addressDurationMs };
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);
  assert.match(await page.locator('body').innerText(), /已连接/);
  await page.locator('input[type=file]').first().setInputFiles(paramTable);
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: /参数示波器/ }).first().click();
  await page.waitForTimeout(800);
  await page.locator('select').first().selectOption({ label: 'MOTOR0' });
  await page.locator('input[type=number]').first().fill('500');
  await page.getByRole('button', { name: /开始/ }).first().click();
  const parameter = await sampleFor(page, paramDurationMs, parseParamStatus);
  assert.equal(parameter.becameRunning, true, 'parameter oscilloscope never ran');
  assert.equal(parameter.stoppedEarly, false, 'parameter oscilloscope stopped during soak');
  assert.ok(parameter.latestStatus.requests > 0, 'parameter soak sent no requests');
  assert.ok(parameter.latestStatus.responses > 0, 'parameter soak received no responses');
  assert.ok(parameter.latestStatus.samples > 0, 'parameter soak appended no samples');
  result.parameter = {
    ...parameter.latestStatus,
    observationCount: parameter.observations.length,
  };
  await page.getByRole('button', { name: /停止/ }).first().click();

  await page.getByRole('button', { name: /地址示波器/ }).first().click();
  await page.waitForTimeout(800);
  await configureAddressChannels(page, ['C52C', '0000', '0000', '0000']);
  const addressRxStart = wsRxBytes;
  await page.getByRole('button', { name: /开始/ }).first().click();
  const address = await sampleFor(page, addressDurationMs, parseCache);
  const addressWsBytes = wsRxBytes - addressRxStart;
  const cache = parseCache(address.latestText);
  const addressCacheSeconds = cache.seconds;
  assert.equal(address.becameRunning, true, 'address oscilloscope never ran');
  assert.equal(address.stoppedEarly, false, 'address oscilloscope stopped during soak');
  assert.ok(addressCacheSeconds > 0, 'address cache stayed empty');
  assert.ok(cache.megabytes > 0, 'address cache memory stayed empty');
  if (targetMode === 'cloud') {
    assert.ok(addressCacheSeconds >= 30, `address cache too short: ${addressCacheSeconds}s`);
    assert.ok(
      addressWsBytes >= 60_000 * addressDurationMs / 1000,
      `address websocket throughput too low: ${addressWsBytes} bytes`,
    );
  }
  result.address = {
    running: address.latestStatus,
    cacheSeconds: addressCacheSeconds,
    cacheMegabytes: cache.megabytes,
    wsBytes: addressWsBytes,
    observationCount: address.observations.length,
  };
  result.errors = errors;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.getByRole('button', { name: /停止/ }).first().click();
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
