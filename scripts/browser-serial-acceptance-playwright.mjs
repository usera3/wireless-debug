// Software OS-port simulation, never evidence of real USB/MCU validation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { installBrowserSerialFixture } from './browser-serial-fixture.mjs';

import { chromium } from './browser-test-runtime.mjs';
const staticRoot = process.env.STATIC_DIST && resolve(process.env.STATIC_DIST);
let server;
if (staticRoot) {
  server = createServer(async (request, response) => {
    const path = resolve(staticRoot, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!path.startsWith(staticRoot + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}
const frontend = new URL(staticRoot ? `http://127.0.0.1:${server.address().port}/index.html` : process.env.WEB_URL || 'http://127.0.0.1:5679/index.html');
const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
const tests = [];
const test = (name, run, sourceOnly = false) => tests.push({ name, run, sourceOnly });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const tab = (page, name) => page.getByRole('button', { name: new RegExp(name) }).first().click();
const fixture = (page, fn, arg) => page.evaluate(fn, arg);
const source = (page, path, action) => page.evaluate(async ({ path, action }) => {
  const resource = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)?.name;
  return Function('module', `return (${action})(module)`)(await import(resource || path));
}, { path, action: String(action) });
async function connect(page) {
  await tab(page, '连接设置');
  await click(page, '选择并授权串口');
  await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
}
async function released(page, closes) {
  await page.waitForFunction(closes => __serialFixture.closes === closes && __serialFixture.ports.every(port => !port.readable?.locked && !port.writable?.locked), closes);
}

test('serial osc banner shows the selected transport and actual connection state', async page => {
  await tab(page, '地址示波器');
  await page.getByText('浏览器串口直连', { exact: true }).waitFor();
  await page.getByText('串口未连接', { exact: true }).waitFor();
  assert.equal(await page.getByText('通信地址无效', { exact: true }).count(), 0);
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
  await connect(page);
  await tab(page, '地址示波器');
  await page.getByText('串口已连接', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await released(page, 1);
  await page.getByText('串口未连接', { exact: true }).waitFor();
  assert.equal(await page.getByText('通信地址无效', { exact: true }).count(), 0);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.getByText('串口已连接', { exact: true }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.opens), 2);
  await tab(page, '连接设置'); await click(page, '断开串口'); await released(page, 2);
});

// Narrow protocol replies derived from the historical waveform/bootloader
// diagnostics. Only port writes/reads are simulated; app protocols stay real.
async function protocol(page, mode) {
  await fixture(page, mode => {
    const f = __serialFixture;
    f.protocol = { mode, trace: [], flashWrites: [], errors: [] };
    const crc = data => {
      let value = 0xffff;
      for (const byte of data) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xa001 : 0);
      }
      return value;
    };
    const withCrc = data => [...data, crc(data) & 255, crc(data) >>> 8];
    f.onWrite = (bytes, port) => {
      const p = f.protocol;
      if (crc(bytes.slice(0, -2)) !== (bytes.at(-2) | bytes.at(-1) << 8)) { p.errors.push('Invalid request CRC'); return; }
      const fc = bytes[1]; p.trace.push(fc);
      if (p.silent === fc) return;
      let response;
      if (mode === 'waveform') {
        if (fc === 4) {
          const value = { 0: 130, 1: 12, 2: 1000 }[bytes[2] << 8 | bytes[3]];
          if (value === undefined) { p.errors.push('Unexpected capability register'); return; }
          response = withCrc([255, 4, 2, value >>> 8, value & 255]);
        } else if ([0x72, 0x75, 0x71, 0x08, 0x73].includes(fc)) response = bytes;
      } else {
        let payload = [];
        if (fc === 0x66) {
          if (!bytes.slice(2, 10).every(byte => byte === 255)) p.errors.push('Unexpected erase range');
          payload = [0, 8, 0, 0, 0, 1, 0, 0];
        } else if (fc === 0x67) {
          const view = new DataView(new Uint8Array(bytes).buffer);
          const length = view.getUint16(6, false);
          if (length !== bytes.length - 10) p.errors.push('Incorrect write size');
          p.flashWrites.push({ address: view.getUint32(2, false), bytes: bytes.slice(8, -2) });
          payload = [length >>> 8, length & 255];
        } else if (![0x65, 0x68, 0x6a, 0x69].includes(fc)) { p.errors.push(`Unexpected bootloader function ${fc}`); return; }
        response = withCrc([255, fc, 0, ...payload]);
      }
      if (!response) { p.errors.push(`Unexpected function ${fc}`); return; }
      f.receive(response, [1, 2, 1, 3], port);
    };
  }, mode);
}

function crc(data) {
  let value = 0xffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xa001 : 0);
  }
  return value;
}
function waveFrames() {
  const expected = Array.from({ length: 300 }, (_, i) => [i - 150, 1000 - i * 2, i % 2 ? -32768 : 32767, (i % 5) * 101]);
  const bytes = [];
  for (let first = 0; first < expected.length; first += 15) {
    const payload = expected.slice(first, first + 15).flatMap(row => row.flatMap(value => [(value >> 8) & 255, value & 255]));
    const check = crc(payload);
    bytes.push(255, 119, 170, 85, ...payload, check & 255, check >>> 8, 255, 119, 170, 85, 0);
  }
  return { bytes, expected };
}
function record(address, kind, data) {
  const bytes = [data.length, address >>> 8, address & 255, kind, ...data];
  return ':' + Buffer.from([...bytes, -bytes.reduce((sum, byte) => sum + byte, 0) & 255]).toString('hex').toUpperCase();
}
const firmwareBytes = [0, 255, 13, 10, 128, 127, 1, 254, 32, 64, 96, 192, 3, 7, 11, 15];
const firmware = '@HEX2 version=1\n' + ['low', 'high'].map((role, offset) =>
  `@SEGMENT name=cpu1-${role} target=cpu1 addr-unit=word16 combine=pair-${role}\n` +
  [record(0, 4, [0, 8]), record(0, 0, firmwareBytes.filter((_, i) => i % 2 === offset)), ':00000001FF'].join('\n') + '\n',
).join('');
async function loadFirmware(page) {
  await tab(page, '固件烧录');
  await page.locator('input[name="firmware-format"][value="hex2"]').check();
  await page.locator('input[type="file"][accept=".hex2"]').setInputFiles({ name: 'boundary-only.hex2', mimeType: 'text/plain', buffer: Buffer.from(firmware) });
  await page.getByRole('button', { name: /解析固件/ }).click();
  await page.getByText('固件已加载', { exact: true }).waitFor();
}

test('raw binary roundtrip and three pending protocols abort on removal without replay', async page => {
  await connect(page);
  const raw = await source(page, '/src/lib/wsClient.ts', async ({ wsClient }) => {
    const received = []; const handler = bytes => received.push(...bytes);
    wsClient.onFrame(handler);
    wsClient.send(new Uint8Array([0, 255, 13, 10, 128]));
    __serialFixture.receive([0, 255, 13, 10, 128], [1, 2]);
    await new Promise(resolve => setTimeout(resolve, 10));
    wsClient.removeHandler(handler);
    return received;
  });
  assert.deepEqual(raw, [0, 255, 13, 10, 128]);
  assert.deepEqual(await fixture(page, () => __serialFixture.writes), [[0, 255, 13, 10, 128]]);
  await source(page, '/src/lib/modbusRequest.ts', ({ waitForMatchingModbusFrame }) => {
    window.__pendingModbus = waitForMatchingModbusFrame({ timeoutMs: 60000 }).then(() => 'resolved', error => error.name);
  });
  await source(page, '/src/lib/oscRequest.ts', async ({ waitForOscResponse }) => {
    const loaded = path => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path).name;
    const { frameRouter } = await import(loaded('/src/lib/frameRouter.ts'));
    const { wsClient } = await import(loaded('/src/lib/wsClient.ts'));
    const { buildQueryFrameLen } = await import(loaded('/src/lib/oscilloscope.ts'));
    window.__pendingOsc = waitForOscResponse({ request: buildQueryFrameLen(), timeoutMs: 60000, subscribe: frameRouter.subscribeModbusFrame.bind(frameRouter), send: bytes => wsClient.send(bytes) }).then(() => 'resolved', error => error.name);
  });
  await source(page, '/src/lib/blModbusClient.ts', ({ BlModbusClient }) => {
    window.__pendingBoot = new BlModbusClient(255, 60000).enterBootloaderMode().then(() => 'resolved', error => error.name);
  });
  await page.waitForFunction(() => __serialFixture.writes.length === 3);
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  assert.deepEqual(await page.evaluate(() => Promise.all([__pendingModbus, __pendingOsc, __pendingBoot])), ['AbortError', 'AbortError', 'AbortError']);
  await released(page, 1);
  const count = await fixture(page, () => __serialFixture.writes.length);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.opens), 2);
  assert.equal(await fixture(page, () => __serialFixture.writes.length), count);
  await click(page, '断开串口'); await released(page, 2);
}, true);

test('all serial pages stay offline; split waveform reaches real history, CSV and four rendered curves', async page => {
  await connect(page); await protocol(page, 'waveform');
  await page.getByRole('heading', { name: 'Wireless Debug' }).dblclick();
  for (const name of ['仪表盘', '参数示波器', '参数编辑', '固件烧录', '调试信息', '地址示波器']) {
    await tab(page, name);
    if (name === '参数编辑') {
      assert.equal(await page.getByRole('button', { name: /本地参数表/ }).count(), 1);
      assert.equal(await page.getByRole('button', { name: /设备参数表/ }).count(), 0);
    }
  }
  await page.getByRole('button', { name: /▶ 开始/ }).click();
  await page.waitForFunction(() => __serialFixture.protocol.trace.includes(0x71));
  const wave = waveFrames();
  assert.equal(wave.bytes.length, 20 * 131);
  await fixture(page, bytes => __serialFixture.receive(bytes, [1, 2, 3, 4, 37, 128, 511]), wave.bytes);
  await page.waitForTimeout(500);
  const colors = await page.locator('.uplot canvas').first().evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const expected = [[74, 222, 128], [96, 165, 250], [249, 115, 22], [232, 121, 249]];
    return expected.map(rgb => {
      let count = 0;
      for (let offset = 0; offset < data.length; offset += 4) if (rgb.every((value, index) => Math.abs(data[offset + index] - value) < 12) && data[offset + 3] > 100) count++;
      return count;
    });
  });
  assert.ok(colors.every(count => count > 10), `Four rendered channel colors: ${colors}`);
  await page.getByRole('button', { name: /■ 停止/ }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('▶ 开始')).disabled);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: /⬇ 导出/ }).click();
  const csv = await readFile(await (await downloadEvent).path(), 'utf8');
  const rows = csv.trim().split('\n').slice(1).map(row => row.split(',').map(Number));
  assert.deepEqual(rows.map(row => row.slice(1)), wave.expected, 'Exact 300 samples per channel survive arbitrary serial chunk boundaries');
  assert.deepEqual(rows.map(row => row[0]), wave.expected.map((_, i) => i / 1000));
  assert.deepEqual(await fixture(page, () => __serialFixture.protocol.errors), []);
  await tab(page, '连接设置'); await click(page, '断开串口'); await released(page, 1);
});

test('active waveform unplug stops acquisition; same port reconnects off-panel without replay, replacement stays manual', async page => {
  await connect(page); await protocol(page, 'waveform'); await tab(page, '地址示波器');
  await page.getByRole('button', { name: /▶ 开始/ }).click();
  await page.waitForFunction(() => __serialFixture.protocol.trace.includes(0x71));
  await fixture(page, () => __serialFixture.event('disconnect', 0)); await released(page, 1);
  assert.equal(await page.getByRole('button', { name: /■ 停止/ }).isDisabled(), true);
  const writes = await fixture(page, () => __serialFixture.writes.length);
  await fixture(page, () => { __serialFixture.event('connect', 0); __serialFixture.event('connect', 1); });
  await page.getByText('串口已连接', { exact: true }).waitFor();
  await page.waitForTimeout(1150);
  assert.equal(await fixture(page, () => __serialFixture.writes.length), writes, 'No stale heartbeat or automatic waveform restart');
  assert.equal(await fixture(page, () => __serialFixture.opens), 2);
  assert.equal(await fixture(page, () => __serialFixture.ports[1].readable), null, 'Another device is never automatically opened');
  await tab(page, '连接设置');
  await click(page, '断开串口'); await released(page, 2);
  // Changing to a different identity remains an explicit choice after disconnect.
  const select = page.getByLabel('已授权串口');
  await select.selectOption({ label: 'USB 串口 2（VID 1234 / PID 5602）' });
  await click(page, '连接串口'); await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.writes.length), writes);
  await tab(page, '地址示波器');
  assert.equal(await page.getByRole('button', { name: /■ 停止/ }).isDisabled(), true);
  await tab(page, '连接设置'); await click(page, '断开串口'); await released(page, 3);
});

test('tiny firmware uses exact bootloader bytes and bounded command sequence', async page => {
  await connect(page); await protocol(page, 'bootloader'); await loadFirmware(page);
  await page.getByRole('button', { name: /开始烧录/ }).click();
  await page.getByText('烧录完成', { exact: false }).first().waitFor();
  const receipt = await fixture(page, () => __serialFixture.protocol);
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.trace, [0x65, 0x66, 0x67, 0x68, 0x6a, 0x69]);
  assert.deepEqual(receipt.flashWrites, [{ address: 0x80000, bytes: firmwareBytes }]);
  assert.equal(await page.locator('div.bg-blue-600.transition-all.duration-150').evaluate(el => el.style.width), '100%');
  await tab(page, '连接设置'); await click(page, '断开串口'); await released(page, 1);
});

test('OS write rejection releases stream locks; original device return reconnects without replay', async page => {
  await connect(page);
  await fixture(page, () => { __serialFixture.writeError = 'Injected USB write failure'; });
  await tab(page, '地址示波器');
  await page.getByRole('button', { name: /▶ 开始/ }).click();
  await released(page, 1);
  await tab(page, '连接设置');
  await page.getByRole('alert').filter({ hasText: /Injected USB write failure/ }).waitFor();
  await page.getByText('等待串口重新接入', { exact: true }).waitFor();
  await fixture(page, () => { __serialFixture.writeError = ''; __serialFixture.event('connect', 0); });
  assert.equal(await fixture(page, () => __serialFixture.opens), 1);
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.deepEqual(await fixture(page, () => __serialFixture.writes), [], 'Rejected command is never replayed after reconnect');
  await click(page, '断开串口'); await released(page, 2);
});

test('unplug during pending flash aborts programming lock and never resumes on manual reconnect', async page => {
  await connect(page); await protocol(page, 'bootloader'); await loadFirmware(page);
  await fixture(page, () => { __serialFixture.protocol.silent = 0x67; });
  await page.getByRole('button', { name: /开始烧录/ }).click();
  await page.waitForFunction(() => __serialFixture.protocol.trace.includes(0x67));
  await fixture(page, () => __serialFixture.event('disconnect', 0)); await released(page, 1);
  await page.getByText(/烧录失败/).first().waitFor();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('开始烧录')).disabled);
  assert.deepEqual(await fixture(page, () => __serialFixture.protocol.trace), [0x65, 0x66, 0x67]);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.waitForTimeout(800);
  assert.equal(await fixture(page, () => __serialFixture.opens), 1, 'A programming loss must not automatically reopen the port');
  await tab(page, '连接设置');
  await page.getByLabel('已授权串口').selectOption({ label: 'USB 串口 1（VID 1234 / PID 5601）' });
  await click(page, '连接串口'); await page.getByText('串口传输已连接', { exact: true }).waitFor();
  await page.waitForTimeout(700);
  assert.deepEqual(await fixture(page, () => __serialFixture.protocol.trace), [0x65, 0x66, 0x67], 'No retry/flush/complete/jump/replay after the old generation aborts');
  await click(page, '断开串口'); await released(page, 2);
});

let executed = 0, failures = 0;
try {
  for (const { name, run, sourceOnly } of tests) {
    if (staticRoot && sourceOnly || process.env.TEST_MATCH && !name.includes(process.env.TEST_MATCH)) continue;
    executed++;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(installBrowserSerialFixture);
    const emitted = [], errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== frontend.origin || /\/(api|platform|remote)\//.test(url.pathname) || staticRoot && url.pathname.startsWith('/src/')) {
        emitted.push(url.href); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (staticRoot || !(url.host === frontend.host && url.pathname === '/' && url.searchParams.has('token'))) emitted.push(socket.url());
    });
    try {
      await page.goto(frontend.href, { timeout: 60000, waitUntil: 'domcontentloaded' });
      await run(page);
      assert.deepEqual(await fixture(page, () => __serialFixture.business), [], 'Zero business fetch/WebSocket attempts');
      assert.deepEqual(emitted, [], 'Zero emitted business API/WS requests');
      assert.deepEqual(errors, [], 'No uncaught page errors');
      console.log(`PASS ${name}`);
    } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
    finally { await context.close(); }
  }
} finally {
  await browser.close();
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
assert.ok(executed > 0, 'At least one acceptance case must run');
assert.equal(failures, 0, `${failures}/${executed} browser serial acceptance cases failed`);
console.log(`Browser serial acceptance: ${executed} passed (${staticRoot ? 'built static assets, static-only HTTP server' : 'Vite source'}, OS/Streams simulation; no hardware/backend)`);
