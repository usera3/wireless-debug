import { strict as assert } from 'node:assert';
import {
  buildCloudDeviceUrl,
  cloudDeviceIdFromUrl,
  connectionChoiceFromUrl,
  onlineCloudDevices,
} from '../src/lib/connectionSelection';

const devices = onlineCloudDevices([
  { device_id: 'wd-offline', display_name: '离线设备', cloud_state: 'offline' },
  { device_id: 'wd-online-b', display_name: '测试台', cloud_state: 'online' },
  { device_id: 'wd-online-a', display_name: '办公室', cloud_state: 'online' },
]);
assert.deepEqual(devices.map((device) => device.displayName), ['办公室', '测试台']);
assert.equal(buildCloudDeviceUrl('http://43.153.137.20:18088', 'wd-online-a'), 'ws://43.153.137.20:18089/ws/device/wd-online-a');
assert.equal(buildCloudDeviceUrl('https://cloud.example.com', 'wd-online-a'), 'wss://cloud.example.com/ws/device/wd-online-a');
assert.equal(connectionChoiceFromUrl('http://192.168.4.1'), 'local');
assert.equal(connectionChoiceFromUrl('ws://43.153.137.20:18089/ws/device/wd-online-a'), 'cloud');
assert.equal(connectionChoiceFromUrl('ws://10.0.0.8/ws'), 'custom');
assert.equal(cloudDeviceIdFromUrl('ws://43.153.137.20:18089/ws/device/wd-online-a'), 'wd-online-a');
assert.equal(cloudDeviceIdFromUrl('http://43.153.137.20:18088/remote/wd-online-b/orig/i.html'), 'wd-online-b');
console.log('connection selection regression passed');
