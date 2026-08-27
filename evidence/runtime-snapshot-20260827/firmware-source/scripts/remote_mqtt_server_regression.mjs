import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const files = [
  'tools/remote_mqtt/docker-compose.yml',
  'tools/remote_mqtt/mosquitto/mosquitto.conf',
  'tools/remote_mqtt/server/package.json',
  'tools/remote_mqtt/server/src/index.js',
  'tools/remote_mqtt/server/src/mock_device.js',
  'tools/remote_mqtt/server/public/index.html',
  'tools/remote_mqtt/hotspot_mqtt_relay.py',
  'tools/remote_mqtt/start_hotspot_mqtt_relay.bat',
  'tools/remote_mqtt/README.md',
];

for (const file of files) {
  assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
}

const compose = readFileSync(resolve(root, 'tools/remote_mqtt/docker-compose.yml'), 'utf8');
assert.match(compose, /eclipse-mosquitto:2/, 'compose must use Mosquitto 2');
assert.match(compose, /1883:1883/, 'compose must expose MQTT port 1883');
assert.match(compose, /3000:3000/, 'compose must expose web port 3000');
assert.match(compose, /MQTT_URL=mqtt:\/\/mosquitto:1883/, 'server container must use Mosquitto service name');

const broker = readFileSync(resolve(root, 'tools/remote_mqtt/mosquitto/mosquitto.conf'), 'utf8');
assert.match(broker, /listener 1883 0\.0\.0\.0/, 'broker must listen on LAN-reachable 0.0.0.0');
assert.match(broker, /allow_anonymous true/, 'MVP broker must allow anonymous local testing');

const pkg = JSON.parse(readFileSync(resolve(root, 'tools/remote_mqtt/server/package.json'), 'utf8'));
assert.equal(pkg.type, 'module', 'server must use ES modules');
assert.equal(pkg.scripts.start, 'node src/index.js', 'server start script mismatch');
assert.equal(pkg.scripts.mock, 'node src/mock_device.js', 'mock script mismatch');
assert.ok(pkg.dependencies.express, 'server must depend on express');
assert.ok(pkg.dependencies.mqtt, 'server must depend on mqtt.js');

const server = readFileSync(resolve(root, 'tools/remote_mqtt/server/src/index.js'), 'utf8');
for (const token of [
  'wireless-debug',
  '/api/devices',
  '/api/devices/:id/status',
  '/api/devices/:id/command',
  '/events',
  'text/event-stream',
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
  'query_status',
  'COMMAND_TIMEOUT_MS = 8000',
  'publicPendingCommand',
]) {
  assert.ok(server.includes(token), `server missing ${token}`);
}
assert.ok(server.includes('.map(publicPendingCommand)'),
  'server must strip Timeout handles from pending_commands before JSON/SSE serialization');

const mock = readFileSync(resolve(root, 'tools/remote_mqtt/server/src/mock_device.js'), 'utf8');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/status'), 'mock must publish device status');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/cmd'), 'mock must subscribe to the command topic');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/ack'), 'mock must publish ACKs');

const relay = readFileSync(resolve(root, 'tools/remote_mqtt/hotspot_mqtt_relay.py'), 'utf8');
assert.ok(relay.includes('DEFAULT_LISTEN_HOST = "192.168.137.1"'),
  'hotspot relay must default to the Windows hotspot gateway');
assert.ok(relay.includes('DEFAULT_TARGET_HOST = "127.0.0.1"'),
  'hotspot relay must forward to the localhost MQTT port exposed by Docker Desktop/WSL');
assert.ok(relay.includes('threading.Thread'),
  'hotspot relay must handle MQTT connections without blocking future reconnects');
assert.ok(relay.includes('target.settimeout(None)'),
  'hotspot relay must keep established MQTT sockets blocking after connect timeout');

const relayBat = readFileSync(resolve(root, 'tools/remote_mqtt/start_hotspot_mqtt_relay.bat'), 'utf8');
assert.ok(relayBat.includes('hotspot_mqtt_relay.py'), 'Windows relay launcher must run the relay script');

const html = readFileSync(resolve(root, 'tools/remote_mqtt/server/public/index.html'), 'utf8');
assert.ok(html.includes('new EventSource'), 'dashboard must use SSE');
assert.ok(html.includes('/api/devices/${DEVICE_ID}/command'), 'dashboard must send commands to selected device');
assert.ok(html.includes('set_wifi_mode'), 'dashboard must expose WiFi mode command');
assert.ok(html.includes('set_uart_baud'), 'dashboard must expose UART baud command');
for (const token of [
  '远程设备控制台',
  'device-state-strip',
  'status-table',
  'renderDeviceStrip',
  'renderStatusTable',
  '消息服务',
  '命令确认',
  '接入点 IP',
  '联网 IP',
  '串口波特率',
  '网页通道',
  '远程控制',
  '命令日志',
  '下发中',
  '等待确认',
  '设备离线时控制项会自动锁定',
  ':focus-visible',
  'prefers-color-scheme: dark',
  'data-requires-online',
  'setControlsEnabled',
  'setCommandBusy',
  'formatTimestamp',
]) {
  assert.ok(html.includes(token), `professional dashboard missing ${token}`);
}
assert.ok(!html.includes('Wireless Debug Remote</h1>'),
  'dashboard must not keep the old demo-style English title');
for (const staleToken of [
  'summary-grid',
  'summary-card',
  'status-section',
  'renderSummary',
  'renderStatusSections',
]) {
  assert.ok(!html.includes(staleToken), `dashboard must remove old card-heavy structure: ${staleToken}`);
}

const readme = readFileSync(resolve(root, 'tools/remote_mqtt/README.md'), 'utf8');
assert.ok(readme.includes('start_hotspot_mqtt_relay.bat'),
  'README must document the Windows hotspot relay for ESP32 access');
assert.ok(readme.includes('192.168.137.1:1883'),
  'README must document the hotspot MQTT endpoint expected by firmware');

console.log('remote MQTT service regression passed');
