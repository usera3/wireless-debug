import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync('main/main.c', 'utf8');
const cmake = readFileSync('main/CMakeLists.txt', 'utf8');
const uartWs = readFileSync('main/wifi_transport.c', 'utf8');
const page = readFileSync('dist/wifi.html', 'utf8');
const statusWs = readFileSync('main/wifi_status_ws.c', 'utf8');
const statusWsHeader = readFileSync('main/wifi_status_ws.h', 'utf8');

assert.match(
  statusWs,
  /\.uri\s*=\s*"\/ws\/wifi-status"[\s\S]*?\.is_websocket\s*=\s*true/,
  'Wi-Fi provisioning status must use its own WebSocket route',
);
assert.match(
  uartWs,
  /\.uri\s*=\s*"\/ws"[\s\S]*?\.is_websocket\s*=\s*true/,
  'UART tunnel must remain on /ws',
);
assert.doesNotMatch(
  uartWs,
  /wifi-status/,
  'provisioning status must not share UART tunnel client state',
);

for (const token of [
  'wifi_status_ws_register',
  'wifi_status_ws_publish',
  'wifi_status_ws_client_connected',
]) {
  assert.ok(statusWsHeader.includes(token), `Wi-Fi status WebSocket API missing ${token}`);
}
assert.ok(cmake.includes('wifi_status_ws.c'), 'Wi-Fi status WebSocket source is not built');
assert.match(
  main,
  /wifi_manager_wifi_state_changed[\s\S]*?wifi_status_ws_publish\(status\)/,
  'every Wi-Fi manager state update must be forwarded to the status WebSocket',
);
assert.match(
  main,
  /wifi_status_ws_register\(g_server[\s\S]*?web_static_register_handlers/,
  'status WebSocket must be registered before the wildcard static handler',
);

assert.match(
  statusWs,
  /httpd_queue_work\(/,
  'Wi-Fi event callbacks must queue status delivery instead of sending inline',
);
assert.match(
  statusWs,
  /httpd_ws_send_frame_async\(/,
  'queued status delivery must use the HTTP server WebSocket API',
);
assert.match(
  statusWs,
  /sta_connecting[\s\S]*?sta_connected[\s\S]*?sta_ip/,
  'pushed snapshots must contain the connection state rendered by the page',
);

assert.ok(page.includes('/ws/wifi-status'), 'provisioning page does not open the status WebSocket');
assert.match(
  page,
  /onmessage[\s\S]*?renderWifiStatus\(data\)[\s\S]*?data\.sta_connected[\s\S]*?setBusy\(false\)/,
  'a pushed connected snapshot must immediately complete the UI workflow',
);
assert.match(
  page,
  /onclose[\s\S]*?scheduleStatusSocketReconnect/,
  'the status WebSocket must reconnect after the AP channel transition',
);
assert.match(
  page,
  /fetchWifiStatus\(CONNECT_STATUS_TIMEOUT_MS\)/,
  'sequential HTTP status polling must remain as a fallback',
);

console.log('wifi status push regression passed');
