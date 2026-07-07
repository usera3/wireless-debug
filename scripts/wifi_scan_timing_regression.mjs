import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const webApi = readFileSync(resolve(process.cwd(), 'main/web_api.c'), 'utf8');
const wifiPage = readFileSync(resolve(process.cwd(), 'dist/wifi.html'), 'utf8');
const wifiManager = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

for (const required of [
  's_wifi_scan_started_us',
  's_wifi_scan_finished_us',
  'scan_elapsed_ms',
  'scan_duration_ms',
  '\\"elapsed_ms\\":%lld',
  '\\"duration_ms\\":%lld',
]) {
  assert.ok(webApi.includes(required), `scan API 缺少耗时诊断：${required}`);
}

for (const required of [
  'formatScanTiming',
  '扫描耗时',
]) {
  assert.ok(wifiPage.includes(required), `wifi.html 缺少扫描耗时显示：${required}`);
}

for (const required of [
  'scan_started_us',
  'WiFi scan finished',
  'WiFi scan failed',
]) {
  assert.ok(wifiManager.includes(required), `wifi_manager 缺少扫描耗时日志：${required}`);
}
