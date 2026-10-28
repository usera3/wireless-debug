import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';
const playwright = await import(pathToFileURL(runner).href);
const { chromium } = playwright.default || playwright;
const root = resolve(process.env.CONSOLE_DIST || 'dist');
const shots = resolve(process.env.CONSOLE_SCREENSHOTS || '/tmp/wd-console-ui');
mkdirSync(shots, { recursive: true });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/api/excel/list')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return;
  }
  if (url.pathname.includes('/api/') || url.pathname === '/excel') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, files: [], net_mode: 'ap', uart_baud: 115200, comm_mode: 'auto' }));
    return;
  }
  const file = url.pathname.split('/').pop() || 'index.html';
  try {
    const body = readFileSync(join(root, file === 'i.html' ? 'index.html' : file));
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const [mode, entry] of [['local', '/orig/i.html'], ['remote', '/remote/test-device/orig/i.html']]) {
    for (const width of [1440, 1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1024 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.goto(base + entry);
      assert.equal(await page.title(), 'GMCC · 设备调试台', 'product title');
      const nav = page.getByRole('navigation', { name: '设备导航', exact: true });
      await nav.waitFor();
      await nav.getByRole('button', { name: '参数编辑', exact: true }).click();
      await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(resolve('reference/ParameterTable.xlsx'));
      await page.getByRole('cell', { name: 'POLEPAIRS_BASE', exact: true }).waitFor();
      assert.equal(await page.locator('tbody tr').count(), 4, 'parameter workbook rows loaded');
      for (const [label, name] of [['仪表盘', 'dashboard'], ['地址示波器', 'address-osc'], ['参数示波器', 'parameter-osc'], ['参数编辑', 'parameters'], ['固件烧录', 'firmware'], ['连接设置', 'connection']]) {
        const button = nav.getByRole('button', { name: label, exact: true });
        await button.click();
        await page.locator('.wd-main').evaluate(main => { main.scrollTop = 0; });
        assert.equal(await button.getAttribute('aria-current'), 'page', `${label} selected navigation`);
        await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
        if (name === 'dashboard') {
          await page.getByRole('button', { name: '实时监测', exact: true }).click();
          assert.equal(await page.getByRole('button', { name: '实时监测', exact: true }).getAttribute('aria-pressed'), 'true');
          if (width === 390) {
            const stop = await page.getByRole('button', { name: '停止', exact: true }).boundingBox();
            assert.ok(stop && stop.width >= 200 && stop.height >= 40, 'mobile Stop has a full-width touch target');
            assert.ok(stop.y >= 60 && stop.y + stop.height <= 844, 'mobile Stop is visible without scrolling');
          }
        }
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(() => {
          const main = document.querySelector('.wd-main');
          return document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1;
        });
        if (overflow) console.error(await page.locator('.wd-main').evaluate(main => [...main.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > main.getBoundingClientRect().right + 1).slice(0, 12).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width }))));
        assert.equal(overflow, false, `${mode}/${label} overflows ${width}px viewport`);
        if (name === 'parameter-osc') {
          const file = page.locator('input[type=file][accept=".csv"]');
          await file.setInputFiles({ name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from('time_s,Speed,Current\n0,2300,2.4\n0.1,2400,2.5\n0.2,2500,2.6\n0.3,2400,2.5\n') });
          await page.locator('.uplot canvas').first().waitFor();
          assert.ok(await page.getByText('Speed', { exact: true }).count(), 'CSV channel renders in chart');
        }
        if (name === 'parameters') {
          const search = page.getByPlaceholder(/搜索/);
          await search.fill('POLEPAIRS_BASE');
          assert.equal(await page.locator('tbody tr').count(), 1, 'parameter search filters rows');
          await search.fill('');
          await page.getByRole('button', { name: mode === 'local' ? /设备参数表/ : /服务器参数表/ }).click();
          await page.getByRole('heading', { name: /参数表/, level: 3 }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'parameter file dialog fits viewport');
          await page.getByRole('button', { name: /关闭/ }).click();
        }
        await page.screenshot({ path: join(shots, `${mode}-${width}-${name}.png`), fullPage: true });
        checks++;
      }
      assert.deepEqual(errors, [], `${mode}/${width} runtime errors`);
      await page.close();
    }
  }
  console.log(`console UI passed: ${checks} page/viewport checks, navigation, CSV rendering, no page overflow/runtime errors. Screenshots: ${shots}`);
} finally { await browser.close(); server.close(); }
