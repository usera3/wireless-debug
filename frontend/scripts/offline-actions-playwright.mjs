import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';
const module = await import(pathToFileURL(runner).href);
const { chromium } = module.default || module;
const root = resolve('dist');
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.includes('/api/')) {
    requests.push({ path: url.pathname, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, devices: [], files: [], sta_configured: true, mode: 'sta', sta_connected: true }));
    return;
  }
  const file = url.pathname.split('/').pop() || 'index.html';
  try {
    let body = readFileSync(join(root, file === 'i.html' ? 'index.html' : file));
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
  const attempts = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    if (route.request().url().includes('/api/')) attempts.push(route.request().url());
    return new URL(route.request().url()).origin === base ? route.continue() : route.abort();
  });
  // Replace only the I/O boundary. No store or production module is exposed to tests.
  await page.addInitScript(() => {
    localStorage.setItem('wireless_debug_ws_url', 'ws://saved.invalid/ws');
    window.fixtureSockets = [];
    window.fixtureSends = [];
    class Socket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      constructor(url) { this.url = url; window.fixtureSockets.push(this); }
      open() { this.readyState = 1; this.onopen?.({}); }
      close() { this.readyState = 3; this.onclose?.({}); }
      send(data) { window.fixtureSends.push(Array.from(new Uint8Array(data))); }
    }
    window.WebSocket = Socket;
  });
  await page.goto(base + (process.env.OFFLINE_RED_LOCAL ? '/orig/i.html' : '/index.html'));
  const nav = async label => {
    await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
  };
  const button = name => page.getByRole('button', { name, exact: true });
  const disabled = async (control, why) => assert.equal(await control.isDisabled(), true, why);
  const forcedClick = async control => control.evaluate(el => { el.disabled = false; el.click(); });
  await nav('参数编辑');
  await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(resolve('reference/ParameterTable.xlsx'));
  await page.getByRole('cell', { name: 'POLEPAIRS_BASE', exact: true }).waitFor();
  const row = page.locator('tbody tr').filter({ hasText: 'POLEPAIRS_BASE' });
  const pending = row.locator('input');
  await pending.fill('7');
  await disabled(row.getByRole('button', { name: '读', exact: true }), 'offline row read disabled');
  await disabled(row.getByRole('button', { name: '写', exact: true }), 'offline row write disabled');
  await pending.press('Enter');
  await forcedClick(row.getByRole('button', { name: '读', exact: true }));
  await forcedClick(row.getByRole('button', { name: '写', exact: true }));
  assert.equal(await pending.inputValue(), '7', 'pending edits remain local');
  assert.equal((await row.locator('td').nth(3).innerText()).trim(), '--', 'offline Enter cannot optimistically change device value');
  await disabled(button('当前页'), 'offline batch page read disabled');
  await disabled(button('所有页'), 'offline batch all read disabled');
  await forcedClick(button('所有页'));
  if (!process.env.OFFLINE_RED_LOCAL) await disabled(page.getByRole('button', { name: /设备参数表/ }), 'no target file picker disabled');
  for (const label of ['地址示波器', '参数示波器']) {
    await nav(label);
    await disabled(page.getByRole('button', { name: /开始/ }), label + ' start disabled');
  }
  await nav('仪表盘');
  await button('实时监测').click();
  await page.getByText('高级调试', { exact: true }).click();
  for (const name of ['停止', '转速模式', '转矩模式', '下发转速', '下发电流']) {
    await disabled(button(name), 'offline dashboard ' + name);
    await forcedClick(button(name));
  }
  const speedDraft = page.getByRole('spinbutton', { name: '目标转速', exact: true });
  assert.equal(await speedDraft.isEditable(), true, 'offline numeric draft remains local');
  await speedDraft.fill('600');
  await speedDraft.press('Enter');
  assert.equal(await page.getByTestId('dashboard-speed').innerText(), '—', 'offline keyboard cannot optimistically update feedback');
  await nav('固件烧录');
  const quickOps = ['进入 Bootloader 模式', '跳转到应用程序', '查看 MCU 信息', '擦除 Flash...'];
  for (const name of quickOps) {
    await disabled(button(name), 'offline boot action ' + name);
    await forcedClick(button(name));
  }
  assert.equal(await page.getByRole('heading', { name: '擦除 Flash', exact: true }).count(), 0, 'offline erase cannot open an actionable dialog');
  assert.equal(await page.getByRole('button', { name: /解析固件/ }).isEnabled(), true, 'firmware parsing available');
  assert.equal(await page.locator('input[type=radio]').first().isEnabled(), true, 'firmware format editable');
  await page.locator('input[type=file][accept=".hex2"]').setInputFiles({
    name: 'offline.hex2', mimeType: 'text/plain',
    buffer: Buffer.from('@HEX2 version=1\n@SEGMENT name=low target=cpu1 addr-unit=word16 combine=pair-low\n:020000000102FB\n:00000001FF\n@SEGMENT name=high target=cpu1 addr-unit=word16 combine=pair-high\n:020000000304F7\n:00000001FF\n'),
  });
  await page.getByRole('button', { name: /解析固件/ }).click();
  await page.getByText('✓ 已加载：cpu1', { exact: true }).waitFor();
  await disabled(page.getByRole('button', { name: /开始烧录/ }), 'parsed firmware still cannot flash offline');
  await forcedClick(page.getByRole('button', { name: /开始烧录/ }));
  await nav('连接设置');
  await button('编辑 JSON').click();
  assert.equal(await page.locator('textarea').isEditable(), true, 'GUI config editable');
  await button('取消').click();
  assert.equal(await page.getByRole('button', { name: /导入 gui-config/ }).isEnabled(), true, 'config import available');
  assert.equal(await button('导出').isEnabled(), true, 'config export available');
  const openBaudPicker = async () => {
    await button('更多波特率').click();
    return page.getByRole('heading', { name: '⚙️ UART1 波特率设置', exact: true }).locator('..');
  };
  const assertOfflineBaudPicker = async (dialog, reason) => {
    const input = dialog.getByPlaceholder('输入任意波特率（1200 ~ 5000000）');
    assert.equal(await input.isEditable(), true, reason + ' local baud value editable');
    await input.fill('57600');
    await disabled(dialog.getByRole('button', { name: '✅ 应用', exact: true }), reason + ' baud dialog apply disabled');
    const before = requests.filter(r => r.method === 'POST').length;
    await input.press('Enter');
    await forcedClick(dialog.getByRole('button', { name: '✅ 应用', exact: true }));
    await page.waitForTimeout(50);
    assert.equal(requests.filter(r => r.method === 'POST').length, before, reason + ' baud dialog handlers send no writes');
  };
  const noTargetBaud = await openBaudPicker();
  await assertOfflineBaudPicker(noTargetBaud, 'no target');
  await noTargetBaud.getByRole('button', { name: '✕ 关闭', exact: true }).click();
  await disabled(button('连接'), 'empty target cannot connect');
  await button('自定义地址').click();
  assert.equal(await page.getByRole('textbox').first().inputValue(), '', 'production default URL cannot populate cloud platform target');
  await page.waitForTimeout(3300);
  assert.deepEqual(await page.evaluate(() => window.fixtureSockets.length), 0, 'platform never auto-connects');
  assert.ok(requests.every(r => r.path === '/api/devices'), 'no target browsing dispatches no device HTTP calls: ' + JSON.stringify(requests));
  assert.ok(attempts.every(url => new URL(url).pathname === '/api/devices'), 'no target browsing attempts no external device HTTP calls: ' + JSON.stringify(attempts));
  assert.deepEqual(await page.evaluate(() => window.fixtureSends), [], 'offline browsing sends no frames');
  // Give the real UI a valid manual target and drive its socket open/close callbacks.
  await page.getByRole('textbox').first().fill(base.replace('http:', 'ws:') + '/ws');
  const baudReadsBefore = requests.filter(r => r.path === '/api/uart/baud' && r.method === 'GET').length;
  const disconnectedBaud = await openBaudPicker();
  await assertOfflineBaudPicker(disconnectedBaud, 'valid disconnected target');
  assert.ok(requests.filter(r => r.path === '/api/uart/baud' && r.method === 'GET').length > baudReadsBefore, 'valid disconnected target retains read-only baud query');
  await disconnectedBaud.getByRole('button', { name: '✕ 关闭', exact: true }).click();
  assert.equal(await button('连接').isEnabled(), true, 'manual connection setup available');
  await button('连接').click();
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await page.locator('.wd-connection').filter({ hasText: '已连接' }).waitFor();
  const comm = page.getByRole('button', { name: 'AUTO', exact: true });
  assert.equal(await comm.isEnabled(), true, 'device mutations enabled after socket open');
  const liveBaud = await openBaudPicker();
  await liveBaud.getByPlaceholder('输入任意波特率（1200 ~ 5000000）').fill('57600');
  assert.equal(await liveBaud.getByRole('button', { name: '✅ 应用', exact: true }).isEnabled(), true, 'connected baud dialog apply enabled');
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  await assertOfflineBaudPicker(liveBaud, 'open dialog after transport close');
  await liveBaud.getByRole('button', { name: '✕ 关闭', exact: true }).click();
  await page.waitForFunction(() => window.fixtureSockets.at(-1).readyState === 0);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await nav('参数编辑');
  assert.equal(await row.getByRole('button', { name: '读', exact: true }).isEnabled(), true, 'read enabled reactively');
  await button('所有页').click();
  const cancelBatch = page.getByRole('button', { name: /^\d+\/\d+$/ });
  await cancelBatch.waitFor();
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  assert.equal(await cancelBatch.isEnabled(), true, 'batch cancellation remains usable after disconnect');
  await cancelBatch.click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await nav('仪表盘');
  assert.equal(await button('停止').isEnabled(), true, 'dashboard enabled reactively');
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  await disabled(button('停止'), 'mounted dashboard disables on transport close');
  await page.waitForTimeout(650);
  const pausedPolls = await page.evaluate(() => window.fixtureSends.length);
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.fixtureSends.length), pausedPolls, 'mounted dashboard stops timer-driven polling');
  await page.waitForFunction(() => window.fixtureSockets.at(-1).readyState === 0);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await page.waitForFunction(count => window.fixtureSends.length > count, pausedPolls);
  assert.equal(await button('停止').isEnabled(), true, 'mounted dashboard resumes reactively');
  await nav('固件烧录');
  await page.getByRole('button', { name: /开始烧录/ }).click();
  const stopFlash = page.getByRole('button', { name: /⏹ 停止/ });
  await stopFlash.waitFor();
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  assert.equal(await stopFlash.isEnabled(), true, 'flash cancellation remains usable after disconnect');
  await stopFlash.click();
  await page.waitForFunction(() => window.fixtureSockets.at(-1).readyState === 0);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await button('擦除 Flash...').click();
  await button('执行擦除').waitFor();
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  await disabled(button('执行擦除'), 'open erase dialog disables on disconnect');
  const sends = await page.evaluate(() => window.fixtureSends.length);
  const posts = requests.filter(r => r.method === 'POST').length;
  await forcedClick(button('执行擦除'));
  await button('取消').click();
  for (const name of quickOps) await disabled(button(name), 'boot disables reactively');
  await nav('仪表盘');
  await disabled(button('停止'), 'dashboard disables reactively');
  await page.waitForTimeout(1300);
  assert.equal(await page.evaluate(() => window.fixtureSends.length), sends, 'dashboard polling stops on disconnect');
  await nav('参数编辑');
  await disabled(row.getByRole('button', { name: '读', exact: true }), 'read disables reactively');
  await nav('连接设置');
  await disabled(comm, 'device mutations disable reactively');
  for (const name of ['AUTO', 'WIFI', 'BLE', '启动 BLE', '连接外部 WiFi', '断开外部 WiFi', '115,200']) {
    await disabled(button(name), 'offline mutation ' + name);
    await forcedClick(button(name));
  }
  await page.getByPlaceholder('自定义波特率').fill('57600');
  await page.getByPlaceholder('自定义波特率').press('Enter');
  await disabled(button('应用'), 'custom baud apply disabled');
  await forcedClick(button('应用'));
  assert.equal(requests.filter(r => r.method === 'POST').length, posts, 'offline mutation handlers send no HTTP writes');
  assert.equal(await page.evaluate(() => window.fixtureSends.length), sends, 'offline handlers send no frames');
  await nav('参数编辑');
  await page.waitForFunction(() => window.fixtureSockets.at(-1).readyState === 0);
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await button('所有页').click();
  await page.evaluate(() => {
    const request = window.fixtureSends.at(-1);
    const count = request[4] * 256 + request[5];
    const response = [255, 3, count * 2, ...Array(count * 2).fill(0)];
    let crc = 0xffff;
    for (const byte of response) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    response.push(crc & 255, crc >>> 8);
    const socket = window.fixtureSockets.at(-1);
    socket.onmessage({ data: Uint8Array.from(response).buffer });
    socket.close();
  });
  await button('所有页').waitFor();
  assert.equal(await page.getByText(/所有页已读取/).count(), 0, 'partial batch interrupted by disconnect must not claim all pages read');
  assert.deepEqual(errors, [], 'no runtime errors');
  await page.close();
  for (const [entry, expected, remote] of [
    ['/orig/i.html', 'ws://saved.invalid/ws', false],
    ['/remote/context/orig/i.html', base.replace('http:', 'ws:') + '/ws/device/injected', true],
  ]) {
    const context = await browser.newPage();
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(({ remote, expected }) => {
      localStorage.setItem('wireless_debug_ws_url', 'ws://saved.invalid/ws');
      if (remote) {
        window.__WIRELESS_REMOTE_DEVICE_ID = 'injected';
        window.__WIRELESS_REMOTE_WS_URL = expected;
      }
      window.WebSocket = class { static OPEN = 1; static CLOSED = 3; readyState = 0; close() {} };
    }, { remote, expected });
    await context.goto(base + entry);
    await context.getByRole('button', { name: '连接设置', exact: true }).click();
    await context.getByRole('button', { name: '自定义地址', exact: true }).click();
    assert.equal(await context.getByRole('textbox').first().inputValue(), expected, remote ? 'injected remote target takes priority over saved and production defaults' : 'local runtime retains saved target priority');
    await context.close();
  }
  console.log('offline actions passed: offline browsing/local editing, zero invalid-target traffic, handler guards and reactive transport open/close');
} finally { await browser.close(); server.close(); }
