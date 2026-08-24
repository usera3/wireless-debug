import { strict as assert } from 'node:assert';
import { resolveConnectionTarget } from '../src/lib/connectionTarget';
import { describeOscTransport, shouldStopOscOnDisconnect } from '../src/lib/oscTransport';

const local = describeOscTransport(resolveConnectionTarget('http://192.168.4.1'));
assert.deepEqual(local, {
  mode: 'local',
  title: '局域网高速通道',
  detail: '浏览器直连当前热点中的 ESP32，波形不经过云服务器',
  tone: 'fast',
});
assert.equal(shouldStopOscOnDisconnect(local.mode), true);

const cloud = describeOscTransport(
  resolveConnectionTarget('http://43.153.137.20:18088/remote/wd-ac276eab7c9c/orig/i.html'),
);
assert.deepEqual(cloud, {
  mode: 'cloud',
  title: '云端高速通道',
  detail: '设备通过二进制 WebSocket 上传波形，控制与状态仍使用 MQTT',
  tone: 'cloud',
});
assert.equal(shouldStopOscOnDisconnect(cloud.mode), false);

const invalid = describeOscTransport(resolveConnectionTarget('invalid'));
assert.deepEqual(invalid, {
  mode: 'invalid',
  title: '通信地址无效',
  detail: '请先在连接设置中选择局域网设备或云端设备',
  tone: 'invalid',
});
assert.equal(shouldStopOscOnDisconnect(invalid.mode), true);

console.log('osc transport regression passed');
