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
  if (req.url === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      devices: [{
        device_id: 'wd-ac276eab7c9c',
        display_name: 'ESP32-001',
        cloud_state: 'online',
        last_seen_ms: Date.now(),
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
  if (req.url === '/cloud.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlWithRuntime('cloud-platform'));
    return;
  }
  if (req.url === '/remote/wd-ac276eab7c9c/orig/i.html') {
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

  await page.goto(`http://127.0.0.1:${port}/remote/wd-ac276eab7c9c/orig/i.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (!(await page.getByText('连接设置').count())) {
    throw new Error('cloud device mode did not render device controls');
  }

  if (errors.length) throw new Error(`browser errors: ${errors.join('\n')}`);
  console.log('unified site smoke passed');
} finally {
  await browser.close();
  server.close();
}
