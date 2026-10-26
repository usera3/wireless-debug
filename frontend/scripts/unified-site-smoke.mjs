#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';
const playwrightModule = await import(pathToFileURL(resolve(runner)).href);
const playwright = playwrightModule.default || playwrightModule;

const { chromium } = playwright;
const root = resolve('dist');
const screenshots = process.env.CLOUD_SCREENSHOTS || '/tmp/wd-cloud-ui';
mkdirSync(screenshots, { recursive: true });
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function htmlWithRuntime(mode, deviceId = null) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const wsUrl = deviceId ? `ws://127.0.0.1:18089/ws/device/${deviceId}` : null;
  return html.replace('</head>', `<script>
    window.__WIRELESS_RUNTIME_MODE = ${JSON.stringify(mode)};
    window.__WIRELESS_REMOTE_DEVICE_ID = ${JSON.stringify(deviceId)};
    window.__WIRELESS_REMOTE_WS_URL = ${JSON.stringify(wsUrl)};
  </script></head>`);
}

function distPathForRequest(rawUrl) {
  const pathname = new URL(rawUrl || '/', 'http://127.0.0.1').pathname;
  const remoteAsset = pathname.match(/^\/remote\/[^/]+\/orig\/(.+)$/);
  if (remoteAsset) return remoteAsset[1] === 'i.html' ? 'index.html' : remoteAsset[1];
  if (pathname === '/orig/i.html') return 'index.html';
  if (pathname.startsWith('/orig/')) return pathname.slice('/orig/'.length);
  return pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      mqtt_connected: true,
      generated_at: new Date().toISOString(),
      summary: { total: 1, online: 1, offline: 0, unknown: 0 },
      devices: [{
        device_id: 'wd-ac276eab7c9c',
        device_mac: 'ac:27:6e:ab:7c:9c',
        display_name: 'ESP32-001',
        cloud_state: 'online',
        net_mode: 'apsta',
        sta_ip: '10.162.92.4',
        ap_ip: '192.168.4.1',
        comm_mode: 'auto',
        ble_ready: true,
        wifi_ws_client: true,
        uart_baud: 2000000,
        fw_version: 'wireless-debug',
        health_score: 96,
        last_seen_ms: Date.now(),
        status_age_seconds: 2,
        status: {
          wifi_mode: 'apsta',
          sta_ip: '10.162.92.4',
          ap_ip: '192.168.4.1',
          ble_ready: true,
          cloud_ws_uplink: { connected: true },
        },
      }],
    }));
    return;
  }
  if (url.pathname === '/api/devices/wd-ac276eab7c9c') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      device: {
        device_id: 'wd-ac276eab7c9c',
        device_mac: 'ac:27:6e:ab:7c:9c',
        display_name: 'ESP32-001',
        cloud_state: 'online',
        last_seen_at: new Date().toISOString(),
        health_score: 96,
        diagnostic_level: 'normal',
        diagnostic_text: '运行正常',
        diagnostic_reasons: ['心跳正常'],
        net_mode: 'apsta',
        sta_ip: '10.162.92.4',
        ap_ip: '192.168.4.1',
        comm_mode: 'auto',
        ble_ready: true,
        wifi_ws_client: true,
        uart_baud: 2000000,
        fw_version: 'wireless-debug',
        heap_free: 188000,
        heap_min_free: 120000,
        heap_largest: 90000,
        restart_reason: 1,
        display_status: 'ready',
        display_backend: 'oled',
        motor_param_count: 80,
        motor_param_capacity: 128,
        last_status_json: {
          device_mac: 'ac:27:6e:ab:7c:9c',
          net_mode: 'apsta',
          sta_connected: true,
          sta_configured: true,
          sta_connecting: false,
          sta_ip: '10.162.92.4',
          ap_ip: '192.168.4.1',
          ble_ready: true,
          ble_subscribed: false,
          wifi_ws_client: true,
          uart_baud: 2000000,
          comm_mode: 'auto',
          uptime_ms: 380000,
        },
      },
      events: [{
        event_type: 'status',
        payload_json: { net_mode: 'apsta', sta_ip: '10.162.92.4' },
        created_at: new Date().toISOString(),
      }],
      commands: [{
        command_id: 'cmd-smoke',
        command_type: 'query_status',
        state: 'ACKED',
        ack_message: 'ok',
        created_at: new Date().toISOString(),
        ack_at: new Date().toISOString(),
      }],
      notes: [{ note: '测试样机', created_at: new Date().toISOString() }],
    }));
    return;
  }
  if (url.pathname === '/api/devices/wd-ac276eab7c9c/history') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      summary: { status_count: 2, availability_count: 1, command_count: 1, acked_count: 1, failed_count: 0, avg_latency_ms: 42 },
      status_points: [
        { created_at: new Date(Date.now() - 60000).toISOString(), sta_connected: false, sta_ip: '', net_mode: 'sta' },
        { created_at: new Date().toISOString(), sta_connected: true, sta_ip: '10.162.92.4', net_mode: 'apsta' },
      ],
      availability: [{ payload_json: { state: 'online' }, created_at: new Date().toISOString() }],
      commands: [{
        command_id: 'cmd-smoke',
        command_type: 'query_status',
        state: 'ACKED',
        ack_message: 'ok',
        latency_ms: 42,
        created_at: new Date().toISOString(),
      }],
    }));
    return;
  }
  if (url.pathname === '/api/bus/messages') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      channels: ['notify'],
      messages: [{
        source_type: 'cloud',
        target_type: 'device',
        target_id: 'wd-ac276eab7c9c',
        target_display_name: 'ESP32-001',
        channel: 'notify',
        payload_text: 'hello',
        state: 'ACKED',
        ack_message: 'ok',
        created_at: new Date().toISOString(),
      }],
    }));
    return;
  }
  if (url.pathname === '/api/bus/send') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message_id: 'msg-smoke' }));
    return;
  }
  if (url.pathname === '/cloud.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlWithRuntime('cloud-platform'));
    return;
  }
  if (url.pathname === '/remote/wd-ac276eab7c9c/orig/i.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlWithRuntime('cloud-device', 'wd-ac276eab7c9c'));
    return;
  }

  const pathname = distPathForRequest(req.url);
  try {
    const body = readFileSync(join(root, pathname));
    res.writeHead(200, { 'content-type': mime[extname(pathname)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`http://127.0.0.1:${port}/orig/i.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (!(await page.locator('.wd-brand').getByText('GMCC', { exact: false }).count())) {
    throw new Error('local mode did not render GMCC shell');
  }

  await page.goto(`http://127.0.0.1:${port}/cloud.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (!(await page.getByText('GMCC · 设备调试台').count())) {
    throw new Error('cloud platform mode did not render dashboard');
  }
  if (!(await page.getByText('ESP32-001').count())) {
    throw new Error('cloud platform mode did not render device row');
  }
  await page.getByRole('button', { name: '设备管理' }).click();
  if (!(await page.getByRole('heading', { name: '设备管理' }).count())) {
    throw new Error('cloud platform navigation did not switch to device management');
  }
  for (const text of ['诊断摘要', '系统资源', '设备详情', '备注', '保存设备名', '刷新状态']) {
    if (!(await page.getByText(text).count())) throw new Error(`device management missing ${text}`);
  }
  await page.getByRole('button', { name: '连接管理' }).click();
  for (const text of ['连接状态', '最近状态包']) {
    if (!(await page.getByText(text).count())) throw new Error(`connection management missing ${text}`);
  }
  await page.getByRole('button', { name: '连接历史' }).click();
  for (const text of ['最近状态摘要', '命令响应']) {
    if (!(await page.getByText(text).count())) throw new Error(`history tab missing ${text}`);
  }
  await page.getByRole('button', { name: '消息中心' }).click();
  for (const text of ['云端发送', '消息流水']) {
    if (!(await page.getByText(text).count())) throw new Error(`message center missing ${text}`);
  }
  await page.getByRole('button', { name: '能力清单' }).click();
  if (!(await page.getByText('云端已开放').count())) {
    throw new Error('capabilities tab missing cloud capability card');
  }
  await page.getByRole('button', { name: '事件记录' }).click();
  for (const text of ['最近事件', '最近命令']) {
    if (!(await page.getByText(text).count())) throw new Error(`events tab missing ${text}`);
  }
  await page.getByRole('button', { name: /Admin/ }).click();
  const logout = page.getByRole('link', { name: '退出登录' });
  await logout.hover();
  if (!(await logout.isVisible())) {
    throw new Error('cloud platform user menu hides before logout can be clicked');
  }
  const logoutHref = await logout.getAttribute('href');
  if (logoutHref !== '/logout') {
    throw new Error(`cloud platform logout href mismatch: ${logoutHref}`);
  }
  await page.getByRole('heading', { name: 'GMCC · 设备调试台' }).click();
  await page.waitForTimeout(120);
  if (await logout.isVisible()) {
    throw new Error('cloud platform user menu did not close after clicking outside');
  }

  await page.goto(`http://127.0.0.1:${port}/remote/wd-ac276eab7c9c/orig/i.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (!(await page.getByText('连接设置').count())) {
    throw new Error('cloud device mode did not render device controls');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/cloud.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const mobileNavButton = page.getByRole('button', { name: '打开导航' });
  if (!(await mobileNavButton.isVisible())) {
    throw new Error('mobile cloud platform did not render navigation button');
  }
  if (!(await page.getByLabel('移动端设备列表').isVisible())) {
    throw new Error('mobile cloud platform did not render device cards');
  }
  if (await page.locator('table').isVisible()) {
    throw new Error('mobile cloud platform should not show the wide device table');
  }
  await mobileNavButton.click();
  const mobileDeviceNav = page.getByRole('dialog', { name: '移动端导航' }).getByRole('button', { name: '设备管理' });
  if (!(await mobileDeviceNav.isVisible())) {
    throw new Error('mobile cloud platform drawer did not expose device management');
  }
  await mobileDeviceNav.click();
  if (!(await page.getByRole('heading', { name: '设备管理' }).count())) {
    throw new Error('mobile cloud platform navigation did not switch sections');
  }

  // Exercise the same real controls at desktop, compact desktop and phone widths.
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1024 ? 768 : 1024 });
    await page.goto(`http://127.0.0.1:${port}/cloud.html`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '设备总览' }).waitFor();
    async function checkOverflow(section) {
      const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      if (size.document > size.viewport) throw new Error(`${width}px ${section} document overflow: ${size.document}`);
    }
    async function navigate(label) {
      if (width < 1024) {
        await page.getByRole('button', { name: '打开导航' }).click();
        await page.getByRole('dialog', { name: '移动端导航' }).getByRole('button', { name: label, exact: true }).click();
        if (await page.getByRole('dialog', { name: '移动端导航' }).count()) throw new Error('mobile drawer stayed open after navigation');
      } else {
        await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
      }
      await page.getByRole('heading', { name: label, exact: true, level: 2 }).waitFor();
      await checkOverflow(label);
    }
    await checkOverflow('overview');
    await page.screenshot({ path: join(screenshots, `${width}-overview.png`), fullPage: true });
    const search = page.getByPlaceholder('搜索设备 ID / MAC / 备注 / IP');
    const deviceName = page.getByText('ESP32-001', { exact: true }).locator('visible=true');
    await search.fill('no-such-device');
    if (await deviceName.count()) throw new Error(`${width}px search did not hide nonmatching device`);
    await search.fill('ESP32-001');
    await deviceName.first().waitFor({ state: 'visible' });
    const stateFilter = page.locator('main select');
    await stateFilter.selectOption('offline');
    if (await deviceName.count()) throw new Error(`${width}px state filter retained online device`);
    await stateFilter.selectOption('online');
    await deviceName.first().waitFor({ state: 'visible' });
    await stateFilter.selectOption('all');
    await search.fill('');
    const openConsole = page.locator('a[href="/remote/wd-ac276eab7c9c/orig/i.html"]:visible');
    const consoleHref = await openConsole.first().getAttribute('href');
    if (consoleHref !== '/remote/wd-ac276eab7c9c/orig/i.html') throw new Error(`device console href mismatch: ${consoleHref}`);
    for (const label of ['设备管理', '连接管理', '连接历史', '消息中心', '能力清单', '事件记录', '系统设置', '仪表盘']) {
      await navigate(label);
      if (label === '设备管理') {
        await page.getByText('保存设备名', { exact: true }).waitFor();
        await page.screenshot({ path: join(screenshots, `${width}-device-management.png`), fullPage: true });
      }
    }
    await page.locator('.user-menu > button').click();
    await logout.waitFor({ state: 'visible' });
    if (await logout.getAttribute('href') !== '/logout') throw new Error('logout link changed');
    await page.getByRole('heading', { name: 'GMCC · 设备调试台' }).click();
    if (await logout.isVisible()) throw new Error(`${width}px user menu did not close`);
    if (width < 1024) {
      await page.getByRole('button', { name: '打开导航' }).click();
      await page.keyboard.press('Escape');
      if (await page.getByRole('dialog', { name: '移动端导航' }).count()) throw new Error('Escape did not close drawer');
    }
  }

  if (errors.length) throw new Error(`browser errors: ${errors.join('\n')}`);
  console.log('unified site smoke passed');
} finally {
  await browser.close();
  server.close();
}
