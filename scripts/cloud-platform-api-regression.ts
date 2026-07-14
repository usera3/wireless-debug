import { strict as assert } from 'node:assert';
import {
  cloudDeviceConsolePath,
  cloudPlatformApiUrl,
  isAuthRequiredResponse,
  normalizeCloudDevice,
} from '../src/lib/cloudPlatformApi';

assert.equal(cloudPlatformApiUrl('/api/devices'), '/api/devices');
assert.equal(cloudPlatformApiUrl('api/devices'), '/api/devices');

const row = normalizeCloudDevice({
  device_id: 'wd-ac276eab7c9c',
  display_name: 'ESP32-001',
  cloud_state: 'online',
  status: {
    wifi_mode: 'apsta',
    sta_ip: '10.162.92.4',
    ap_ip: '192.168.4.1',
    ble_ready: true,
    uart_baud: 2000000,
    cloud_ws_uplink: { connected: true },
  },
  last_seen_ms: Date.now(),
});

assert.equal(row.deviceId, 'wd-ac276eab7c9c');
assert.equal(row.displayName, 'ESP32-001');
assert.equal(row.online, true);
assert.equal(row.staIp, '10.162.92.4');
assert.equal(row.apIp, '192.168.4.1');
assert.equal(row.bleState, '就绪');
assert.equal(row.wsState, '已接入');
assert.equal(row.uartBaud, '2000000');
assert.equal(cloudDeviceConsolePath(row.deviceId), '/remote/wd-ac276eab7c9c/orig/i.html');
assert.equal(isAuthRequiredResponse(401), true);
assert.equal(isAuthRequiredResponse(403), true);
assert.equal(isAuthRequiredResponse(500), false);

console.log('cloud platform API regression passed');
