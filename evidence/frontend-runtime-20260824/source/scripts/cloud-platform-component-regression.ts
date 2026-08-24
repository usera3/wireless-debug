import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/components/CloudPlatformPage.tsx', 'utf8');
for (const marker of [
  'export function CloudPlatformPage',
  '/api/devices',
  '/api/devices/${encodeURIComponent(selectedDeviceId)}',
  '/api/devices/${encodeURIComponent(selectedDeviceId)}/history',
  '/api/bus/messages?limit=80',
  '/api/bus/send',
  'cloudDeviceConsolePath',
  '设备总览',
  '诊断摘要',
  '系统资源',
  '设备详情',
  '刷新状态',
  '保存设备名',
  '保存备注',
  '连接状态',
  '最近状态包',
  '最近状态摘要',
  '命令响应',
  '云端发送',
  '消息流水',
  '能力清单',
  '最近事件',
  '最近命令',
  '打开控制台',
  'Cloud Console',
  'MQTT',
  '硬件 MAC',
  '健康',
  '通信',
  'UART',
  '固件',
  '退出登录',
  'user-menu',
]) {
  assert.ok(page.includes(marker), `CloudPlatformPage missing marker: ${marker}`);
}

const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes('currentRuntimeInfo'), 'App must use runtime mode detection');
assert.ok(app.includes('CloudPlatformPage'), 'App must render cloud platform page');
assert.ok(app.includes('return <CloudPlatformPage />'), 'Cloud platform runtime should use the dedicated platform shell');

console.log('cloud platform component regression passed');
