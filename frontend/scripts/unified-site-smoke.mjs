#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = process.env.PLAYWRIGHT_MODULE || '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';
const module = await import(pathToFileURL(resolve(runner)).href);
const { chromium } = module.default || module;
const root = resolve('dist');
const screenshots = process.env.CLOUD_SCREENSHOTS || '/tmp/wd-cloud-ui';
mkdirSync(screenshots, { recursive: true });
let responseStatus = 200;
let empty = false;
let listRequests = 0;
const apiRequests = [];
const fixtures = [
  { device_id: 'wd-ac276eab7c9c', display_name: 'ESP32-001', cloud_state: 'online', sta_ip: '10.162.92.4', ap_ip: '192.168.4.1' },
  { device_id: 'wd-offline', display_name: 'ESP32-002', cloud_state: 'offline' },
  { device_id: 'wd/a b?#', display_name: '<img src=x onerror=alert(1)>' },
];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Login fixture</h1>'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push(url.pathname);
    if (url.pathname === '/api/devices') {
      listRequests++;
      res.writeHead(responseStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseStatus === 200 ? { devices: empty ? [] : fixtures } : { error: 'test error' }));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  const leaf = url.pathname.split('/').pop();
  const file = ['cloud', 'cloud.html', 'i.html', ''].includes(leaf) ? 'index.html' : leaf;
  try {
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(join(root, file)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 1024, 390]) {
    responseStatus = 200; empty = false; apiRequests.length = 0;
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1024 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + '/cloud.html#devices');
    await page.getByText('ESP32-001', { exact: true }).locator('visible=true').waitFor();
    assert.equal(await page.locator('aside, nav').count(), 0, 'cloud has only the device list, no sidebar/navigation');
    await page.getByRole('heading', { name: '设备列表', exact: true }).waitFor();
    for (const removed of ['诊断摘要', '系统资源', '备注', '设备总数', '消息中心', '能力清单', '系统设置', '查看详情']) {
      assert.equal(await page.getByText(removed, { exact: true }).count(), 0, removed + ' removed');
    }
    assert.equal(await page.getByRole('link', { name: '退出登录', exact: true }).getAttribute('href'), '/logout');
    const search = page.getByRole('searchbox', { name: '搜索设备' });
    await search.fill('no-such-device');
    await page.getByText('没有匹配的设备', { exact: true }).waitFor();
    await search.fill('ESP32-001');
    const online = page.getByText('ESP32-001', { exact: true }).locator('visible=true');
    await online.waitFor();
    const status = page.getByRole('combobox', { name: '设备状态' });
    await status.selectOption('offline');
    assert.equal(await online.count(), 0, 'filter combines name and state');
    await search.fill('');
    await page.getByText('ESP32-002', { exact: true }).locator('visible=true').waitFor();
    await status.selectOption('unknown');
    assert.equal(await page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true }).count(), 1, 'missing cloud state is included in unknown filter');
    await status.selectOption('all');
    const open = page.getByRole('link', { name: '打开控制台 ESP32-001', exact: true }).locator('visible=true');
    assert.equal(await open.getAttribute('href'), '/remote/wd-ac276eab7c9c/orig/i.html');
    const odd = page.getByRole('link', { name: '打开控制台 <img src=x onerror=alert(1)>', exact: true }).locator('visible=true');
    assert.equal(await odd.getAttribute('href'), '/remote/wd%2Fa%20b%3F%23/orig/i.html');
    assert.equal(await page.locator('main img').count(), 0, 'device name renders as text');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, width + ' no page overflow');
    const countBefore = listRequests;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="刷新"]')?.disabled);
    assert.ok(listRequests > countBefore, 'refresh reloads device list');
    assert.ok(apiRequests.every(path => path === '/api/devices'), 'no detail/history/bus polling remains');
    await page.screenshot({ path: join(screenshots, width + '-device-list.png'), fullPage: true });

    responseStatus = 500;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /HTTP 500/ }).waitFor();
    assert.equal(await online.count(), 0, 'failed refresh does not show stale online rows');
    assert.equal(await page.getByText('暂无设备', { exact: true }).count(), 0, 'request failure is not an empty fleet');
    responseStatus = 200; empty = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText('暂无设备', { exact: true }).waitFor();
    responseStatus = 401;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForURL('**/login?**');
    assert.equal(new URL(page.url()).searchParams.get('next'), '/cloud.html#devices');
    assert.deepEqual(errors, [], 'cloud runtime errors');
    await page.close();
  }
  // Device and cloud-device entry points remain available after platform cleanup.
  for (const entry of ['/orig/i.html', '/remote/wd-ac276eab7c9c/orig/i.html']) {
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + entry);
    await page.getByRole('navigation', { name: '设备导航', exact: true }).waitFor();
    assert.equal(await page.title(), 'GMCC · 设备调试台');
    await page.close();
  }
  console.log('unified site smoke passed: simple device list, search/filter, safe console links, refresh, errors, empty state, auth redirect, 3 viewports and both device entries');
} finally { await browser.close(); server.close(); }
