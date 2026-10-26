#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
const rewrites = new Map();
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
  if (['/', '/cloud', '/cloud.html'].includes(url.pathname)) {
    res.writeHead(302, { location: '/index.html' + url.search }); res.end(); return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) {
    apiRequests.push(url.pathname);
    if (['/api/devices', '/platform/api/devices'].includes(url.pathname)) {
      listRequests++;
      res.writeHead(responseStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseStatus === 200 ? { devices: empty ? [] : fixtures } : { error: 'test error' }));
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, files: [] })); }
    return;
  }
  const leaf = url.pathname.split('/').pop();
  const file = ['cloud', 'cloud.html', 'i.html', ''].includes(leaf) ? 'index.html' : leaf;
  try {
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
    let body = readFileSync(join(root, file));
    if (file === 'index.html') {
      let injected = '';
      if (url.pathname === '/index.html' && url.searchParams.get('runtime') !== 'local') {
        injected = '<script>window.__WIRELESS_RUNTIME_MODE="cloud-platform";</script>';
      } else if (url.pathname.startsWith('/remote/')) {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        if (!rewrites.has(id)) rewrites.set(id, execFileSync('python3', ['scripts/backend-entry-regression.py', '--rewrite', id], { encoding: 'utf8' }));
        injected = rewrites.get(id);
      }
      body = body.toString().replace('</head>', injected + '</head>');
    }
    res.end(body);
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
    await page.goto(base + '/index.html?source=test#devices');
    await page.getByText('ESP32-001', { exact: true }).locator('visible=true').waitFor();
    assert.equal(await page.locator('.wd-device').count(), 1, 'one shared shell');
    assert.equal(await page.locator('.wd-brand').count(), 1, 'one brand');
    assert.equal(await page.locator('.wd-sidebar').count(), 1, 'one sidebar');
    await page.getByRole('navigation', { name: '设备导航' }).waitFor();
    for (const label of ['仪表盘', '地址示波器', '参数示波器', '参数编辑', '固件烧录', '连接设置']) {
      const nav = page.getByRole('button', { name: label, exact: true });
      assert.equal(await nav.isDisabled(), false, label + ' supports offline browsing');
      await nav.click();
      await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
    }
    await page.getByRole('button', { name: '设备列表', exact: true }).click();
    assert.equal(await page.locator('.wd-connection').count(), 0, 'no device connection status before selection');
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
    assert.equal(new URL(page.url()).searchParams.get('next'), '/index.html?source=test#devices');
    assert.deepEqual(errors, [], 'cloud runtime errors');
    await page.close();

    responseStatus = 200; empty = false; apiRequests.length = 0;
    const flow = await browser.newPage({ viewport: { width, height: 844 } });
    const flowErrors = [];
    flow.on('pageerror', err => flowErrors.push(err.message));
    await flow.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await flow.goto(base + '/cloud.html?source=legacy#devices');
    assert.equal(new URL(flow.url()).pathname + new URL(flow.url()).search + new URL(flow.url()).hash, '/index.html?source=legacy#devices', 'legacy redirect keeps query and hash');
    await flow.getByRole('link', { name: '打开控制台 ESP32-001', exact: true }).click();
    await flow.getByRole('heading', { name: '仪表盘', exact: true }).waitFor();
    await flow.locator('.wd-selected-device').filter({ hasText: fixtures[0].device_id }).waitFor();
    assert.equal(await flow.getByRole('button', { name: '仪表盘', exact: true }).isDisabled(), false);
    assert.equal(await flow.evaluate(() => window.__WIRELESS_REMOTE_DEVICE_ID), fixtures[0].device_id);
    await flow.getByRole('button', { name: '连接设置', exact: true }).click();
    const targetDetail = flow.locator('[title^="WS "]').first();
    const selectedTarget = await targetDetail.getAttribute('title');
    assert.ok(selectedTarget.includes('/ws/device/' + fixtures[0].device_id));
    // The production rewrite must still proxy device APIs.
    await flow.evaluate(() => fetch('/api/probe'));
    assert.ok(apiRequests.includes('/remote/' + fixtures[0].device_id + '/api/probe'));
    await flow.getByRole('button', { name: '设备列表', exact: true }).click();
    await flow.getByRole('searchbox', { name: '搜索设备' }).waitFor();
    await flow.getByRole('link', { name: '打开控制台 ESP32-002', exact: true }).waitFor();
    assert.ok(apiRequests.includes('/platform/api/devices'), 'directory bypasses device API rewrite');
    assert.ok(!apiRequests.includes('/remote/' + fixtures[0].device_id + '/api/devices'));
    assert.equal(new URL(flow.url()).pathname, '/remote/' + fixtures[0].device_id + '/orig/i.html');
    assert.equal(await flow.locator('.wd-sidebar').count(), 1);
    assert.equal(await flow.locator('.wd-brand').count(), 1);
    assert.equal(await flow.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('.wd-main').scrollWidth > document.querySelector('.wd-main').clientWidth + 1), false);
    await flow.getByRole('button', { name: '连接设置', exact: true }).click();
    assert.equal(await targetDetail.getAttribute('title'), selectedTarget, 'directory tab retains connection target');
    assert.equal(await flow.evaluate(() => window.__WIRELESS_REMOTE_DEVICE_ID), fixtures[0].device_id);
    await flow.getByRole('button', { name: '设备列表', exact: true }).click();
    await flow.evaluate(id => localStorage.setItem('wireless_debug_ws_url', 'ws://old-target/ws/device/' + id), fixtures[0].device_id);
    await flow.getByRole('link', { name: '打开控制台 ESP32-002', exact: true }).click();
    await flow.getByRole('heading', { name: '仪表盘', exact: true }).waitFor();
    await flow.locator('.wd-selected-device').filter({ hasText: fixtures[1].device_id }).waitFor();
    assert.equal(new URL(flow.url()).pathname, '/remote/wd-offline/orig/i.html');
    assert.equal(await flow.evaluate(() => window.__WIRELESS_REMOTE_DEVICE_ID), fixtures[1].device_id);
    await flow.getByRole('button', { name: '连接设置', exact: true }).click();
    const nextTarget = await targetDetail.getAttribute('title');
    assert.ok(nextTarget.includes('/ws/device/' + fixtures[1].device_id), 'new document resets target despite saved previous URL');
    assert.ok(!nextTarget.includes(fixtures[0].device_id), 'previous device target is cleared');
    assert.deepEqual(flowErrors, [], 'device-switch runtime errors');
    responseStatus = 403;
    await flow.getByRole('button', { name: '设备列表', exact: true }).click();
    await flow.waitForURL('**/login?**');
    assert.equal(new URL(flow.url()).searchParams.get('next'), '/remote/wd-offline/orig/i.html', 'remote directory preserves auth return context');
    await flow.close();
  }
  // Device and cloud-device entry points remain available after platform cleanup.
  for (const entry of ['/index.html?runtime=local', '/orig/i.html']) {
    apiRequests.length = 0;
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + entry);
    await page.getByRole('navigation', { name: '设备导航', exact: true }).waitFor();
    assert.equal(await page.title(), 'GMCC · 设备调试台');
    assert.equal(await page.getByRole('button', { name: '设备列表', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '退出登录', exact: true }).count(), 0);
    await page.waitForTimeout(5200);
    assert.equal(apiRequests.some(path => path.endsWith('/api/devices')), false, 'local pages never poll directory');
    await page.close();
  }
  const compact = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await compact.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const longId = 'wd-' + 'long-device-identifier-'.repeat(8);
  await compact.goto(base + '/remote/' + longId + '/orig/i.html');
  await compact.getByRole('heading', { name: '仪表盘', exact: true }).waitFor();
  assert.equal(await compact.locator('.wd-selected-device').getAttribute('title'), longId);
  assert.equal(await compact.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'long device ID fits mobile header');
  await compact.close();
  console.log('unified site smoke passed: shared index shell, offline navigation, production API rewrite, device switch, local isolation, search/filter, safe links, errors, auth and 3 viewports');
} finally { await browser.close(); server.close(); }
