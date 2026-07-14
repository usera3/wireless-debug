import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = process.cwd();
const cloudUrl = (process.env.CLOUD_URL || 'http://127.0.0.1:18088').replace(/\/$/, '');
const paramTable = process.env.PARAM_TABLE || '/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx';
const screenshotDir = process.env.SCREENSHOT_DIR || '/tmp';
const requestedDeviceId = process.env.DEVICE_ID || '';
const runnerDir = process.env.WIRELESS_DEBUG_PW_RUNNER || '/tmp/wireless_debug_playwright_runner';

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    const runnerPkg = resolve(runnerDir, 'package.json');
    assert.ok(existsSync(runnerPkg), `Playwright not found. Set WIRELESS_DEBUG_PW_RUNNER or install into ${runnerDir}`);
    return createRequire(runnerPkg)('playwright');
  }
}

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  assert.ok(res.ok, `${res.status} ${url}: ${text}`);
  return json;
}

async function pickDeviceId() {
  if (requestedDeviceId) return requestedDeviceId;
  const data = await jsonFetch(`${cloudUrl}/api/devices`);
  const online = (data.devices || []).find((device) => device.cloud_state === 'online');
  assert.ok(online, 'no online device available for remote console smoke test');
  return online.device_id;
}

const { chromium } = loadPlaywright();
const deviceId = await pickDeviceId();
const events = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--no-proxy-server'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) events.push(`console:${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => events.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    events.push(`requestfailed:${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`);
  });
  page.on('request', (req) => {
    if (req.url().includes('192.168.4.1/api')) {
      events.push(`local-api-request:${req.method()} ${req.url()}`);
    }
    if (req.url().includes('/ws/poll')) {
      events.push(`poll-ws-request:${req.method()} ${req.url()}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('/favicon.ico')) {
      events.push(`http ${res.status()}: ${res.url()}`);
    }
  });

  await page.goto(`${cloudUrl}/cloud.html`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.screenshot({ path: resolve(screenshotDir, 'wd-cloud-overview.png'), fullPage: true });
  const cloudText = await page.locator('body').innerText({ timeout: 5000 });
  assert.ok(cloudText.includes('控制台'), 'cloud overview must show console entry');
  assert.ok(cloudText.includes(deviceId), `cloud overview must show selected device ${deviceId}`);

  await page.goto(`${cloudUrl}/remote/${encodeURIComponent(deviceId)}/orig/i.html`, {
    waitUntil: 'networkidle',
    timeout: 15000,
  });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: resolve(screenshotDir, 'wd-remote-console-connected.png'), fullPage: true });

  const remoteState = await page.evaluate(async () => {
    const api = await fetch('/api/device/status').then((r) => r.json());
    const excelList = await fetch('/api/excel/list').then((r) => r.json());
    return {
      body: document.body.innerText,
      api,
      excelList,
      wsType: String(window.WebSocket && window.WebSocket.name),
      device: window.__WIRELESS_REMOTE_DEVICE_ID,
      remoteWs: window.__WIRELESS_REMOTE_WS_URL,
    };
  });
  assert.equal(remoteState.wsType, 'WebSocket', 'remote console must use native browser WebSocket');
  assert.equal(remoteState.device, deviceId, 'remote console must expose selected device id');
  assert.ok(
    String(remoteState.remoteWs || '').startsWith('ws://') || String(remoteState.remoteWs || '').startsWith('wss://'),
    'remote console must expose a real cloud websocket URL',
  );
  assert.ok(remoteState.remoteWs.includes(`/ws/device/${encodeURIComponent(deviceId)}`), 'remote websocket URL must target selected device');
  assert.equal(remoteState.api.ok, true, 'remote /api/device/status must return ok');
  assert.ok(remoteState.body.includes('已连接'), 'remote console should auto-connect after startup delay');

  const beforeConnectionEvents = events.length;
  await page.getByRole('button', { name: /连接设置/ }).click();
  await page.waitForTimeout(2500);
  const connectionText = await page.locator('body').innerText();
  assert.ok(connectionText.includes('BLE 已启动'), 'connection panel should read BLE status through cloud proxy');
  assert.ok(connectionText.includes('AUTO'), 'connection panel should render communication controls');
  assert.ok(connectionText.includes('通信入口地址'), 'connection panel should expose the editable communication target');
  assert.ok(connectionText.includes('云端通道'), 'connection panel should resolve the cloud websocket tunnel');
  const connectionEvents = events.slice(beforeConnectionEvents);
  assert.ok(
    !connectionEvents.some((event) => event.includes('192.168.4.1/api')),
    `connection panel must not call local ESP32 API from cloud console: ${JSON.stringify(connectionEvents, null, 2)}`,
  );

  if (existsSync(paramTable)) {
    await page.getByRole('button', { name: /仪表盘/ }).click();
    await page.getByText('远程加载').click();
    await page.waitForSelector('text=从 ESP32 加载 Excel 文件', { timeout: 5000 });
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /上传新文件/ }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'pt.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: readFileSync(paramTable),
    });
    await page.waitForSelector('text=pt.xlsx', { timeout: 10000 });
    await page.getByRole('button', { name: '选择加载' }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: resolve(screenshotDir, 'wd-remote-excel-selected.png'), fullPage: true });
    const loadedText = await page.locator('body').innerText();
    assert.ok(!loadedText.includes('参数表未加载'), 'remote Excel load should clear missing-parameter warning');
    assert.match(loadedText, /MotorSpd|CmdSpd|母线电压|故障码/, 'loaded parameter table should affect dashboard labels');

    await fetch(`${cloudUrl}/remote/${encodeURIComponent(deviceId)}/api/excel/delete?name=pt.xlsx`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  assert.deepEqual(events, [], `browser errors during smoke test: ${JSON.stringify(events, null, 2)}`);
  console.log(`remote console smoke passed for ${deviceId}`);
} finally {
  await browser.close();
}
