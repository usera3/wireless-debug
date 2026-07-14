#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import playwright from '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';

const { chromium } = playwright;

const root = resolve(new URL('../tools/remote_mqtt_python/static', import.meta.url).pathname);
const cloudHtml = join(root, 'cloud.html');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mqtt_connected: true }));
    return;
  }
  if (req.url?.startsWith('/api/devices')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      devices: [{
        id: 'wd-ac276eab7c9c',
        name: 'ESP32-001',
        online: true,
        status: { wifi_mode: 'apsta', sta_ip: '10.162.92.4', ap_ip: '192.168.4.1', ble_ready: true, cloud_ws_uplink: { connected: true } },
        last_seen_ms: Date.now(),
      }],
    }));
    return;
  }
  const path = req.url === '/' ? cloudHtml : join(root, req.url || 'cloud.html');
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/cloud.html#overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  }));
  if (result.scrollWidth > result.clientWidth || result.bodyScrollWidth > result.bodyClientWidth) {
    console.error('cloud dashboard mobile layout overflowed');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log('cloud dashboard responsive regression passed');
} finally {
  await browser.close();
  server.close();
}
