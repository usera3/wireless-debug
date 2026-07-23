import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const required = [
  'main/cloud_mqtt.h',
  'main/cloud_mqtt.c',
  'main/Kconfig.projbuild',
];

for (const file of required) {
  assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
}

const header = readFileSync(resolve(root, 'main/cloud_mqtt.h'), 'utf8');
for (const token of [
  'cloud_mqtt_config_t',
  'cloud_mqtt_runtime_t',
  'cloud_mqtt_init',
  'cloud_mqtt_notify_wifi_state',
  'cloud_mqtt_publish_status_now',
  'cloud_mqtt_publish_ws_frame',
  'cloud_mqtt_note_realtime_control',
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
  'get_comm_stats',
  'get_display_stats',
  'get_menu_snapshot',
  'get_motor_param_count',
  'get_motor_param_capacity',
  'device_mac',
]) {
  assert.ok(header.includes(token), `cloud_mqtt.h missing ${token}`);
}

const source = readFileSync(resolve(root, 'main/cloud_mqtt.c'), 'utf8');
for (const token of [
  'CLOUD_MQTT_STATUS_INTERVAL_US',
  'wireless-debug/%s/status',
  'wireless-debug/%s/availability',
  'wireless-debug/%s/cmd',
  'wireless-debug/%s/ack',
  'wireless-debug/%s/inbox',
  'wireless-debug/%s/bus-ack',
  'query_status',
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
  'status->mode != SYSTEM_NET_AP',
  'net_mode_json_name',
  'comm_mode_json_name',
  'esp_get_free_heap_size',
  'esp_reset_reason',
  'heap_caps_get_largest_free_block',
  'comm_stats_snapshot_t',
  'display_port_stats_t',
  '"restart_reason"',
  '"heap"',
  '"comm_stats"',
  '"display"',
  '"menu"',
  '"motor_params"',
  '"device_mac"',
]) {
  assert.ok(source.includes(token), `cloud_mqtt.c missing ${token}`);
}

assert.match(source, /esp_mqtt_client_register_event/, 'MQTT event handler must be registered');
assert.match(source, /cJSON_Parse/, 'commands must use cJSON parsing');
assert.match(source, /cJSON_PrintUnformatted/, 'status and ACK payloads must use structured JSON');

const cmake = readFileSync(resolve(root, 'main/CMakeLists.txt'), 'utf8');
assert.ok(cmake.includes('"cloud_mqtt.c"'), 'CMake must compile cloud_mqtt.c');
assert.match(cmake, /REQUIRES[\s\S]*\bmqtt\b/, 'CMake REQUIRES must include mqtt');
assert.match(cmake, /REQUIRES[\s\S]*\bcjson\b/, 'CMake REQUIRES must include cjson');

const manifest = readFileSync(resolve(root, 'main/idf_component.yml'), 'utf8');
assert.match(manifest, /espressif\/mqtt:\s*\^1\.0\.0/, 'main manifest must add espressif/mqtt dependency for ESP-IDF 6');
assert.match(manifest, /espressif\/cjson:/, 'main manifest must add espressif/cjson dependency for cJSON.h');

const kconfig = readFileSync(resolve(root, 'main/Kconfig.projbuild'), 'utf8');
assert.ok(kconfig.includes('config CLOUD_MQTT_ENABLE'), 'missing CLOUD_MQTT_ENABLE');
assert.ok(kconfig.includes('config CLOUD_MQTT_DEVICE_ID'), 'missing CLOUD_MQTT_DEVICE_ID');
assert.ok(kconfig.includes('config CLOUD_MQTT_URI'), 'missing CLOUD_MQTT_URI');
assert.ok(kconfig.includes('default "auto"'), 'default device ID must auto-generate from MAC for multi-device fleets');
assert.ok(kconfig.includes('default "mqtt://43.153.137.20:1883"'),
  'default MQTT URI must target the shared cloud broker');
assert.ok(kconfig.includes('default "ws://43.153.137.20:18089"'),
  'default binary WebSocket URI must target the shared cloud uplink');

const sdkconfig = readFileSync(resolve(root, 'sdkconfig'), 'utf8');
assert.ok(sdkconfig.includes('CONFIG_CLOUD_MQTT_DEVICE_ID="auto"'),
  'sdkconfig device ID must auto-generate from MAC for this fleet build');
assert.ok(sdkconfig.includes('CONFIG_CLOUD_MQTT_URI="mqtt://43.153.137.20:1883"'),
  'sdkconfig MQTT URI must target the shared cloud broker for this fleet build');
assert.ok(sdkconfig.includes('CONFIG_CLOUD_WS_UPLINK_URI="ws://43.153.137.20:18089"'),
  'sdkconfig binary WebSocket URI must target the shared cloud uplink');

for (const token of [
  'parse_net_mode',
  'parse_comm_mode',
  'handle_set_wifi_mode',
  'handle_set_uart_baud',
  'handle_set_comm_mode',
  'handle_ble_start',
  'handle_display_text',
  'handle_bus_message',
  'publish_bus_ack',
  'message_id',
  'payload_text',
  'payload_hex',
  'source_type',
  'source_id',
  'channel',
  'notify',
  'ws',
  'handle_bus_ws_frame',
  'publish_ws_frame',
  'send_ws_frame',
  'cloud_mqtt_note_realtime_control',
  's_runtime.set_wifi_mode',
  's_runtime.set_uart_baud',
  's_runtime.set_comm_mode',
  's_runtime.ble_start',
  's_runtime.display_text',
  's_runtime.get_comm_stats',
  's_runtime.get_display_stats',
  's_runtime.get_menu_snapshot',
  'publish_ack(command_id_text, type_text, true',
]) {
  assert.ok(source.includes(token), `cloud_mqtt.c missing command execution token ${token}`);
}

assert.match(source, /esp_mqtt_client_subscribe\(s_client,\s*s_inbox_topic,\s*1\)/,
  'cloud MQTT must subscribe to per-device inbox topic');
assert.match(source, /strncmp\(event->topic,\s*s_inbox_topic,\s*event->topic_len\)/,
  'cloud MQTT event handler must route inbox topic to bus handler');
assert.match(source, /s_runtime\.display_text\(payload_text/,
  'notify channel must render message text through the display callback');

assert.ok(!source.includes('command scaffold only'), 'command scaffold message must be removed');

assert.match(
  source,
  /void cloud_mqtt_note_realtime_control\(const uint8_t \*data, size_t len\)[\s\S]*is_osc_stop_frame[\s\S]*ws_osc_state_set\(false, 0\)[\s\S]*ws_osc_state_refresh[\s\S]*cloud_ws_uplink_set_active/,
  'direct WSS controls must use the existing stop/non-stop response lease policy',
);

const main = readFileSync(resolve(root, 'main/main.c'), 'utf8');
for (const token of [
  '#include "cloud_mqtt.h"',
  '#include "esp_mac.h"',
  'build_cloud_device_identity',
  's_cloud_device_id',
  's_cloud_device_mac',
  'cloud_mqtt_runtime_t cloud_runtime',
  'cloud_mqtt_config_t cloud_config',
  'CONFIG_CLOUD_MQTT_DEVICE_ID',
  '.device_mac = s_cloud_device_mac',
  'CONFIG_CLOUD_MQTT_URI',
  'CONFIG_CLOUD_MQTT_ENABLE',
  'cloud_mqtt_init(&cloud_config, &cloud_runtime)',
  'cloud_mqtt_notify_wifi_state(status)',
  'cloud_set_wifi_mode',
  'cloud_set_uart_baud',
  'cloud_set_comm_mode',
  'cloud_ble_start',
  'cloud_display_text',
  'cloud_get_comm_stats',
  'cloud_get_display_stats',
  'cloud_get_menu_snapshot',
  'cloud_get_motor_param_count',
  'cloud_get_motor_param_capacity',
]) {
  assert.ok(main.includes(token), `main.c missing cloud MQTT wiring token ${token}`);
}

console.log('cloud MQTT contract regression passed');
