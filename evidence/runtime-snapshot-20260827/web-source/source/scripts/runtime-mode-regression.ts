import { strict as assert } from 'node:assert';
import { detectRuntimeInfo } from '../src/lib/runtimeMode';

const local = detectRuntimeInfo('http://192.168.4.1/orig/i.html');
assert.equal(local.mode, 'local-device');
assert.equal(local.deviceId, null);
assert.equal(local.defaultConnectionUrl, 'http://192.168.4.1');

const cloudPlatform = detectRuntimeInfo('https://wd.claudcode.xyz/cloud.html#overview');
assert.equal(cloudPlatform.mode, 'cloud-platform');
assert.equal(cloudPlatform.deviceId, null);
assert.equal(cloudPlatform.defaultConnectionUrl, null);

const remoteByPath = detectRuntimeInfo('https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html');
assert.equal(remoteByPath.mode, 'cloud-device');
assert.equal(remoteByPath.deviceId, 'wd-ac276eab7c9c');
assert.equal(
  remoteByPath.defaultConnectionUrl,
  'wss://wd.claudcode.xyz/ws/device/wd-ac276eab7c9c',
);

const remoteByGlobal = detectRuntimeInfo('https://wd.claudcode.xyz/custom/i.html', {
  remoteDeviceId: 'wd-global',
  remoteWsUrl: 'wss://wd.claudcode.xyz/ws/device/wd-global',
});
assert.equal(remoteByGlobal.mode, 'cloud-device');
assert.equal(remoteByGlobal.deviceId, 'wd-global');
assert.equal(remoteByGlobal.defaultConnectionUrl, 'wss://wd.claudcode.xyz/ws/device/wd-global');

console.log('runtime mode regression passed');
