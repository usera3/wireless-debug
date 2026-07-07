import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'dist/wifi.html'), 'utf8');

for (const required of [
  'formatNetworkError',
  '扫描中，ESP32 热点会短暂不可用',
  '等待 ESP32 热点恢复',
  'const deadline = Date.now() + 150000',
  'jsonFetch(path, {}, 12000)',
]) {
  assert.ok(html.includes(required), `wifi.html 缺少扫描恢复逻辑/文案：${required}`);
}

for (const forbidden of [
  'signal is aborted without reason',
  'scan timeout${lastError ? `: ${lastError}` : ""}',
]) {
  assert.ok(!html.includes(forbidden), `wifi.html 不应暴露底层网络错误文案：${forbidden}`);
}
