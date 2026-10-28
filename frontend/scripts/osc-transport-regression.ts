import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveConnectionTarget } from '../src/lib/connectionTarget';
import { shouldStopOscOnDisconnect } from '../src/lib/oscTransport';

const local = resolveConnectionTarget('http://192.168.4.1');
assert.equal(shouldStopOscOnDisconnect(local.kind), true);

const cloud = resolveConnectionTarget(
  'http://43.153.137.20:18088/remote/wd-ac276eab7c9c/orig/i.html',
);
assert.equal(shouldStopOscOnDisconnect(cloud.kind), false);

const invalid = resolveConnectionTarget('invalid');
assert.equal(shouldStopOscOnDisconnect(invalid.kind), true);

const addressPage = readFileSync(resolve(process.cwd(), 'src/components/OscilloscoperPage.tsx'), 'utf8');
const parameterPage = readFileSync(resolve(process.cwd(), 'src/components/ModbusOscPage.tsx'), 'utf8');
const transportSource = readFileSync(resolve(process.cwd(), 'src/lib/oscTransport.ts'), 'utf8');
const presentationSource = `${addressPage}\n${parameterPage}\n${transportSource}`;

for (const copy of [
  '局域网高速通道',
  '浏览器直连当前热点中的 ESP32，波形不经过云服务器',
  '低延迟',
  '云端高速通道',
  '设备通过二进制 WebSocket 上传波形，控制与状态仍使用 MQTT',
  '公网链路',
  '通信地址无效',
  '请先在连接设置中选择局域网设备或云端设备',
]) {
  assert.ok(!presentationSource.includes(copy), `示波器不应保留通道宣传横幅：${copy}`);
}

console.log('osc transport regression passed');
