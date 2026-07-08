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
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
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
  'query_status',
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
  'status->mode != SYSTEM_NET_AP',
  'net_mode_json_name',
  'comm_mode_json_name',
]) {
  assert.ok(source.includes(token), `cloud_mqtt.c missing ${token}`);
}

assert.match(source, /esp_mqtt_client_register_event/, 'MQTT event handler must be registered');
assert.match(source, /cJSON_Parse/, 'commands must use cJSON parsing');
assert.match(source, /cJSON_PrintUnformatted/, 'status and ACK payloads must use structured JSON');

const cmake = readFileSync(resolve(root, 'main/CMakeLists.txt'), 'utf8');
assert.ok(cmake.includes('"cloud_mqtt.c"'), 'CMake must compile cloud_mqtt.c');
assert.match(cmake, /REQUIRES[\s\S]*\bmqtt\b/, 'CMake REQUIRES must include mqtt');
assert.match(cmake, /REQUIRES[\s\S]*\bjson\b/, 'CMake REQUIRES must include json');

const manifest = readFileSync(resolve(root, 'main/idf_component.yml'), 'utf8');
assert.match(manifest, /espressif\/mqtt:\s*\^1\.0\.0/, 'main manifest must add espressif/mqtt dependency for ESP-IDF 6');

const kconfig = readFileSync(resolve(root, 'main/Kconfig.projbuild'), 'utf8');
assert.ok(kconfig.includes('config CLOUD_MQTT_ENABLE'), 'missing CLOUD_MQTT_ENABLE');
assert.ok(kconfig.includes('config CLOUD_MQTT_DEVICE_ID'), 'missing CLOUD_MQTT_DEVICE_ID');
assert.ok(kconfig.includes('config CLOUD_MQTT_URI'), 'missing CLOUD_MQTT_URI');
assert.ok(kconfig.includes('default "esp32-001"'), 'default device ID mismatch');

console.log('cloud MQTT contract regression passed');
