import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/components/CloudPlatformPage.tsx', 'utf8');
for (const marker of ['export function CloudPlatformPage', '/api/devices', 'cloudDeviceConsolePath', 'normalizeCloudDevice', 'isAuthRequiredResponse', '设备列表', '打开控制台', '退出登录']) {
  assert.ok(page.includes(marker), 'CloudPlatformPage missing integration: ' + marker);
}
for (const removed of ['/api/bus/', '/history', 'postJson', 'NAV_GROUPS', '<aside', '<nav', '诊断摘要', '系统资源', '保存备注', '能力清单']) {
  assert.ok(!page.includes(removed), 'Removed cloud feature still present: ' + removed);
}
const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes('return <CloudPlatformPage />'), 'cloud runtime must keep its dedicated entry');
console.log('cloud platform component regression passed: device list and console entry only');
