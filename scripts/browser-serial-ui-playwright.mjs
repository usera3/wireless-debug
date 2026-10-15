import assert from 'node:assert/strict';
import { installBrowserSerialFixture } from './browser-serial-fixture.mjs';
import { chromium } from './browser-test-runtime.mjs';
const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
const tests = [];
const test = (name, run, options = {}) => tests.push({ name, run, options });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const fixture = (page, fn) => page.evaluate(fn);
const moduleImport = async (page, path, action) => page.evaluate(async ({ path, action }) => {
  const resource = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)?.name;
  const module = await import(resource || path);
  return Function('module', `return (${action})(module)`)(module);
}, { path, action: String(action) });

test('automatic recovery keeps the selected port and can be cancelled explicitly', async page => {
  await click(page, '选择并授权串口'); await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  const selected = await page.getByLabel('已授权串口').inputValue();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByText('等待串口重新接入', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('串口波特率').isDisabled(), true);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), selected);
  assert.deepEqual(await fixture(page, () => [__serialFixture.requests, __serialFixture.opens, __serialFixture.writes]), [1, 2, []]);
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByText('等待串口重新接入', { exact: true }).waitFor();
  await click(page, '取消自动重连');
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.waitForTimeout(800);
  await page.getByText('串口未打开', { exact: true }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.opens), 2);
  assert.equal(await page.getByRole('alert').count(), 0, 'Cancellation clears the stale automatic-recovery message');
});

test('new port object requires explicit selection and confirmation without a second permission prompt', async page => {
  await click(page, '选择并授权串口');
  await page.getByLabel('设备备注（本页有效）').fill('原设备备注');
  await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByText('等待串口重新接入', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('connect', 1));
  await page.getByText('串口身份待确认', { exact: true }).waitFor();
  const confirm = page.getByRole('button', { name: '确认所选串口并连接', exact: true });
  assert.equal(await confirm.isDisabled(), true, 'Missing old selection cannot confirm a new device');
  assert.equal(await page.getByLabel('已授权串口').isDisabled(), false);
  await page.waitForTimeout(900);
  assert.equal(await fixture(page, () => __serialFixture.opens), 1);
  await page.getByLabel('已授权串口').selectOption('2');
  assert.equal(await page.getByLabel('设备备注（本页有效）').inputValue(), '', 'Do not transfer identity-local note');
  assert.equal(await fixture(page, () => __serialFixture.opens), 1, 'Selection alone is not confirmation');
  await confirm.click();
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.deepEqual(await fixture(page, () => [__serialFixture.requests, __serialFixture.opens, __serialFixture.writes]), [1, 2, []]);
  await click(page, '断开串口');
}, { portInfo: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }, { usbVendorId: 0x303a, usbProductId: 0x1001 }] });

test('new port confirmation survives view changes and remains cancellable', async page => {
  await click(page, '选择并授权串口'); await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByRole('button', { name: /参数编辑/ }).first().click();
  await fixture(page, () => __serialFixture.event('connect', 1));
  await page.getByRole('button', { name: /连接设置/ }).first().click();
  await page.getByText('串口身份待确认', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '确认所选串口并连接', exact: true }).isDisabled(), true);
  await click(page, '取消自动重连');
  await page.getByText('串口未打开', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.waitForTimeout(800);
  assert.deepEqual(await fixture(page, () => [__serialFixture.requests, __serialFixture.opens, __serialFixture.writes]), [1, 1, []]);
});

test('original port recovery displays the actual port after another candidate was selected', async page => {
  await click(page, '选择并授权串口');
  await page.getByLabel('设备备注（本页有效）').fill('原设备备注');
  await page.getByLabel('串口波特率').fill('921600');
  await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await fixture(page, () => __serialFixture.event('connect', 1));
  await page.getByText('串口身份待确认', { exact: true }).waitFor();
  await page.getByLabel('已授权串口').selectOption('2');
  await page.getByLabel('串口波特率').fill('115200');
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '1', 'Connected UI must identify the actual restored port');
  assert.equal(await page.getByLabel('设备备注（本页有效）').inputValue(), '原设备备注');
  assert.equal(await page.getByLabel('串口波特率').inputValue(), '921600');
  assert.deepEqual(await fixture(page, () => [__serialFixture.requests, __serialFixture.opens, __serialFixture.writes]), [1, 2, []]);
  await page.getByRole('button', { name: /参数编辑/ }).first().click();
  await page.getByRole('button', { name: /连接设置/ }).first().click();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '1', 'Remount retains actual connected port');
  assert.equal(await page.getByLabel('串口波特率').inputValue(), '921600');
  await click(page, '断开串口');
});

test('port presentation explains native naming and keeps device notes identity-local', async page => {
  await page.getByText('浏览器未提供系统名称或 COM 号，可添加备注方便识别。', { exact: true }).waitFor();
  const select = page.getByLabel('已授权串口');
  assert.equal(await select.inputValue(), '');
  await select.selectOption('1');
  await page.getByRole('heading', { name: 'USB 串口 1', exact: true }).waitFor();
  await page.getByText('VID 303A · PID 1001', { exact: true }).waitFor();
  const note = page.getByLabel('设备备注（本页有效）');
  await note.fill('电机调试口（COM9）');
  await page.getByRole('heading', { name: '电机调试口（COM9）', exact: true }).waitFor();
  assert.match(await select.locator('option:checked').innerText(), /电机调试口（COM9）.*VID 303A/);
  await select.selectOption('2');
  await page.getByRole('heading', { name: '系统串口 2', exact: true }).waitFor();
  assert.equal(await note.inputValue(), '', 'Another port must not inherit this device note');
  await page.getByText('浏览器未提供硬件标识', { exact: true }).waitFor();
  await select.selectOption('1');
  assert.equal(await note.inputValue(), '电机调试口（COM9）');
  await click(page, '刷新串口');
  assert.equal(await select.inputValue(), '1');
  assert.equal(await note.inputValue(), '电机调试口（COM9）');
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByText(/所选串口当前不可用/).waitFor();
  assert.match(await select.locator('option:checked').innerText(), /电机调试口（COM9）.*当前不可用/);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.waitForFunction(() => !document.querySelector('main').textContent.includes('所选串口当前不可用'));
  await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await note.isDisabled(), true);
  await click(page, '断开串口');
  await click(page, '清除备注');
  await page.getByRole('heading', { name: 'USB 串口 1', exact: true }).waitFor();
  assert.equal(await note.inputValue(), '');
}, { granted: 2, portInfo: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }, {}] });

test('bluetooth presentation uses only service metadata without inventing COM names', async page => {
  const select = page.getByLabel('已授权串口');
  await select.selectOption('1');
  await page.getByRole('heading', { name: '蓝牙串口 1', exact: true }).waitFor();
  await page.getByText('蓝牙服务 0x1101', { exact: true }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
}, { granted: 1, portInfo: [{ bluetoothServiceClassId: 0x1101 }] });

test('port presentation note and actions do not overlap on a narrow screen', async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('已授权串口').selectOption('1');
  const note = page.getByLabel('设备备注（本页有效）');
  await note.fill('电机调试串口');
  const noteBox = await note.boundingBox();
  const clearBox = await page.getByRole('button', { name: '清除备注', exact: true }).boundingBox();
  assert.ok(noteBox && clearBox);
  const sameRow = Math.abs(noteBox.y - clearBox.y) < Math.max(noteBox.height, clearBox.height);
  assert.ok(!sameRow || noteBox.x + noteBox.width <= clearBox.x - 4, 'Note input must not overlap clear action');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow');
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
}, { granted: 1 });

test('port presentation notes survive view changes but never a new page identity', async page => {
  const select = page.getByLabel('已授权串口');
  await select.selectOption('1');
  await page.getByLabel('设备备注（本页有效）').fill('本次测试设备');
  await select.selectOption('2');
  assert.equal(await page.getByLabel('设备备注（本页有效）').inputValue(), '', 'Identical VID/PID must not share a note');
  await select.selectOption('1');
  await page.getByRole('button', { name: /参数编辑/ }).first().click();
  await page.getByRole('button', { name: /连接设置/ }).first().click();
  await select.selectOption('1');
  assert.equal(await page.getByLabel('设备备注（本页有效）').inputValue(), '本次测试设备');
  await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /连接设置/ }).first().click();
  await select.selectOption('1');
  assert.equal(await page.getByLabel('设备备注（本页有效）').inputValue(), '', 'Never attach a note to a new OS-port identity');
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
}, { granted: 2, portInfo: [{ usbVendorId: 0x1234, usbProductId: 0x5601 }, { usbVendorId: 0x1234, usbProductId: 0x5601 }] });

test('saved preference, explicit permission/open, raw bytes, cleanup and network isolation', async page => {
  await page.getByText('浏览器串口直连（无需本地代理）', { exact: true }).waitFor();
  await page.waitForTimeout(3200);
  assert.equal(await fixture(page, () => localStorage.getItem('wireless_debug_ws_url')), 'webserial://local');
  assert.deepEqual(await fixture(page, () => [__serialFixture.requests, __serialFixture.opens]), [0, 0]);
  await click(page, '选择并授权串口');
  assert.equal(await fixture(page, () => __serialFixture.chooserActivated), true, 'Chooser runs in active user gesture');
  await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('串口波特率').isDisabled(), true);
  assert.equal(await page.getByText('数据转发方式', { exact: true }).count(), 0);
  assert.equal(await page.getByText('WiFi 状态', { exact: true }).count(), 0);
  assert.ok((await page.locator('main').innerText()).includes('不代表下位机已响应'));
  assert.ok(!(await page.locator('main').innerText()).includes('WebSocket'));
  await moduleImport(page, '/src/lib/wsClient.ts', ({ wsClient }) => { wsClient.send(new Uint8Array([0, 255, 13, 10])); });
  await page.waitForFunction(() => __serialFixture.writes.length === 1);
  assert.deepEqual(await fixture(page, () => __serialFixture.writes), [[0, 255, 13, 10]]);
  assert.deepEqual(await fixture(page, () => __serialFixture.ports[0].settings), { baudRate: 2000000, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  const bytes = await moduleImport(page, '/src/lib/wsClient.ts', async ({ wsClient }) => {
    const result = []; const handler = bytes => result.push(...bytes);
    wsClient.onFrame(handler);
    window.__serialFixture.ports[0].reader.enqueue(new Uint8Array([0, 254]));
    await new Promise(resolve => setTimeout(resolve, 10));
    wsClient.removeHandler(handler); return result;
  });
  assert.deepEqual(bytes, [0, 254]);
  await click(page, '断开串口');
  await page.waitForFunction(() => __serialFixture.closes === 1);
  assert.deepEqual(await fixture(page, () => [__serialFixture.cancelled, __serialFixture.aborted]), [1, 1]);
  await page.getByRole('button', { name: /参数编辑/ }).first().click();
  assert.equal(await page.getByRole('button', { name: /本地参数表/ }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /设备参数表/ }).count(), 0);
  await page.getByRole('button', { name: /固件烧录/ }).first().click();
  assert.ok((await page.locator('main').innerText()).includes('固件'));
}, { savedUrl: 'webserial://local' });

test('unsupported browser has actionable feedback', async page => {
  await page.getByRole('alert').filter({ hasText: /不支持 Web Serial.*Chrome|Chrome.*不支持/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '选择并授权串口', exact: true }).isDisabled(), true);
}, { supported: false });
test('insecure origin has actionable feedback', async page => {
  await page.getByRole('alert').filter({ hasText: /HTTPS.*localhost|localhost.*HTTPS/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '选择并授权串口', exact: true }).isDisabled(), true);
}, { insecure: true });
for (const [name, error, message] of [['cancelled', 'NotFoundError', /已取消.*授权|取消选择/], ['policy denied', 'SecurityError', /权限策略|permissions-policy/i], ['permission denied', 'NotAllowedError', /拒绝.*权限|权限.*拒绝/]]) {
  test(`chooser ${name}`, async page => {
    await fixture(page, () => { __serialFixture.chooserError = ''; });
    await page.evaluate(error => { __serialFixture.chooserError = error; }, error);
    await click(page, '选择并授权串口');
    await page.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.equal(await fixture(page, () => __serialFixture.opens), 0);
  });
}
test('open failure is actionable and retry remains manual', async page => {
  await click(page, '选择并授权串口');
  await fixture(page, () => { __serialFixture.openError = 'Port occupied'; });
  await click(page, '连接串口');
  await page.getByRole('alert').filter({ hasText: /Port occupied/ }).waitFor();
  assert.equal(await fixture(page, () => __serialFixture.opens), 1);
  assert.equal(await page.getByLabel('串口波特率').isDisabled(), false);
});
test('granted devices never auto-select; unplug/reinsert preserves identity without opening', async page => {
  await page.getByLabel('已授权串口').selectOption({ label: 'USB 串口 1（VID 1234 / PID 5601）' });
  const id = await page.getByLabel('已授权串口').inputValue();
  await fixture(page, () => __serialFixture.event('disconnect', 0));
  await page.getByText(/所选串口当前不可用/).waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), id);
  assert.equal(await page.getByRole('button', { name: '连接串口', exact: true }).isDisabled(), true);
  await fixture(page, () => __serialFixture.event('connect', 0));
  await page.waitForFunction(() => !document.querySelector('main').textContent.includes('所选串口当前不可用'));
  assert.equal(await page.getByLabel('已授权串口').inputValue(), id);
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
}, { granted: 2 });
test('refresh feedback, coalesced discovery and keyboard/hover feedback', async page => {
  await page.getByLabel('已授权串口').waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '');
  await fixture(page, () => { __serialFixture.deferDiscovery = true; });
  const refresh = page.getByRole('button', { name: '刷新串口', exact: true });
  await page.mouse.move(0, 0); const idle = await refresh.evaluate(el => getComputedStyle(el).backgroundColor);
  await refresh.hover();
  await page.waitForFunction(idle => getComputedStyle(document.querySelector('[aria-label="刷新串口"]')).backgroundColor !== idle, idle);
  const hovered = await refresh.evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(hovered, idle);
  await refresh.focus(); await page.keyboard.press('Enter');
  assert.equal(await refresh.getAttribute('aria-busy'), 'true');
  assert.equal(await refresh.isDisabled(), true);
  await fixture(page, () => { __serialFixture.event('connect', 1); __serialFixture.event('connect', 1); });
  assert.equal(await fixture(page, () => __serialFixture.pendingDiscovery.length), 1);
  await fixture(page, () => { __serialFixture.deferDiscovery = false; __serialFixture.pendingDiscovery.shift()(__serialFixture.granted.slice()); });
  await page.waitForFunction(() => document.querySelector('[aria-label="刷新串口"]').getAttribute('aria-busy') === 'false');
}, { granted: 1 });
test('selected baud preset has a distinct visible color', async page => {
  const selected = page.getByRole('button', { name: '2,000,000', exact: true });
  const ordinary = page.getByRole('button', { name: '115,200', exact: true });
  const color = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(await color(selected), await color(ordinary), 'Selected preset background differs from unselected preset');
  await ordinary.click();
  await page.waitForTimeout(200);
  assert.notEqual(await color(selected), await color(ordinary));
});
test('serial to explicit custom editor stays editable even for recognized URL', async page => {
  assert.deepEqual(await fixture(page, () => __serialFixture.business), []);
  await fixture(page, () => { __serialFixture.allowNetworkAttempts = true; });
  await click(page, '自定义地址');
  const input = page.getByLabel('通信入口地址');
  await input.fill('http://192.168.4.1');
  assert.equal(await input.isEditable(), true);
  assert.equal(await page.getByRole('button', { name: '自定义地址', exact: true }).getAttribute('aria-pressed'), 'true');
  await input.fill('ws://custom.example/ws');
  assert.equal(await input.inputValue(), 'ws://custom.example/ws');
});
test('late chooser cannot select after mode switch and return', async page => {
  await fixture(page, () => { __serialFixture.deferChooser = true; });
  await click(page, '选择并授权串口');
  await click(page, '自定义地址'); await click(page, '本地串口');
  await fixture(page, () => __serialFixture.pendingChooser.shift()());
  await page.waitForTimeout(50);
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '');
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
});
test('late discovery cannot resurrect unmounted serial UI', async page => {
  await fixture(page, () => { __serialFixture.deferDiscovery = true; });
  await click(page, '刷新串口');
  await click(page, '自定义地址'); await click(page, '本地串口');
  await fixture(page, () => { __serialFixture.pendingDiscovery.shift()([__serialFixture.ports[1]]); });
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '');
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
});
test('stale discovery error cannot overwrite a newer chooser result', async page => {
  await fixture(page, () => { __serialFixture.deferDiscovery = true; });
  await click(page, '刷新串口');
  await click(page, '选择并授权串口');
  await fixture(page, () => __serialFixture.pendingDiscoveryErrors.shift()(new Error('old discovery failure')));
  await page.waitForTimeout(80);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.notEqual(await page.getByLabel('已授权串口').inputValue(), '');
});
test('late open is closed after leaving serial mode', async page => {
  await click(page, '选择并授权串口');
  await fixture(page, () => { __serialFixture.deferOpen = true; });
  await click(page, '连接串口');
  await page.waitForFunction(() => __serialFixture.opens === 1);
  await click(page, '自定义地址');
  await fixture(page, () => __serialFixture.pendingOpen.shift()());
  await page.waitForFunction(() => __serialFixture.closes === 1);
  await click(page, '本地串口');
  await page.getByText('串口未打开', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已授权串口').inputValue(), '');
});
test('fault cleanup errors remain visible and reconnection stays manual', async page => {
  await click(page, '选择并授权串口'); await click(page, '连接串口');
  await page.getByText('串口传输已连接', { exact: true }).waitFor();
  await fixture(page, () => { __serialFixture.closeError = 'OS close refused'; __serialFixture.ports[0].reader.error(new Error('USB removed')); });
  await page.getByRole('alert').filter({ hasText: /OS close refused/ }).waitFor();
  await page.getByText('串口未打开', { exact: true }).waitFor();
  await fixture(page, () => __serialFixture.event('connect', 0));
  assert.equal(await fixture(page, () => __serialFixture.opens), 1);
});
test('network baud modal closes across serial mode transition', async page => {
  await fixture(page, () => { __serialFixture.allowNetworkAttempts = true; });
  await click(page, '自定义地址'); await click(page, '更多波特率');
  await page.getByText('⚙️ UART1 波特率设置', { exact: true }).waitFor();
  // A real user cannot reach the mode tabs under the modal overlay; a store
  // change models the external connection transition the mounted modal guards.
  await moduleImport(page, '/src/store/connectionStore.ts', ({ useConnectionStore }) => useConnectionStore.getState().setUrl('webserial://local', true));
  assert.equal(await page.getByText('⚙️ UART1 波特率设置', { exact: true }).count(), 0);
  await moduleImport(page, '/src/store/connectionStore.ts', ({ useConnectionStore }) => useConnectionStore.getState().setUrl('ws://custom.example/ws', false));
  await page.waitForTimeout(80);
  assert.equal(await page.getByText('⚙️ UART1 波特率设置', { exact: true }).count(), 0, 'Old network modal must not remount after returning');
});
test('cloud runtime wins initially and directory polling stops in serial mode', async page => {
  assert.equal(await moduleImport(page, '/src/store/connectionStore.ts', ({ useConnectionStore }) => useConnectionStore.getState().url), 'wss://cloud.example/ws/device/test-cloud-device');
  await click(page, '本地串口');
  await fixture(page, () => { __serialFixture.allowNetworkAttempts = false; });
  await page.waitForTimeout(5200);
  assert.equal(await fixture(page, () => __serialFixture.requests), 0);
  assert.equal(await fixture(page, () => __serialFixture.opens), 0);
}, { remoteDevice: true });

let failures = 0;
let executed = 0;
try {
  for (const { name, run, options } of tests) {
    if (process.env.TEST_MATCH && !name.includes(process.env.TEST_MATCH)) continue;
    executed++;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(installBrowserSerialFixture, options);
    const emittedBusiness = [];
    const frontend = new URL(process.env.WEB_URL || 'http://127.0.0.1:5679/index.html');
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== frontend.origin || /\/(api|platform|remote)\//.test(url.pathname)) {
        emittedBusiness.push(request.url()); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(2500);
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (!(url.host === frontend.host && url.pathname === '/' && url.searchParams.has('token'))) emittedBusiness.push(socket.url());
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(process.env.WEB_URL || 'http://127.0.0.1:5679/index.html', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /连接设置/ }).first().click();
      await run(page);
      assert.deepEqual(await fixture(page, () => __serialFixture.business), [], 'No business fetch/WebSocket attempts in serial mode');
      assert.deepEqual(emittedBusiness, [], 'No API/agent HTTP or application WebSocket escapes the OS boundary fixture');
      assert.deepEqual(errors, [], 'No unhandled component errors');
      console.log(`PASS ${name}`);
    } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
assert.ok(executed > 0, 'At least one browser UI case must match');
assert.equal(failures, 0, `${failures}/${executed} browser serial UI cases failed`);
console.log(`browser serial UI passed (${executed} real-component cases, OS/Streams fixtures only)`);
