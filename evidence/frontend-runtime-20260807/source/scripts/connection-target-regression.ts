import { strict as assert } from 'node:assert';
import { resolveConnectionTarget, targetApiUrl } from '../src/lib/connectionTarget';

const lan = resolveConnectionTarget('ws://192.168.4.1/ws', 'http://127.0.0.1:18088');
assert.deepEqual(lan, {
  kind: 'local',
  label: '局域网直连',
  wsUrl: 'ws://192.168.4.1/ws',
  apiBase: 'http://192.168.4.1',
});
assert.equal(targetApiUrl(lan, '/api/device/status'), 'http://192.168.4.1/api/device/status');
assert.equal(targetApiUrl(lan, '/excel/a.xlsx'), 'http://192.168.4.1/excel/a.xlsx');

const cloudWs = resolveConnectionTarget(
  'ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c',
  'http://127.0.0.1:18088',
);
assert.deepEqual(cloudWs, {
  kind: 'cloud',
  label: '云端通道',
  deviceId: 'wd-ac276eab7c9c',
  wsUrl: 'ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c',
  apiBase: 'http://127.0.0.1:18088/remote/wd-ac276eab7c9c',
});
assert.equal(
  targetApiUrl(cloudWs, '/api/device/status'),
  'http://127.0.0.1:18088/remote/wd-ac276eab7c9c/api/device/status',
);
assert.equal(
  targetApiUrl(cloudWs, '/excel/a.xlsx'),
  'http://127.0.0.1:18088/remote/wd-ac276eab7c9c/excel/a.xlsx',
);

const remotePage = resolveConnectionTarget(
  'http://127.0.0.1:18088/remote/wd-ac276eab7c9c/orig/i.html',
  'http://127.0.0.1:18088',
);
assert.deepEqual(remotePage, {
  kind: 'cloud',
  label: '云端通道',
  deviceId: 'wd-ac276eab7c9c',
  wsUrl: 'ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c',
  apiBase: 'http://127.0.0.1:18088/remote/wd-ac276eab7c9c',
});

const invalid = resolveConnectionTarget('not a url', 'http://127.0.0.1:18088');
assert.equal(invalid.kind, 'invalid');
assert.match(invalid.error, /通信地址/);

console.log('connection target regression passed');
