import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/components/CloudPlatformPage.tsx', 'utf8');
for (const marker of ['export function CloudPlatformPage', '/api/devices', 'platformDeviceDirectoryUrl()', 'cloudDeviceConsolePath', 'normalizeCloudDevice', 'isAuthRequiredResponse', '设备列表', '打开控制台']) {
  assert.ok(page.includes(marker), 'CloudPlatformPage missing integration: ' + marker);
}
for (const removed of ['/api/bus/', '/history', 'postJson', 'NAV_GROUPS', '<aside', '<nav', '<header', '<main', '<h1', '退出登录', '诊断摘要', '系统资源', '保存备注', '能力清单']) {
  assert.ok(!page.includes(removed), 'Removed cloud feature still present: ' + removed);
}
const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes('devices: <CloudPlatformPage />'), 'directory is shared layout content');
assert.ok(!app.includes('return <CloudPlatformPage />'), 'no separate platform shell');
const layout = readFileSync('src/components/Layout.tsx', 'utf8');
assert.ok(layout.includes('export type Tab'), 'one shared tab contract');
assert.ok(layout.includes('退出登录'), 'logout belongs in shared header');
console.log('cloud platform component regression passed: shared shell directory and console entry');
