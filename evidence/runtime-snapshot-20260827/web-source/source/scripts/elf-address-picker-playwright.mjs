import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const runner = process.env.WIRELESS_DEBUG_PW_RUNNER ?? '/tmp/wireless_debug_playwright_runner';
const require = createRequire(`${runner}/package.json`);
const { chromium } = require('playwright');

const url = process.env.WEB_URL ?? 'http://127.0.0.1:5681/orig/i.html';
const c2000Fixture = process.env.ELF_FIXTURE
  ?? '/mnt/d/Users/sunqi39/Downloads/addr_parser/elf_example/test_platform_c2000.out';
const iarFixture = process.env.IAR_ELF_FIXTURE
  ?? '/mnt/d/Users/sunqi39/Downloads/addr_parser/elf_example/ecm_out_fan_iar.out';
const outputDir = process.env.ELF_PICKER_SCREENSHOT_DIR ?? '/tmp/elf-address-picker-20260825';

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_PROXY
    ? { proxy: { server: process.env.PLAYWRIGHT_PROXY } }
    : {}),
});
const pageErrors = [];
const uploadedRequests = [];

async function openAddressOscilloscope(page) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname === '/login') {
    assert.ok(process.env.WEB_USERNAME && process.env.WEB_PASSWORD, 'authenticated site requires WEB_USERNAME and WEB_PASSWORD');
    await page.locator('#username').fill(process.env.WEB_USERNAME);
    await page.locator('#password').fill(process.env.WEB_PASSWORD);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByRole('button', { name: /地址示波器/ }).click();
  await page.getByText('通道配置', { exact: true }).waitFor();
}

async function uploadElf(page, fixture, filename) {
  await page.locator('input[type="file"][accept*=".out"]').setInputFiles(fixture);
  await page.getByText(new RegExp(`已解析 ${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).waitFor();
}

async function clickSuggestion(page, expression) {
  await page.getByRole('button', { name: expression, exact: true }).click();
}

async function exerciseC2000(page) {
  await uploadElf(page, c2000Fixture, 'test_platform_c2000.out');

  const channel1Name = page.getByRole('textbox', { name: '通道 1 变量名' });
  const channel1Address = page.getByRole('textbox', { name: '通道 1 地址' });
  await channel1Name.fill('McStat');
  await clickSuggestion(page, 'McStatus1');
  await assert.rejects(
    page.getByRole('button', { name: 'cnt_tbs', exact: true }).waitFor({ timeout: 250 }),
    'unrelated root variables must not be rendered',
  );
  await clickSuggestion(page, 'McStatus1.Pu');
  await channel1Name.fill('McStatus1.Pu.Ia');
  await clickSuggestion(page, 'McStatus1.Pu.Ia');
  assert.equal(await channel1Name.inputValue(), 'McStatus1.Pu.Ia');
  assert.equal(await channel1Address.inputValue(), 'C534');

  const channel2Name = page.getByRole('textbox', { name: '通道 2 变量名' });
  const channel2Address = page.getByRole('textbox', { name: '通道 2 地址' });
  await channel2Name.fill('iRtMcBoardL');
  await clickSuggestion(page, 'iRtMcBoardList');
  assert.equal(await channel2Name.inputValue(), 'iRtMcBoardList[');
  await clickSuggestion(page, 'iRtMcBoardList[0]');
  assert.equal(await channel2Name.inputValue(), 'iRtMcBoardList[0].');
  await channel2Name.fill('iRtMcBoardList[0].Pwm');
  await clickSuggestion(page, 'iRtMcBoardList[0].PwmSampleCmp');
  assert.equal(await channel2Name.inputValue(), 'iRtMcBoardList[0].PwmSampleCmp[');
  await clickSuggestion(page, 'iRtMcBoardList[0].PwmSampleCmp[2]');
  assert.equal(await channel2Name.inputValue(), 'iRtMcBoardList[0].PwmSampleCmp[2]');
  assert.equal(await channel2Address.inputValue(), 'C93D');

  const channel3Name = page.getByRole('textbox', { name: '通道 3 变量名' });
  const channel3Address = page.getByRole('textbox', { name: '通道 3 地址' });
  const originalName = await channel3Name.inputValue();
  await channel3Address.fill('0x1234');
  assert.equal(await channel3Address.inputValue(), '0x1234');
  assert.equal(await channel3Name.inputValue(), originalName);
}

async function assertRowLayout(page, channelNo) {
  const variable = page.getByRole('textbox', { name: `通道 ${channelNo} 变量名` });
  const row = variable.locator('xpath=../..');
  const address = row.getByRole('textbox', { name: `通道 ${channelNo} 地址` });
  const type = row.locator('select');
  const [rowBox, addressBox, typeBox, variableBox] = await Promise.all([
    row.boundingBox(),
    address.boundingBox(),
    type.boundingBox(),
    variable.boundingBox(),
  ]);
  assert.ok(rowBox && addressBox && typeBox && variableBox, 'channel controls must be visible');
  assert.ok(addressBox.x + addressBox.width <= typeBox.x + 1, 'address and type controls must not overlap');
  assert.ok(typeBox.x + typeBox.width <= variableBox.x + 1, 'type and variable controls must not overlap');
  assert.ok(variableBox.x + variableBox.width <= page.viewportSize().width + 1, 'variable input must stay inside the viewport');
  assert.ok(rowBox.width <= page.viewportSize().width + 1, 'channel row must not create horizontal overflow');
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desktop.on('pageerror', (error) => pageErrors.push(error));
  desktop.on('request', (request) => {
    if (/\.(?:out|elf)(?:[?#]|$)/i.test(request.url())) uploadedRequests.push(request.url());
  });
  await openAddressOscilloscope(desktop);
  await exerciseC2000(desktop);
  await assertRowLayout(desktop, 1);

  await uploadElf(desktop, iarFixture, 'ecm_out_fan_iar.out');
  const channel4Name = desktop.getByRole('textbox', { name: '通道 4 变量名' });
  await channel4Name.fill('McStatus1.Pu.swI');
  await desktop.getByRole('button', { name: 'McStatus1.Pu.swIa', exact: true }).waitFor();
  const cdp = await desktop.context().newCDPSession(desktop);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heapUsed = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? Number.POSITIVE_INFINITY;
  assert.ok(heapUsed < 128 * 1024 * 1024, `ELF parsing heap use is unexpectedly high: ${heapUsed}`);
  await desktop.screenshot({ path: `${outputDir}/desktop.png`, fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (error) => pageErrors.push(error));
  mobile.on('request', (request) => {
    if (/\.(?:out|elf)(?:[?#]|$)/i.test(request.url())) uploadedRequests.push(request.url());
  });
  await openAddressOscilloscope(mobile);
  await uploadElf(mobile, c2000Fixture, 'test_platform_c2000.out');
  const mobileName = mobile.getByRole('textbox', { name: '通道 1 变量名' });
  const widthBefore = (await mobileName.boundingBox()).width;
  await mobileName.fill('iRtMcBoardList[0].Pwm');
  const mobileSuggestion = mobile.getByRole('button', {
    name: 'iRtMcBoardList[0].PwmSampleCmp',
    exact: true,
  });
  await mobileSuggestion.waitFor();
  const suggestionBox = await mobileSuggestion.boundingBox();
  assert.equal(await mobileSuggestion.isVisible(), true, 'mobile dropdown must remain visibly open');
  await mobile.screenshot({ path: `${outputDir}/mobile-dropdown.png`, fullPage: true });
  const widthAfter = (await mobileName.boundingBox()).width;
  assert.equal(widthAfter, widthBefore, 'long expressions must not resize the channel grid');
  assert.ok(suggestionBox.x >= 0 && suggestionBox.x + suggestionBox.width <= 390, 'dropdown must stay inside the mobile viewport');
  await assertRowLayout(mobile, 1);
  const hasHorizontalOverflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(hasHorizontalOverflow, false, 'mobile page must not overflow horizontally');
  await mobile.screenshot({ path: `${outputDir}/mobile.png`, fullPage: true });

  assert.deepEqual(uploadedRequests, [], '.out/.elf bytes must never leave the browser');
  assert.deepEqual(pageErrors, [], 'the picker must not raise uncaught browser errors');
  console.log(`elf address picker browser regression passed; heap=${Math.ceil(heapUsed / 1024 / 1024)} MiB; screenshots: ${outputDir}`);
} finally {
  await browser.close();
}
