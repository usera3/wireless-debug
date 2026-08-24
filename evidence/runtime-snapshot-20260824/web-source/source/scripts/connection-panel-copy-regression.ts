import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelSource = readFileSync(resolve(process.cwd(), 'src/components/ConnectionPanel.tsx'), 'utf8');
const targetSource = readFileSync(resolve(process.cwd(), 'src/lib/connectionTarget.ts'), 'utf8');
const source = `${panelSource}\n${targetSource}`;

const requiredCopy = [
  '设备热点 AP',
  '外部 WiFi STA',
  '连接外部 WiFi',
  '断开外部 WiFi',
  'AP 常驻',
  'AP IP',
  '连接热点',
  '通信入口地址',
  '连接目标',
  '局域网设备',
  '云端设备',
  '自定义地址',
  '在线设备',
  '当前直连 ESP32',
  '数据转发方式',
  '局域网直连',
  '云端通道',
  '地址无效',
  '局域网设备固定连接当前热点中的 ESP32',
  '正在请求局域网访问权限',
  '局域网访问已授权',
  'probeLocalNetworkAccess',
];

for (const copy of requiredCopy) {
  assert.ok(source.includes(copy), `连接设置页必须包含新文案：${copy}`);
}

const forbiddenCopy = [
  'AP 模式',
  'STA 模式',
  'STA SSID',
  '已连接" value={formatBool(wifiStatus?.sta_connected)}',
  '连接中" value={formatBool(wifiStatus?.sta_connecting)}',
  '云端模式：浏览器不直连',
  'cloud-mqtt://',
];

for (const copy of forbiddenCopy) {
  assert.ok(!source.includes(copy), `连接设置页不应再使用旧文案/旧状态表达：${copy}`);
}
