import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const module = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js').href);
const { chromium } = module.default || module;
const server = createServer((req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
  if (req.url.includes('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"devices":[]}'); return;
  }
  try {
    let body = readFileSync(join(resolve('dist'), file));
    if (file === 'index.html') body = body.toString().replace('</head>', '<script>window.__WIRELESS_RUNTIME_MODE="cloud-platform";</script></head>');
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.fixtureSockets = [];
    window.fixtureFrames = [];
    window.replyDashboard = value => {
      const response = [255, 3, 2, (value >>> 8) & 255, value & 255];
      let crc = 0xffff;
      for (const byte of response) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
      }
      response.push(crc & 255, crc >>> 8);
      window.fixtureSockets.at(-1).onmessage({ data: Uint8Array.from(response).buffer });
    };
    window.WebSocket = class {
      static OPEN = 1; static CLOSED = 3;
      readyState = 0;
      constructor() { this.id = window.fixtureSockets.length; window.fixtureSockets.push(this); }
      open() { this.readyState = 1; this.onopen?.({}); }
      close() { this.readyState = 3; this.onclose?.({}); }
      send(data) { window.fixtureFrames.push({ socket: this.id, frame: Array.from(data), time: performance.now() }); }
    };
  });
  await page.goto(base + '/index.html');
  const nav = async label => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
  await nav('参数编辑');
  await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(resolve('reference/ParameterTable.xlsx'));
  await page.getByRole('cell', { name: 'POLEPAIRS_BASE', exact: true }).waitFor();
  await nav('连接设置');
  await page.getByRole('button', { name: '自定义地址', exact: true }).click();
  await page.getByRole('textbox').first().fill(base.replace('http:', 'ws:') + '/ws');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await nav('仪表盘');
  await page.getByRole('button', { name: '仪表盘使能', exact: true }).click();
  await page.waitForFunction(() => window.fixtureFrames.length === 1);
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  await page.waitForFunction(() => window.fixtureSockets.length === 2);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await page.waitForFunction(() => window.fixtureFrames.length >= 2);
  const firstTwo = await page.evaluate(() => window.fixtureFrames.slice(0, 2));
  assert.ok(firstTwo[1].time - firstTwo[0].time < 500, 'reconnect occurs before old request timeout');
  await page.waitForFunction(() => performance.now() > window.fixtureFrames[0].time + 550);
  const beforeReply = await page.evaluate(() => window.fixtureFrames);
  assert.deepEqual(beforeReply.map(({ socket, frame }) => [socket, frame[2] * 256 + frame[3]]), [[0, 2816], [1, 2816]], 'old connection poll must not continue to next alias after timeout');
  await page.evaluate(() => window.replyDashboard(123));
  await page.waitForFunction(() => window.fixtureFrames.length === 3);
  const afterReply = await page.evaluate(() => window.fixtureFrames);
  assert.deepEqual(afterReply.map(({ socket, frame }) => [socket, frame[2] * 256 + frame[3]]), [[0, 2816], [1, 2816], [1, 2818]], 'new response handler survives old timeout and advances current poll');
  await page.getByText('123', { exact: true }).waitFor();
  await page.evaluate(() => { window.replyDashboard(999); window.fixtureSockets.at(-1).close(); });
  await page.waitForTimeout(50);
  const iq = page.locator('.wd-metric').filter({ has: page.locator('.wd-metric-label', { hasText: '电机电流' }) });
  assert.ok((await iq.innerText()).includes('--'), 'response resolved during disconnect cannot update stale dashboard values');
  const stopped = await page.evaluate(() => window.fixtureFrames.length);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.fixtureFrames.length), stopped, 'old loops send no further requests while disconnected');
  assert.deepEqual(errors, []);
  console.log('dashboard reconnect passed: <500ms reconnect, old loop/timeout isolated, live response retained, stale result discarded');
} finally { await browser.close(); server.close(); }
