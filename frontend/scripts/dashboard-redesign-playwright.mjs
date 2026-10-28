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
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"devices":[],"files":[]}'); return;
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.fixtureSockets = []; window.fixtureFrames = [];
    window.fixtureRead = true; window.fixtureWrite = 'echo'; window.fixtureSpeed = 900; window.fixtureBlockedAddress = null; window.fixtureMissedSpeed = 0;
    window.fixtureReply = (socket, bytes) => {
      let crc = 0xffff;
      for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
      socket.onmessage?.({ data: Uint8Array.from([...bytes, crc & 255, crc >>> 8]).buffer });
    };
    window.WebSocket = class {
      static OPEN = 1; static CLOSED = 3; readyState = 0;
      constructor() { window.fixtureSockets.push(this); }
      open() { this.readyState = 1; this.onopen?.({}); }
      close() { this.readyState = 3; this.onclose?.({}); }
      send(data) {
        const frame = Array.from(new Uint8Array(data));
        window.fixtureFrames.push(frame);
        const address = frame[2] * 256 + frame[3];
        if (frame[1] === 3 && address === 2816 && !window.fixtureRead) window.fixtureMissedSpeed++;
        if (frame[1] === 3 && window.fixtureRead && address !== window.fixtureBlockedAddress) {
          const value = ({ 2816: window.fixtureSpeed, 2818: 244, 2819: 125, 2820: 36, 2821: 3100, 2822: 0 })[address];
          if (value !== undefined) setTimeout(() => window.fixtureReply(this, [255, 3, 2, value >>> 8, value & 255]), 5);
        }
        if (frame[1] === 6 && (window.fixtureWrite === 'echo' || (window.fixtureWrite === 'speed-only' && address === 2561))) {
          setTimeout(() => window.fixtureReply(this, frame.slice(0, 6)), 5);
        }
        if (frame[1] === 6 && window.fixtureWrite === 'mismatch') {
          const wrong = frame.slice(0, 6); wrong[5] ^= 1;
          setTimeout(() => window.fixtureReply(this, wrong), 5);
        }
      }
    };
  });
  await page.goto(base + '/index.html');
  const nav = async label => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
  const button = name => page.getByRole('button', { name, exact: true });
  await nav('仪表盘');
  assert.equal(await button('实时监测').count(), 1, 'monitoring control uses reading-only name');
  assert.equal(await page.getByText('⚠️ 参数表未加载，仪表盘功能受限', { exact: true }).count(), 0, 'requested warning removed');
  assert.equal(await page.locator('.wd-dashboard-gauge').count(), 0, 'large gauge removed');
  assert.equal(await page.getByTestId('dashboard-speed').innerText(), '—', 'unknown speed is not zero');
  assert.equal(await page.locator('[data-testid="dashboard-trend"] path').count(), 0, 'no fabricated trend');
  const heading = await page.locator('.wd-page-heading').boundingBox();
  assert.ok(heading.height <= 60, 'compact heading');
  await page.locator('input[type=file][accept=".xlsx"]').setInputFiles({ name: 'empty.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a parameter table') });
  await page.getByRole('alert').filter({ hasText: '未找到有效参数' }).waitFor();
  await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(resolve('reference/ParameterTable.xlsx'));
  await page.getByText(/已加载 \d+ 项参数/).waitFor();
  assert.equal(await button('本地参数表').count(), 1, 'import remains after load');
  assert.equal(await page.getByRole('button', { name: /设备参数表/ }).isDisabled(), true, 'invalid target remote import guarded');
  await button('实时监测').click();
  assert.equal(await button('下发转速').isDisabled(), true, 'offline write guarded');
  await page.getByRole('spinbutton', { name: '目标转速', exact: true }).fill('600');
  await page.getByRole('spinbutton', { name: '目标转速', exact: true }).press('Enter');
  assert.deepEqual(await page.evaluate(() => window.fixtureFrames), [], 'offline keyboard sends no frames');
  await nav('连接设置');
  await button('自定义地址').click();
  await page.getByRole('textbox').first().fill(base.replace('http:', 'ws:') + '/ws');
  await button('连接').click();
  await page.evaluate(() => window.fixtureSockets.at(-1).open());
  await nav('仪表盘');
  await page.getByTestId('dashboard-speed').filter({ hasText: '900' }).waitFor();
  await page.getByTestId('dashboard-metric-MotorIq').filter({ hasText: '2.44' }).waitFor();
  await page.getByTestId('dashboard-metric-Vdc').filter({ hasText: '310.0' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dashboard-trend"] path').length > 0);
  assert.equal(await page.getByText('停机完成', { exact: true }).count(), 0, 'zero fault is not invented device state');
  const writes = async () => page.evaluate(() => window.fixtureFrames.filter(frame => frame[1] === 6));
  const speedInput = page.getByRole('spinbutton', { name: '目标转速', exact: true });
  await speedInput.fill('600');
  assert.equal((await writes()).length, 0, 'editing is local');
  await speedInput.press('Enter');
  await page.getByTestId('dashboard-command-result').filter({ hasText: '指令已应答' }).waitFor();
  assert.ok((await writes()).some(frame => frame[2] * 256 + frame[3] === 2561 && frame[4] * 256 + frame[5] === 600), 'keyboard command writes exact requested speed');
  assert.equal(await page.getByTestId('dashboard-speed').innerText(), '900', 'command does not replace feedback');
  await page.getByText('高级调试', { exact: true }).click();
  const currentInput = page.getByRole('spinbutton', { name: '电流指令', exact: true });
  assert.equal(await currentInput.getAttribute('step'), '0.01', 'current command precision accounts for 0.01A');
  assert.equal(await currentInput.getAttribute('max'), '3.3', 'current limit displayed in A');
  await currentInput.fill('0.33'); await currentInput.press('Enter');
  await page.waitForFunction(() => window.fixtureFrames.some(frame => frame[1] === 6 && frame[2] * 256 + frame[3] === 2562 && frame[4] * 256 + frame[5] === 33));
  await page.getByTestId('dashboard-command-result').filter({ hasText: '指令已应答' }).waitFor();
  await page.evaluate(() => { window.fixtureWrite = 'mismatch'; });
  await speedInput.fill('700'); await speedInput.press('Enter');
  await page.getByTestId('dashboard-command-result').filter({ hasText: /失败|超时/ }).waitFor();
  assert.equal(await page.getByTestId('dashboard-command-result').getAttribute('data-state'), 'error', 'mismatched reply cannot confirm');
  await page.evaluate(() => { window.fixtureWrite = 'speed-only'; });
  await button('停止').click();
  await page.getByTestId('dashboard-command-result').filter({ hasText: '转速归零已应答，电流归零失败' }).waitFor();
  await page.evaluate(() => { window.fixtureBlockedAddress = 2818; });
  await page.getByTestId('dashboard-metric-MotorIq').getByText('未更新', { exact: true }).waitFor();
  assert.ok((await page.getByTestId('dashboard-metric-MotorIq').innerText()).includes('2.44'), 'stale metric retains measured value');
  assert.equal(await page.getByTestId('dashboard-metric-Vdc').getByText('未更新', { exact: true }).count(), 0, 'healthy independent readings stay fresh');
  await page.evaluate(() => { window.fixtureBlockedAddress = null; });
  await page.evaluate(() => { window.fixtureWrite = 'echo'; window.fixtureRead = false; });
  await page.waitForFunction(() => window.fixtureMissedSpeed > 0);
  await page.waitForTimeout(600);
  await page.evaluate(() => { window.fixtureRead = true; window.fixtureSpeed = 1100; });
  await page.getByTestId('dashboard-speed').filter({ hasText: '1,100' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dashboard-trend"] path').length >= 2);
  await page.evaluate(() => { window.fixtureBlockedAddress = 2822; });
  await page.waitForTimeout(6100);
  const staleFault = await page.locator('.wd-speed-details > span').last().getByText('未更新', { exact: true }).count();
  assert.equal(await page.getByText('正在监测', { exact: true }).count(), 1, 'speed remains fresh while only fault reads time out');
  await page.screenshot({ path: '/tmp/gmcc-dashboard-redesign-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('高级调试', { exact: true }).click();
  await page.locator('.wd-main').evaluate(main => { main.scrollTop = 0; });
  const stop = await button('停止').boundingBox();
  assert.ok(stop.width >= 200 && stop.height >= 40 && stop.y + stop.height <= 844, 'mobile stop remains visible above trend');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.wd-main').scrollWidth > document.querySelector('.wd-main').clientWidth + 1), false, 'no horizontal overflow');
  const mobileTrend = await page.locator('.wd-trend-plot').evaluate(plot => {
    const card = plot.closest('.wd-dashboard-trend').getBoundingClientRect();
    const elements = [...plot.querySelectorAll('text')];
    const labels = elements.map(text => text.getBoundingClientRect());
    return { clientWidth: plot.clientWidth, scrollWidth: plot.scrollWidth,
      minTextHeight: Math.min(...labels.map(label => label.height)),
      contained: labels.every(label => label.left >= card.left + 2 && label.right <= card.right - 2 && label.top >= card.top && label.bottom <= card.bottom),
      outside: labels.flatMap((label, index) => label.left >= card.left + 2 && label.right <= card.right - 2 && label.top >= card.top && label.bottom <= card.bottom ? [] : [{ text: elements[index].textContent, leftInset: label.left - card.left, rightInset: card.right - label.right, topInset: label.top - card.top, bottomInset: card.bottom - label.bottom }]),
    };
  });
  assert.deepEqual({ staleFault, legible: mobileTrend.minTextHeight >= 10, noInnerScroll: mobileTrend.clientWidth === mobileTrend.scrollWidth },
    { staleFault: 1, legible: true, noInnerScroll: true }, `independent fault freshness and mobile trend legibility: ${JSON.stringify(mobileTrend)}`);
  assert.equal(mobileTrend.contained, true, `mobile axis labels stay within card bounds: ${JSON.stringify(mobileTrend.outside)}`);
  await page.screenshot({ path: '/tmp/gmcc-dashboard-redesign-mobile.png', fullPage: true });
  await page.locator('.wd-dashboard-trend').screenshot({ path: '/tmp/gmcc-dashboard-redesign-mobile-trend.png' });
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  assert.equal(await button('下发转速').isDisabled(), true, 'disconnect disables commands');
  await page.getByText('已断开', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'no runtime errors');
  console.log('dashboard redesign passed: truthful empty/real values, persistent imports, exact keyboard writes/unit conversion, ACK mismatch/partial stop, gaps and responsive layout');
} finally { await browser.close(); server.close(); }
