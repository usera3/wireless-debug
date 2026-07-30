import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const base = 'tools/remote_mqtt_python';
const files = [
  `${base}/README.md`,
  `${base}/.env.example`,
  `${base}/requirements.txt`,
  `${base}/app.py`,
  `${base}/ws_fanout.py`,
  `${base}/schema.sql`,
  `${base}/Dockerfile`,
  `${base}/docker-compose.yml`,
  `${base}/static/cloud.html`,
];

for (const file of files) {
  assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
}

const requirements = readFileSync(resolve(root, `${base}/requirements.txt`), 'utf8');
for (const token of ['Flask', 'paho-mqtt', 'psycopg', 'waitress']) {
  assert.ok(requirements.includes(token), `requirements missing ${token}`);
}
assert.ok(requirements.includes('websockets'), 'requirements missing websockets');

const schema = readFileSync(resolve(root, `${base}/schema.sql`), 'utf8');
for (const token of [
  'create table if not exists cloud_devices',
  'create table if not exists cloud_device_status_events',
  'create table if not exists cloud_device_commands',
  'create table if not exists cloud_device_notes',
  'last_status_json jsonb',
  'payload_json jsonb',
  'args_json jsonb',
  'idx_cloud_devices_last_seen',
  'idx_cloud_devices_display_name_unique',
  'where display_name is not null',
  'device_mac varchar(32)',
  'alter table cloud_devices add column if not exists device_mac',
  'create table if not exists cloud_bus_messages',
  'create table if not exists cloud_message_subscriptions',
  'message_id varchar(96) not null unique',
  'source_type varchar(32) not null',
  'source_id varchar(128) not null',
  'target_type varchar(32) not null',
  'target_id varchar(128) not null',
  'channel varchar(32) not null',
  'payload_text text not null',
  'payload_json jsonb not null default',
  'idx_cloud_bus_messages_created',
  'idx_cloud_message_subscriptions_subscriber',
]) {
  assert.ok(schema.includes(token), `schema missing ${token}`);
}

const app = readFileSync(resolve(root, `${base}/app.py`), 'utf8');
for (const token of [
  'from flask import Flask',
  'import paho.mqtt.client as mqtt',
  'import psycopg',
  'wireless-debug/+/status',
  'wireless-debug/+/availability',
  'wireless-debug/+/ack',
  'wireless-debug/+/pub',
  'wireless-debug/+/bus-ack',
  '/api/devices',
  '/api/devices/<device_id>',
  '/api/devices/<device_id>/history',
  '/api/devices/<device_id>/query-status',
  '/api/devices/<device_id>/display-name',
  '/api/devices/<device_id>/note',
  '/api/bus/messages',
  '/api/bus/send',
  '/remote/<device_id>/orig/',
  '/remote/<device_id>/wifi.html',
  '/remote/<device_id>/excel/<path:filename>',
  '/remote/<device_id>/api/<path:path>',
  '/remote/<device_id>/ws/send',
  '/remote/<device_id>/ws/poll',
  'REMOTE_EXCEL_DIR',
  'REMOTE_EXCEL_MAX_BYTES',
  'render_remote_console_html',
  'remote_console_asset_version',
  "response.headers['Cache-Control'] = 'no-store, max-age=0'",
  '无线调试页面加载失败',
  'remote_console_wifi_html',
  'remote_console_rewrite_script',
  '__WIRELESS_REMOTE_WS_URL',
  'enqueue_remote_ws_frame',
  'remote_ws_send',
  'remote_ws_poll',
  'normalize_excel_filename',
  'remote_excel_list',
  'remote_excel_upload',
  'remote_excel_delete',
  'remote_excel_download',
  'REMOTE_WS_FRAME_LIMIT',
  'CLOUD_WS_PORT',
  'CLOUD_WS_PUBLIC_URL',
  'start_cloud_ws_server',
  'publish_remote_ws_frame',
  'broadcast_remote_ws_frame',
  '/ws/device/',
  'proxy_remote_device_api',
  'virtual_device_status',
  'virtual_wifi_status',
  '云端控制台不允许切换 WiFi 模式',
  'query_status',
  'record_bus_ack',
  'record_device_bus_publish',
  'publish_bus_message',
  'route_device_publication',
  'ALLOWED_BUS_CHANNELS',
  'notify',
  'wireless-debug/{deviceId}/inbox',
  'cloud_bus_messages',
  'cloud_message_subscriptions',
  'next_auto_display_name',
  'ensure_device_display_name',
  'save_display_name',
  'ESP32-001',
  'cloud_devices',
  'cloud_device_commands',
  'last_status_json ->>',
  'latency_ms',
  'diagnose_device_state',
  'health_score',
  'diagnostic_level',
  'diagnostic_reasons',
  'heap_free',
  'restart_reason',
  'comm_error_total',
  'display_status',
  'motor_param_count',
  'device_mac',
  'extract_cloud_metrics',
]) {
  assert.ok(app.includes(token), `app missing ${token}`);
}

assert.ok(app.includes('CLOUD_HTTP_USER'), 'app must support optional basic auth user');
assert.ok(app.includes('CLOUD_HTTP_PASSWORD'), 'app must support optional basic auth password');
assert.ok(app.includes('DATABASE_URL'), 'app must read DATABASE_URL');
assert.ok(app.includes('MQTT_URL'), 'app must read MQTT_URL');
assert.ok(app.includes('ORIG_WEB_DIR'), 'app must support configurable ORIG_WEB_DIR');
assert.ok(app.includes("os.environ.get('ORIG_WEB_DIR')"), 'app must read ORIG_WEB_DIR from the environment');
assert.ok(!app.includes("'stale'"), 'backend must not expose a stale/suspected-offline device state');
assert.ok(!app.includes('"stale"'), 'backend must not expose a stale/suspected-offline device state');

for (const dangerous of [
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'display_text',
  'ble_start',
  'quick_connect',
  'web_provision',
  'clear_wifi',
  'mqtt_url',
  'ota',
  'reboot',
]) {
  assert.ok(!new RegExp(`type\\s*[:=]\\s*['"]${dangerous}['"]`).test(app), `app exposes dangerous command ${dangerous}`);
}

const compose = readFileSync(resolve(root, `${base}/docker-compose.yml`), 'utf8');
for (const token of [
  'postgres:',
  'mosquitto:',
  'cloud:',
  '${APP_PORT:-18088}:18088',
  'DATABASE_URL',
  'MQTT_URL',
  'PIP_INDEX_URL',
  'REMOTE_EXCEL_DIR',
  'REMOTE_EXCEL_MAX_BYTES',
  'ORIG_WEB_DIR',
  'CLOUD_WS_PORT',
  'CLOUD_WS_PUBLIC_URL',
  './data:/app/data',
  '../../dist/orig:/app/orig:ro',
]) {
  assert.ok(compose.includes(token), `compose missing ${token}`);
}

const dockerfile = readFileSync(resolve(root, `${base}/Dockerfile`), 'utf8');
for (const token of ['python:', 'PIP_INDEX_URL', 'pip install', 'requirements.txt', 'ws_fanout.py', 'waitress-serve', '18089']) {
  assert.ok(dockerfile.includes(token), `Dockerfile missing ${token}`);
}

const envExample = readFileSync(resolve(root, `${base}/.env.example`), 'utf8');
for (const token of [
  'APP_PORT=18088',
  'DATABASE_URL=postgresql://wireless_debug:wireless_debug@127.0.0.1:5432/wireless_debug',
  'MQTT_URL=mqtt://127.0.0.1:1883',
  'PIP_INDEX_URL=',
  'REMOTE_EXCEL_DIR=',
  'REMOTE_EXCEL_MAX_BYTES=',
  'ORIG_WEB_DIR=',
  'CLOUD_WS_PORT=18089',
  'CLOUD_WS_PUBLIC_URL=',
  'CLOUD_WS_BROWSER_QUEUE_FRAMES=16',
]) {
  assert.ok(envExample.includes(token), `.env.example missing ${token}`);
}

const html = readFileSync(resolve(root, `${base}/static/cloud.html`), 'utf8');
for (const token of [
  '无线调试云端观测台',
  '/api/devices',
  'query-status',
  '设备总览',
  '设备详情',
  '设备名',
  'displayNameInput',
  'saveDisplayName',
  '连接状态',
  '诊断摘要',
  '健康评分',
  '系统资源',
  '设备标识',
  '硬件 MAC',
  '通信错误',
  'OLED 状态',
  '参数数量',
  '连接历史',
  '最近状态摘要',
  '能力清单',
  'data-tab="overview"',
  'data-tab="device"',
  'data-tab="connectivity"',
  'data-tab="history"',
  'data-tab="messages"',
  'data-tab="capabilities"',
  'data-tab="events"',
  '消息中心',
  '控制台',
  'openRemoteConsole',
  '/remote/${encodeURIComponent(device.device_id)}/orig/i.html',
  '云端发送',
  'busTargetDevice',
  'busChannel',
  'busPayload',
  'sendBusMessage',
  'busMessageRows',
  '/api/bus/send',
  '/api/bus/messages',
  'renderMessageCenter',
  'connectionGrid',
  'diagnosticGrid',
  'systemGrid',
  'capabilityGrid',
  'trendSnapshot',
  'function currentBoolText(device, value, yes, no)',
  "if (!isDeviceOnline(device)) return '未知';",
  'currentBoolText(device, payload.ble_ready',
  'currentBoolText(device, payload.wifi_ws_client',
  'currentBoolText(device, payload.sta_connected ?? device.sta_connected',
  '${device.display_name || device.device_id} 当前连接状态',
  '${device.display_name || device.device_id} 当前诊断',
  'renderDiagnostics',
  'function boolStatus(cloudState, value, yes, no)',
  "if (cloudState !== 'online') return '<span class=\"muted\">-</span>';",
  'boolStatus(device.cloud_state, device.ble_ready',
  'boolStatus(device.cloud_state, device.wifi_ws_client',
  ':hover',
  '最近事件',
  '云端当前只开放安全查询',
]) {
  assert.ok(html.includes(token), `cloud UI missing ${token}`);
}
assert.ok(!html.includes('疑似离线'), 'cloud UI must not show suspected-offline wording');
assert.ok(!html.includes('stale'), 'cloud UI must not use stale state');
assert.ok(!app.includes('window.WebSocket = RemoteWebSocket'), 'cloud remote console must use native browser WebSocket');
const recordBusPublish = app.match(
  /def record_device_bus_publish\(device_id, payload\):([\s\S]*?)\n\ndef /,
)?.[1] || '';
const wsFastPath = recordBusPublish.match(
  /if str\(publication\.get\('channel'\)[\s\S]*?\n\s+channel = normalize_bus_channel/,
)?.[0] || '';
assert.ok(wsFastPath, 'device ws publication must have an early-return fast path');
assert.ok(
  !wsFastPath.includes('db_connect()'),
  'high-rate device ws frames must not open a PostgreSQL connection per frame',
);
assert.ok(
  wsFastPath.includes('enqueue_remote_ws_frame'),
  'device ws fast path must enqueue and broadcast the payload',
);
assert.ok(
  !wsFastPath.includes('cloud_ws_uplink_connected(device_id)'),
  'late MQTT fallback frames must survive a fast binary-uplink reconnect',
);
assert.match(
  app,
  /def cloud_ws_uplink_connected\(device_id\):[\s\S]*cloud_ws_downlinks\.connected\(device_id\)/,
  'backend must expose the serialized router binary-uplink presence check',
);
for (const token of [
  'cloud_ws_downlinks',
  "prefix = '/ws/uplink/'",
  'cloud_ws_browser_handler',
  'cloud_ws_uplink_handler',
  'send_cloud_ws_downlink',
  'broadcast_remote_ws_bytes',
  'BrowserSendPump',
  'DeviceDownlinkRouter',
  'CLOUD_WS_BROWSER_QUEUE_FRAMES',
  'CLOUD_WS_MAX_MESSAGE_BYTES',
  "'ws_browser_dropped_frames'",
  'cloud_ws_browser_dropped_frames_total',
  'note_cloud_ws_browser_drop',
  "cloud websocket uplink connected",
  "'ws_uplink_devices'",
  "'ws_browser_clients'",
  "'ws_downlink_sent_frames'",
  "'ws_downlink_sent_bytes'",
  "'ws_downlink_dropped_frames'",
  "'ws_downlink_send_failures'",
]) {
  assert.ok(app.includes(token), `binary WebSocket uplink missing backend token: ${token}`);
}
const broadcastBody = app.match(
  /def broadcast_remote_ws_bytes\(device_id, payload\):([\s\S]*?)\n\ndef /,
)?.[1] || '';
assert.ok(broadcastBody.includes('sender.enqueue(data)'), 'browser waveform fan-out must use non-blocking sender queues');
assert.ok(!broadcastBody.includes('.send(data)'), 'uplink receive path must not synchronously send to browsers');
const uplinkHandler = app.match(
  /def cloud_ws_uplink_handler\(connection: ServerConnection, device_id\):([\s\S]*?)\n\ndef /,
)?.[1] || '';
assert.ok(uplinkHandler, 'backend must define a device uplink handler');
assert.ok(
  uplinkHandler.includes('decoded = session.decode(data)') &&
    uplinkHandler.includes('broadcast_remote_ws_bytes(device_id, decoded)'),
  'device uplink envelopes must be losslessly decoded before browser fan-out',
);
assert.ok(!uplinkHandler.includes('db_connect()'), 'device uplink must not access PostgreSQL');
assert.ok(!uplinkHandler.includes('mqtt_client'), 'device uplink must not route waveform data through MQTT');
assert.ok(
  uplinkHandler.includes('cloud_ws_downlinks.attach(device_id, connection)') &&
    uplinkHandler.includes('cloud_ws_downlinks.detach(device_id, connection)'),
  'device uplink lifecycle must be owned by the serialized direct-downlink router',
);
const browserHandler = app.match(
  /def cloud_ws_browser_handler\(connection: ServerConnection, device_id\):([\s\S]*?)\n\ndef /,
)?.[1] || '';
assert.ok(browserHandler, 'backend must define a browser websocket handler');
assert.ok(
  browserHandler.includes('send_cloud_ws_downlink(device_id, data)'),
  'browser UART frames must be sent directly through the device websocket',
);
assert.ok(
  !browserHandler.includes('publish_remote_ws_frame') &&
    !browserHandler.includes('mqtt_client'),
  'browser websocket downlink must never fall back to MQTT',
);
const devicePublishBody = app.match(
  /def record_device_bus_publish\(device_id, payload\):([\s\S]*?)\n\ndef /,
)?.[1] || '';
assert.ok(
  !devicePublishBody.includes('if cloud_ws_uplink_connected(device_id):'),
  'late MQTT fallback frames must not be discarded merely because binary uplink has reconnected',
);
assert.match(
  uplinkHandler,
  /except ConnectionClosed as exc:[\s\S]*exc\.code[\s\S]*exc\.reason/,
  'device uplink must log websocket close code and reason',
);
assert.match(
  app,
  /CLOUD_WS_MAX_MESSAGE_BYTES\s*=\s*int\(os\.environ\.get\('CLOUD_WS_MAX_MESSAGE_BYTES', '65536'\)\)[\s\S]*max_size=CLOUD_WS_MAX_MESSAGE_BYTES/,
  'cloud WebSocket server must accept the maximum negotiated waveform envelope',
);
assert.ok(
  /def cloud_ws_handler\(connection: ServerConnection\):[\s\S]*cloud_ws_uplink_device_id[\s\S]*cloud_ws_uplink_handler/.test(app),
  'root WebSocket handler must dispatch the uplink role separately',
);
assert.ok(
  app.includes("if (url.origin !== window.location.origin) return raw;"),
  'remote console must preserve absolute LAN API and navigation targets',
);
assert.ok(
  app.includes("url.pathname === '/wifi.html'"),
  'remote console must keep local WiFi navigation compatible with target switching',
);
for (const removedToken of [
  '网络模式分布',
  'modeGrid',
  'renderModeDistribution',
  'dashboard-grid',
  'drawBooleanTimeline',
  '诊断趋势',
  '<h2>STA 连接时间线</h2>',
  '<h2>命令延迟</h2>',
  '<h2>系统资源趋势</h2>',
  '<h2>命令质量</h2>',
  'historyChart',
  'transportChart',
  'resourceChart',
  'commandQualityChart',
  'drawConnectionTimeline',
  'drawLatencyChart',
  'drawResourceChart',
  'drawCommandQualityChart',
]) {
  assert.ok(!html.includes(removedToken), `cloud UI should not include removed overview mode distribution token ${removedToken}`);
}
assert.match(
  html,
  /async function loadDevices\(\)[\s\S]*state\.devices = data\.devices \|\| \[\];[\s\S]*renderSummary\(data\.summary \|\| \{\}\);[\s\S]*renderRows\(\);[\s\S]*await loadDetail\(state\.selectedId, false\);/,
  'initial device loading must render overview rows before loading selected detail',
);

console.log('remote MQTT Python cloud regression passed');
