#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import playwright from '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';

const { chromium } = playwright;
const root = resolve('dist');
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
  if (!(await page.getByText('Wireless Debug').count())) {
    throw new Error('local mode did not render Wireless Debug shell');
  }

  await page.goto(`http://127.0.0.1:${port}/cloud.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (!(await page.getByText('无线调试云端观测台').count())) {
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
  await page.getByRole('heading', { name: '无线调试云端观测台' }).click();
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

  if (errors.length) throw new Error(`browser errors: ${errors.join('\n')}`);
  console.log('unified site smoke passed');
} finally {
  await browser.close();
  server.close();
}
