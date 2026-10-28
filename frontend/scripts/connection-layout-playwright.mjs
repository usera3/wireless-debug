import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js').href);
const { chromium } = runner.default || runner;
const root = resolve('dist');
const artifacts = resolve('../.superpowers/sdd/connection-layout-artifacts');
mkdirSync(artifacts, { recursive: true });
const writes = [];
const fixtureDeviceId = 'fixture-device-' + 'long-cloud-id-'.repeat(8);
const fixtures = {
  '/api/device/status': { ok: true, net: 'sta', comm: 'wifi', uart_baud: 3000000, ble_ready: true, wifi_ws_client: true },
  '/api/wifi/status': { mode: 'sta', ap_ssid: 'ESP32_Debug_' + 'long-device-name-'.repeat(5), sta_ssid: 'Factory_' + 'long-network-name-'.repeat(5), sta_configured: true, sta_connecting: false, sta_connected: true, sta_ip: '192.168.123.254' },
  '/api/ble/status': { ok: true, started: true, subscribed: true },
  '/api/uart/baud': { ok: true, baud: 3000000 },
  '/platform/api/devices': { devices: [{ device_id: fixtureDeviceId, display_name: 'Fixture device with a long display name', cloud_state: 'online' }] },
};
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
  try {
    const data = readFileSync(join(root, name === 'i.html' ? 'index.html' : name));
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(name)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const geometry = [];
try {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1200, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.includes('/api/')) {
        if (request.method() !== 'GET') writes.push(request.url());
        const key = Object.keys(fixtures).find(key => url.pathname.endsWith(key));
        return route.fulfill({ json: key ? fixtures[key] : { ok: true, files: [] } });
      }
      return url.origin === base ? route.continue() : route.abort();
    });
    await page.addInitScript(deviceId => {
      window.__WIRELESS_RUNTIME_MODE = 'cloud-platform';
      window.__WIRELESS_REMOTE_DEVICE_ID = deviceId;
      window.__WIRELESS_REMOTE_WS_URL = location.origin.replace('http:', 'ws:') + '/ws/device/' + deviceId;
      window.fixtureSockets = [];
      window.WebSocket = class {
        static OPEN = 1; static CLOSED = 3; readyState = 0;
        constructor(url) { this.url = url; window.fixtureSockets.push(this); }
        send() {}
        close() { this.readyState = 3; this.onclose?.({}); }
        open() { this.readyState = 1; this.onopen?.({}); }
      };
    }, fixtureDeviceId);
    await page.goto(base + '/index.html');
    await page.getByRole('navigation').getByRole('button', { name: '连接设置', exact: true }).click();
    const button = name => page.getByRole('button', { name, exact: true });
    const measure = async state => {
      for (const name of ['连接目标', 'WiFi 状态', '数据转发方式', '蓝牙', '串口', '烧录配置']) assert.equal(await page.getByRole('heading', { name, exact: true }).isVisible(), true, name);
      for (const name of ['局域网设备', '云端设备', '自定义地址', '刷新状态', 'AUTO', 'WIFI', 'BLE', '启动 BLE', '连接外部 WiFi', '断开外部 WiFi', '115,200', '921,600', '2M', '3M', '更多波特率', '应用', '导入 gui-config.json', '导出', '编辑 JSON']) assert.equal(await button(name).isVisible(), true, name);
      assert.equal(await page.getByRole('link', { name: '打开网页配网' }).isVisible(), true);
      const bounds = await page.evaluate(() => {
        const main = document.querySelector('.wd-main');
        const box = main.getBoundingClientRect();
        return { height: main.clientHeight, scrollHeight: main.scrollHeight, width: main.clientWidth, scrollWidth: main.scrollWidth, outside: [...document.querySelectorAll('.wd-connection-page button, .wd-connection-page input:not([type=file]), .wd-connection-page select, .wd-connection-page a')].filter(el => el.getClientRects().length).filter(el => { const r = el.getBoundingClientRect(); return r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1; }).map(el => el.textContent || el.getAttribute('placeholder')) };
      });
      geometry.push({ viewportWidth: viewport.width, viewportHeight: viewport.height, state, ...bounds });
      await page.screenshot({ path: join(artifacts, `${process.env.LAYOUT_RED ? 'red' : 'green'}-${viewport.width}-${state}.png`), fullPage: true });
      assert.ok(bounds.scrollWidth <= bounds.width + 1, 'no horizontal overflow: ' + JSON.stringify(geometry.at(-1)));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'document has no horizontal overflow');
      if (viewport.width >= 1200) {
        assert.ok(bounds.scrollHeight <= bounds.height + 1, 'desktop vertical overflow: ' + JSON.stringify(geometry.at(-1)));
        assert.deepEqual(bounds.outside, [], 'ordinary controls stay inside main viewport');
      }
    };
    await button('自定义地址').click();
    await page.getByPlaceholder('http://设备地址 或 ws://服务器地址/ws').fill('invalid target');
    await measure('invalid');
    await button('局域网设备').click();
    await measure('local');
    await button('云端设备').click();
    await page.getByRole('combobox', { name: '在线设备', exact: true }).selectOption(fixtureDeviceId);
    assert.equal(await page.getByRole('combobox').inputValue(), fixtureDeviceId);
    await measure('cloud');
    await button('自定义地址').click();
    await page.getByPlaceholder('http://设备地址 或 ws://服务器地址/ws').fill(base.replace('http:', 'ws:') + '/ws/' + 'long-address-segment-'.repeat(10));
    await button('连接').click();
    await page.evaluate(() => window.fixtureSockets.at(-1).open());
    await page.getByText('客户端已连接', { exact: true }).waitFor();
    await page.getByText('3,000,000 bps', { exact: true }).waitFor();
    for (const value of [fixtures['/api/wifi/status'].ap_ssid, fixtures['/api/wifi/status'].sta_ssid]) {
      assert.equal(await page.locator('.wd-connection-page').getByText(value, { exact: true }).getAttribute('title'), value, 'long SSID remains available in title');
    }
    await measure('populated');
    if (viewport.width === 390) {
      // The actual 390×844 geometry was asserted above. Increase height only for
      // a full-flow reference image because the application scrolls inside main.
      const fullHeight = await page.locator('.wd-main').evaluate(main => main.scrollHeight + main.getBoundingClientRect().top);
      await page.setViewportSize({ width: viewport.width, height: fullHeight });
      await page.screenshot({ path: join(artifacts, 'green-390-populated-full.png'), fullPage: true });
      await page.setViewportSize(viewport);
    }
    await button('编辑 JSON').click();
    assert.equal(await page.locator('textarea').isEditable(), true);
    await button('取消').click();
    await button('更多波特率').click();
    await page.getByRole('heading', { name: '⚙️ UART1 波特率设置', exact: true }).waitFor();
    await button('✕ 关闭').click();
    assert.deepEqual(errors, [], 'no runtime exceptions');
    await page.close();
  }
  assert.deepEqual(writes, [], 'viewing settings and local dialogs sends no device mutations');
  console.log(JSON.stringify(geometry, null, 2));
  console.log('connection layout passed');
} finally { await browser.close(); server.close(); }
