import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['scripts/dashboard-command-fixture.tsx'], bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser', define: { 'import.meta.env': '{}' } });
const module = await import(pathToFileURL('/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js').href);
const { chromium } = module.default || module;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/fixture.js' ? 'text/javascript' : 'text/html' });
  res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];
let passed = 0;
async function test(name, run) {
  const page = await browser.newPage(); const errors = []; page.setDefaultTimeout(3000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(origin); await page.waitForFunction(() => !!window.setup);
    await page.evaluate(() => window.setup());
    await run(page);
    assert.deepEqual(errors, []); passed++; console.log('PASS ' + name);
  } catch (error) { failures.push(name + ': ' + error.message); console.error('FAIL ' + name + ': ' + error.message); }
  finally { await page.close(); }
}
try {
  await test('parameter parsing cannot upload or commit into a synchronously changed target', async page => {
    const posts = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    await page.evaluate(() => { window.connect(`ws://${location.host}/ws/device/original`); window.switchDuringFileLoad(); });
    await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(resolve('reference/ParameterTable.xlsx'));
    await page.waitForTimeout(250);
    assert.deepEqual(posts, [], 'old parsed file cannot upload against new cloud target');
    assert.deepEqual(await page.evaluate(() => window.parameterAliases()), ['CmdSpd', 'CmdTorq', 'CmdMode'], 'old parsed table cannot replace new target definitions');
  });
  await test('normal speed control rejects reverse commands even for forced submit', async page => {
    const input = page.getByRole('spinbutton', { name: '目标转速', exact: true });
    assert.equal(await input.getAttribute('min'), '0');
    await input.fill('-100');
    await input.evaluate(element => element.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.waitForTimeout(40);
    assert.deepEqual(await page.evaluate(() => window.frames), []);
  });
  await test('same-tick reconnect clears acknowledged mode and prior command result', async page => {
    await page.getByText('高级调试', { exact: true }).click();
    await page.getByRole('button', { name: '转速模式', exact: true }).click();
    await page.waitForFunction(() => window.frames.length === 1); await page.evaluate(() => window.echo(0));
    await page.getByTestId('dashboard-command-result').filter({ hasText: '指令已应答' }).waitFor();
    await page.evaluate(() => window.connect());
    await page.waitForTimeout(30);
    assert.equal(await page.getByRole('button', { name: '转速模式', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByTestId('dashboard-command-result').count(), 0);
  });
  for (const kind of ['target', 'table']) for (const depth of [0, 1, 2, 3, 4]) {
    await test(`stop never continues into changed ${kind} at microtask ${depth}`, async page => {
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await page.waitForFunction(() => window.frames.length === 1);
      await page.evaluate(({ depth, kind }) => window.switchAfterEcho(depth, kind), { depth, kind });
      await page.waitForTimeout(100);
      const frames = await page.evaluate(() => window.frames);
      assert.equal(frames.filter(item => item.frame[2] * 256 + item.frame[3] === 2562).length, 0, JSON.stringify(frames));
      assert.equal(await page.getByTestId('dashboard-command-result').count(), 0, 'old session result discarded');
    });
  }
  console.log(`dashboard command contexts: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
} finally { await browser.close(); server.close(); }
