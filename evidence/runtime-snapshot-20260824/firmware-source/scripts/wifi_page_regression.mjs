import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'dist/wifi.html'), 'utf8');

const connectPoll = html.match(
  /function pollConnect\(targetSsid\)\s*\{[\s\S]*?\n\s*}\n\n\s*form\.addEventListener/,
)?.[0];

assert.ok(connectPoll, 'wifi.html 缺少连接状态轮询');
assert.doesNotMatch(
  connectPoll,
  /setInterval\s*\(/,
  '连接状态请求耗时可能超过轮询间隔，禁止用 setInterval 产生重叠请求',
);
assert.match(
  connectPoll,
  /const pollToken = pollGeneration/,
  '连接轮询必须记录代次，防止旧请求覆盖新状态',
);
assert.match(
  connectPoll,
  /await fetchWifiStatus\(CONNECT_STATUS_TIMEOUT_MS\)[\s\S]*?pollToken !== pollGeneration[\s\S]*?renderWifiStatus\(data\)/,
  '状态响应必须先校验轮询代次，再更新页面',
);
assert.match(
  connectPoll,
  /pollTimer = setTimeout\(pollOnce, CONNECT_POLL_RETRY_MS\)/,
  '下一次轮询必须在本次请求结束后再调度',
);
assert.match(
  connectPoll,
  /pollTimer = setTimeout\(pollOnce, CONNECT_POLL_INITIAL_DELAY_MS\)/,
  '首次查询应等待固件已调度的连接任务启动',
);
assert.match(
  html,
  /async function loadStatus\(statusToken = pollGeneration\)[\s\S]*?statusToken !== pollGeneration[\s\S]*?renderWifiStatus\(data\)/,
  '页面初始状态请求也必须在更新界面前校验代次',
);
assert.match(
  html,
  /const initialStatusToken = pollGeneration;[\s\S]*?loadStatus\(initialStatusToken\)\.catch[\s\S]*?initialStatusToken === pollGeneration/,
  '初始状态请求失败后不得覆盖已经开始的连接流程',
);

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
