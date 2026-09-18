import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const base = 'tools/remote_mqtt_nodered';
const files = [
  `${base}/README.md`,
  `${base}/.env.example`,
  `${base}/docker-compose.yml`,
  `${base}/mosquitto/mosquitto.conf`,
  `${base}/postgres/init/001_schema.sql`,
  `${base}/nodered/Dockerfile`,
  `${base}/nodered/settings.js`,
  `${base}/nodered/flows.json`,
  `${base}/nodered/public/cloud.html`,
];

for (const file of files) {
  assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
}

const compose = readFileSync(resolve(root, `${base}/docker-compose.yml`), 'utf8');
for (const token of [
  'postgres:',
  'mosquitto:',
  'nodered:',
  '${POSTGRES_IMAGE:-postgres:18-alpine}',
  '${MOSQUITTO_IMAGE:-eclipse-mosquitto:2}',
  'NODERED_BASE_IMAGE: ${NODERED_BASE_IMAGE:-nodered/node-red:latest}',
  'NPM_REGISTRY: ${NPM_REGISTRY:-}',
  'restart: unless-stopped',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  './postgres/init:/docker-entrypoint-initdb.d:ro',
  './nodered/flows.json:/data/flows.json:ro',
  './nodered/settings.js:/data/settings.js:ro',
  './nodered/public:/data/public:ro',
  '"${MQTT_PORT:-1883}:1883"',
  '"${NODERED_PORT:-1880}:1880"',
]) {
  assert.ok(compose.includes(token), `compose missing ${token}`);
}

const schema = readFileSync(resolve(root, `${base}/postgres/init/001_schema.sql`), 'utf8');
for (const token of [
  'create table if not exists devices',
  'create table if not exists device_status_events',
  'create table if not exists device_commands',
  'create table if not exists device_notes',
  'last_status_json jsonb',
  'payload_json jsonb',
  'args_json jsonb',
  'idx_devices_last_seen',
  'idx_device_status_events_device_created',
  'idx_device_commands_device_created',
]) {
  assert.ok(schema.includes(token), `schema missing ${token}`);
}

const dockerfile = readFileSync(resolve(root, `${base}/nodered/Dockerfile`), 'utf8');
assert.ok(dockerfile.includes('nodered/node-red'), 'Node-RED image must be used');
assert.ok(dockerfile.includes('ARG NODERED_BASE_IMAGE'), 'Node-RED base image must be configurable');
assert.ok(dockerfile.includes('ARG NPM_REGISTRY'), 'npm registry must be configurable for cloud builds');
assert.ok(/npm install[\s\S]*\bpg\b/.test(dockerfile), 'Node-RED image must install pg for PostgreSQL access');

const settings = readFileSync(resolve(root, `${base}/nodered/settings.js`), 'utf8');
assert.ok(settings.includes("pg: require('pg')"), 'settings must expose pg to Function nodes');
assert.ok(settings.includes("crypto: require('crypto')"), 'settings must expose crypto to Function nodes');
assert.ok(settings.includes('credentialSecret'), 'settings must support credentialSecret env config');
assert.ok(settings.includes("httpStatic: '/data/public'"), 'settings must serve the cloud UI as static files');
assert.ok(settings.includes('httpStaticAuth'), 'settings must protect the static cloud UI when auth is configured');

const flowsText = readFileSync(resolve(root, `${base}/nodered/flows.json`), 'utf8');
const flows = JSON.parse(flowsText);
assert.ok(Array.isArray(flows), 'flows must be a JSON array');

for (const topic of [
  'wireless-debug/+/status',
  'wireless-debug/+/availability',
  'wireless-debug/+/ack',
]) {
  assert.ok(flows.some((node) => node.topic === topic), `flow missing MQTT topic ${topic}`);
}

for (const url of [
  '/cloud',
  '/api/devices',
  '/api/devices/:deviceId',
  '/api/devices/:deviceId/query-status',
  '/api/devices/:deviceId/note',
]) {
  assert.ok(flows.some((node) => node.url === url), `flow missing HTTP endpoint ${url}`);
}

for (const token of [
  'upsertDeviceStatus',
  'recordAvailability',
  'recordAck',
  'listDevices',
  'getDeviceDetail',
  'sendQueryStatus',
  'saveDeviceNote',
]) {
  assert.ok(flowsText.includes(token), `flow missing function ${token}`);
}

const ackFunction = flows.find((node) => node.name === 'recordAck');
assert.ok(ackFunction?.func?.includes("availability = 'online'"), 'ack events must mark the device online');

const listFunction = flows.find((node) => node.name === 'listDevices');
assert.ok(
  listFunction?.func?.includes("when last_seen_at >= now() - interval '60 seconds' then 0"),
  'device list must sort online devices first'
);
assert.ok(
  listFunction?.func?.includes("when last_seen_at >= now() - interval '5 minutes' then 1"),
  'device list must sort stale devices after online devices'
);
assert.ok(listFunction?.func?.includes('else 2'), 'device list must sort offline devices after stale devices');
assert.ok(
  listFunction?.func?.includes('when last_seen_at is null then 3'),
  'device list must sort unknown devices last'
);

assert.ok(/type:\s*['"]query_status['"]/.test(flowsText), 'cloud flow must publish query_status commands');
for (const dangerous of [
  'type:\\s*[\'"]set_wifi_mode[\'"]',
  'type:\\s*[\'"]set_uart_baud[\'"]',
  'type:\\s*[\'"]set_comm_mode[\'"]',
  'type:\\s*[\'"]display_text[\'"]',
  'type:\\s*[\'"]ble_start[\'"]',
  'quick_connect',
  'web_provision',
  'clear_wifi',
  'mqtt_url',
  '\\bota\\b',
  '\\breboot\\b',
]) {
  assert.ok(!new RegExp(dangerous).test(flowsText), `cloud flow must not expose dangerous command ${dangerous}`);
}

const envExample = readFileSync(resolve(root, `${base}/.env.example`), 'utf8');
for (const token of [
  'POSTGRES_IMAGE',
  'MOSQUITTO_IMAGE',
  'NODERED_BASE_IMAGE',
  'NPM_REGISTRY',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'MQTT_PORT',
  'NODERED_PORT',
  'NODE_RED_CREDENTIAL_SECRET',
]) {
  assert.ok(envExample.includes(token), `.env.example missing ${token}`);
}

const readme = readFileSync(resolve(root, `${base}/README.md`), 'utf8');
for (const token of [
  'docker compose up -d',
  'Ubuntu',
  'PostgreSQL',
  'Node-RED',
  'POSTGRES_IMAGE',
  'NODERED_BASE_IMAGE',
  'NPM_REGISTRY',
  'query_status',
  '不提供 AP/STA/APSTA 远程切换',
  'wireless-debug/{deviceId}/status',
  'wireless-debug/{deviceId}/cmd',
]) {
  assert.ok(readme.includes(token), `README missing ${token}`);
}

const cloudHtml = readFileSync(resolve(root, `${base}/nodered/public/cloud.html`), 'utf8');
for (const token of [
  '无线调试云端观测台',
  '/api/devices',
  'query-status',
  '设备总览',
  '设备详情',
  '最近事件',
  '危险控制不在云端提供',
]) {
  assert.ok(cloudHtml.includes(token), `cloud UI missing ${token}`);
}
for (const dangerous of [
  'set_wifi_mode',
  'quick_connect',
  'web_provision',
  'clear_wifi',
  'mqtt_url',
  'querySelector("#ota',
  'id="ota',
]) {
  assert.ok(!cloudHtml.includes(dangerous), `cloud UI must not expose ${dangerous}`);
}

console.log('remote MQTT Node-RED cloud regression passed');
