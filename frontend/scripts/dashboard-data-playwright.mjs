import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['scripts/dashboard-data-fixture.tsx'], bundle: true, write: false,
  format: 'iife', platform: 'browser', define: { 'import.meta.env': '{}' },
});
const module = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js').href);
const { chromium } = module.default || module;
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];
let passed = 0;
const settle = async (page, index = 0) => {
  await page.waitForFunction(i => window.results[i]?.state !== 'pending', index);
  return page.evaluate(i => window.results[i], index);
};
const frameCount = (page, count) => page.waitForFunction(n => window.socketFrames.length === n, count);
const setup = async (page, definitions = [{ alias: 'CmdSpd' }], enabled = false) => {
  await page.evaluate(({ definitions, enabled }) => {
    window.define(definitions); window.openConnection(); window.setEnabled(enabled);
  }, { definitions, enabled });
};
async function test(name, run) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => Boolean(window.write));
    await run(page);
    assert.deepEqual(errors, [], 'no uncaught errors or abandoned rejected waits');
    console.log(`PASS ${name}`); passed++;
  } catch (error) {
    failures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`);
  } finally { await page.close(); }
}

try {
  await test('offline command rejects instead of claiming acknowledgement', async page => {
    await page.evaluate(() => { window.define([{ alias: 'CmdSpd' }]); window.write('CmdSpd', 100); });
    assert.equal((await settle(page)).state, 'rejected');
    assert.equal(await page.evaluate(() => window.socketFrames.length), 0);
  });
  await test('invalid writes reject without sending', async page => {
    await setup(page, [
      { alias: 'ReadOnly', readOnly: true }, { alias: 'Float', isFloat: true },
      { alias: 'CmdSpd' }, { alias: 'Overflow', max: 100000 },
    ]);
    await page.evaluate(() => {
      window.write('Missing', 10); window.write('ReadOnly', 10); window.write('Float', 10);
      window.write('CmdSpd', NaN); window.write('CmdSpd', Infinity);
      window.write('CmdSpd', 1301); window.write('Overflow', 70000);
    });
    for (let i = 0; i < 7; i++) assert.equal((await settle(page, i)).state, 'rejected', `invalid write ${i}`);
    assert.equal(await page.evaluate(() => window.socketFrames.length), 0);
  });
  await test('only exact write address/value/CRC echo acknowledges; no optimistic cache', async page => {
    await setup(page);
    await page.evaluate(() => window.write('CmdSpd', 600));
    await frameCount(page, 1);
    await page.evaluate(() => {
      window.read([600]); window.emit([255, 6, 1, 2, 2, 88]);
      window.emit([255, 6, 1, 1, 2, 89]); window.emit([255, 6, 1, 1, 2, 88], true);
    });
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => window.results[0].state), 'pending');
    assert.equal(await page.evaluate(() => window.storeValues().CmdSpd), undefined);
    await page.evaluate(() => window.echo(window.socketFrames[0].frame));
    assert.equal((await settle(page)).state, 'resolved');
    assert.equal(await page.evaluate(() => window.storeValues().CmdSpd), undefined);
  });
  await test('send throw is handled without orphan wait rejection', async page => {
    await setup(page);
    await page.evaluate(() => { window.throwSend = true; window.write('CmdSpd', 10); });
    assert.equal((await settle(page)).state, 'rejected');
    await page.waitForTimeout(550);
  });
  await test('write timeout rejects', async page => {
    await setup(page);
    await page.evaluate(() => window.write('CmdSpd', 10));
    assert.equal((await settle(page)).state, 'rejected');
  });
  await test('successful same-value reads keep distinct receipt timestamps', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }], true);
    await frameCount(page, 1);
    const before = Date.now();
    await page.evaluate(() => window.read([123]));
    await page.waitForTimeout(30);
    const first = await page.evaluate(() => window.snapshot());
    assert.equal(first.readings.MotorSpd?.value, 123);
    assert.ok(first.readings.MotorSpd.receivedAt >= before);
    await frameCount(page, 2);
    await page.evaluate(() => window.read([123]));
    await page.waitForTimeout(30);
    const samples = await page.evaluate(() => window.snapshot().speedHistory);
    assert.equal(samples.length, 2);
    assert.deepEqual(samples.map(point => point.value), [123, 123]);
    assert.ok(samples[1].receivedAt > samples[0].receivedAt);
  });
  await test('bad CRC, wrong register count and non-finite float never become readings', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816, isFloat: true }], true);
    await frameCount(page, 1);
    await page.evaluate(() => { window.read([123]); window.read([0x3f80, 0], true); window.read([0x7fc0, 0]); });
    await page.waitForTimeout(550);
    assert.deepEqual(await page.evaluate(() => window.snapshot().readings), {});
    assert.equal(await page.evaluate(() => window.storeValues().MotorSpd), undefined);
  });
  await test('timeout and pause create gaps without copying last measurement', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }], true);
    await frameCount(page, 1); await page.evaluate(() => window.read([321]));
    await frameCount(page, 2); await page.waitForTimeout(550);
    let snapshot = await page.evaluate(() => window.snapshot());
    assert.equal(snapshot.readings.MotorSpd?.value, 321);
    assert.deepEqual(snapshot.speedHistory.map(point => point.value), [321, null]);
    await page.evaluate(() => window.setEnabled(false));
    await page.waitForTimeout(30);
    snapshot = await page.evaluate(() => window.snapshot());
    assert.deepEqual(snapshot.speedHistory.map(point => point.value), [321, null]);
  });
  await test('pause after success preserves reading and appends a gap', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }], true);
    await frameCount(page, 1); await page.evaluate(() => window.read([321]));
    await page.waitForTimeout(30); await page.evaluate(() => window.setEnabled(false));
    await page.waitForTimeout(30);
    const snapshot = await page.evaluate(() => window.snapshot());
    assert.equal(snapshot.readings.MotorSpd?.value, 321);
    assert.deepEqual(snapshot.speedHistory.map(point => point.value), [321, null]);
  });
  await test('table replacement and target change clear readings, reject stale pending write', async page => {
    await setup(page, [{ alias: 'MotorSpd', regAddr: 2816 }, { alias: 'CmdSpd' }], true);
    await frameCount(page, 1); await page.evaluate(() => window.read([321]));
    await page.waitForTimeout(30); await page.evaluate(() => { window.setEnabled(false); window.write('CmdSpd', 600); });
    await frameCount(page, 2);
    await page.evaluate(() => { window.define([{ alias: 'CmdSpd', regAddr: 258 }]); window.echo(window.socketFrames[1].frame); });
    assert.equal((await settle(page)).state, 'rejected');
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => window.snapshot()), { readings: {}, speedHistory: [] });
    await page.evaluate(() => window.openConnection('ws://127.0.0.1/device-b'));
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => window.snapshot()), { readings: {}, speedHistory: [] });
  });
  await test('polling and command use one hook-local transaction at a time', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }, { alias: 'CmdSpd' }], true);
    await frameCount(page, 1); await page.evaluate(() => window.write('CmdSpd', 600));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.socketFrames.length), 1);
    await page.evaluate(() => window.read([321])); await frameCount(page, 2);
    assert.equal(await page.evaluate(() => window.socketFrames[1].frame[1]), 6);
    await page.evaluate(() => window.echo(window.socketFrames[1].frame));
    assert.equal((await settle(page)).state, 'resolved');
  });
  await test('history prunes measurements older than sixty seconds', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }], true);
    await frameCount(page, 1); await page.evaluate(() => window.read([321]));
    await page.waitForTimeout(30); await page.evaluate(() => { window.dateOffset = 61000; });
    await frameCount(page, 2); await page.evaluate(() => window.read([456]));
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => window.snapshot().speedHistory.map(point => point.value)), [456]);
  });
  await test('same-tick reconnect restarts polling and inserts a gap in retained history', async page => {
    await setup(page, [{ alias: 'MotorSpd', readOnly: true, regAddr: 2816 }], true);
    await frameCount(page, 1); await page.evaluate(() => window.read([123]));
    await page.waitForTimeout(30);
    await page.evaluate(() => { window.disconnect(); window.openConnection(); });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.socketFrames.length), 2, 'new generation starts without old1000ms timer');
    assert.deepEqual(await page.evaluate(() => window.snapshot().speedHistory.map(point => point.value)), [123, null]);
    await page.evaluate(() => window.read([456])); await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => window.snapshot().speedHistory.map(point => point.value)), [123, null, 456]);
  });
  await test('queued commands cannot survive a connection or table identity change', async page => {
    await setup(page);
    await page.evaluate(() => { window.write('CmdSpd', 100); window.write('CmdSpd', 200); });
    await frameCount(page, 1);
    await page.evaluate(() => { window.disconnect(); window.openConnection(); window.echo(window.socketFrames[0].frame); });
    assert.equal((await settle(page, 0)).state, 'rejected');
    assert.equal((await settle(page, 1)).state, 'rejected');
    assert.equal(await page.evaluate(() => window.socketFrames.length), 1);
    await page.evaluate(() => { window.write('CmdSpd', 300); window.write('CmdSpd', 400); });
    await frameCount(page, 2);
    await page.evaluate(() => { window.define([{ alias: 'CmdSpd' }]); window.echo(window.socketFrames[1].frame); });
    assert.equal((await settle(page, 2)).state, 'rejected');
    assert.equal((await settle(page, 3)).state, 'rejected');
    assert.equal(await page.evaluate(() => window.socketFrames.length), 2);
  });
  await test('pausing monitoring does not cancel an explicit command', async page => {
    await setup(page, [{ alias: 'CmdSpd' }], true);
    await page.evaluate(() => window.write('CmdSpd', 0)); await frameCount(page, 1);
    await page.evaluate(() => { window.setEnabled(false); window.echo(window.socketFrames[0].frame); });
    assert.equal((await settle(page)).state, 'resolved');
  });
  await test('unrepresentable precision rejects rather than silently rounding the command', async page => {
    await setup(page);
    await page.evaluate(() => window.write('CmdSpd', 0.1));
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.socketFrames.length), 0);
    assert.equal((await settle(page)).state, 'rejected');
    await page.evaluate(() => { window.define([{ alias: 'CmdSpd', decimals: 2 }]); window.write('CmdSpd', 0.29); });
    await frameCount(page, 1);
    assert.deepEqual(await page.evaluate(() => window.socketFrames[0].frame.slice(4, 6)), [0, 29]);
    await page.evaluate(() => window.echo(window.socketFrames[0].frame));
    assert.equal((await settle(page, 1)).state, 'resolved');
  });
  console.log(`dashboard data regression: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
