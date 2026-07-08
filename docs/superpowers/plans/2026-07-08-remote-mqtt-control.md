# Remote MQTT Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first MQTT relay MVP so the ESP32 can publish remote status and accept remote configuration/control commands through a PC-hosted service that can later move to Ubuntu.

**Architecture:** Add a Docker Compose stack under `tools/remote_mqtt/` with Mosquitto, a Node.js HTTP/SSE service, and a mock device. Add a focused `cloud_mqtt` firmware module that starts only when STA is connected, publishes status to MQTT, subscribes to command topics, and calls existing firmware control callbacks.

**Tech Stack:** ESP-IDF 6.0, ESP32-S3, ESP MQTT client, cJSON, Mosquitto, Node.js 20+ or Docker Node 22 Alpine, Express, mqtt.js, browser SSE.

## Global Constraints

- Single device MVP with default `device_id` `esp32-001`.
- Local MQTT broker port is `1883`.
- Local remote web/API port is `3000`.
- MQTT topic namespace is `wireless-debug/<device_id>/...`.
- MQTT status interval is 5 seconds while connected.
- Command ACK timeout in Node.js is 8 seconds.
- First commands are `query_status`, `set_wifi_mode`, `set_uart_baud`, `set_comm_mode`, `ble_start`, and `display_text`.
- No login, no TLS, no per-device secret in the first version.
- Do not implement remote UART passthrough in this MVP.
- Do not replace the existing local AP web UI.
- Pure AP mode must not claim cloud connectivity.
- Keep OLED second-line cleanup behavior untouched.
- Default boot WiFi mode remains APSTA.

---

## File Structure

Create service files:

- `tools/remote_mqtt/docker-compose.yml`: local service stack for Mosquitto and Node.js.
- `tools/remote_mqtt/mosquitto/mosquitto.conf`: broker listener config reachable by ESP32 over LAN.
- `tools/remote_mqtt/server/package.json`: Node service scripts and dependencies.
- `tools/remote_mqtt/server/src/index.js`: MQTT bridge, device cache, HTTP APIs, SSE events, command ACK tracking.
- `tools/remote_mqtt/server/src/mock_device.js`: local fake ESP32 for server/browser validation before flashing firmware.
- `tools/remote_mqtt/server/public/index.html`: practical browser dashboard.
- `tools/remote_mqtt/README.md`: local run, firewall, and cloud deployment notes.

Create regression files:

- `scripts/remote_mqtt_server_regression.mjs`: verifies local service contract and required files.
- `scripts/cloud_mqtt_contract_regression.mjs`: verifies firmware MQTT module contract, topic names, command names, CMake dependencies, and AP-mode guard.

Create firmware files:

- `main/cloud_mqtt.h`: focused public interface and callback contracts.
- `main/cloud_mqtt.c`: MQTT client, status publisher, command parser, ACK publisher, STA-gated start/stop.
- `main/Kconfig.projbuild`: compile-time defaults for enabling MQTT, device ID, and MQTT URI.

Modify firmware files:

- `main/CMakeLists.txt`: add `cloud_mqtt.c` and require `mqtt` and `json`.
- `main/main.c`: wire cloud callbacks, initialize cloud MQTT, notify it on WiFi state changes, and keep existing local APIs unchanged.

---

### Task 1: Local MQTT Service, Browser Dashboard, And Mock Device

**Files:**
- Create: `scripts/remote_mqtt_server_regression.mjs`
- Create: `tools/remote_mqtt/docker-compose.yml`
- Create: `tools/remote_mqtt/mosquitto/mosquitto.conf`
- Create: `tools/remote_mqtt/server/package.json`
- Create: `tools/remote_mqtt/server/src/index.js`
- Create: `tools/remote_mqtt/server/src/mock_device.js`
- Create: `tools/remote_mqtt/server/public/index.html`
- Create: `tools/remote_mqtt/README.md`

**Interfaces:**
- Consumes: MQTT topics `wireless-debug/<device_id>/status`, `availability`, `cmd`, and `ack`.
- Produces: HTTP `GET /api/devices`, `GET /api/devices/:id/status`, `POST /api/devices/:id/command`, SSE `GET /events`, and a browser page at `/`.

- [ ] **Step 1: Write the failing source regression**

Create `scripts/remote_mqtt_server_regression.mjs`:

```js
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
]) {
  assert.ok(server.includes(token), `server missing ${token}`);
}

const mock = readFileSync(resolve(root, 'tools/remote_mqtt/server/src/mock_device.js'), 'utf8');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/status'), 'mock must publish device status');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/cmd'), 'mock must subscribe to the command topic');
assert.ok(mock.includes('${NAMESPACE}/${DEVICE_ID}/ack'), 'mock must publish ACKs');

const html = readFileSync(resolve(root, 'tools/remote_mqtt/server/public/index.html'), 'utf8');
assert.ok(html.includes('new EventSource'), 'dashboard must use SSE');
assert.ok(html.includes('/api/devices/${DEVICE_ID}/command'), 'dashboard must send commands to selected device');
assert.ok(html.includes('set_wifi_mode'), 'dashboard must expose WiFi mode command');
assert.ok(html.includes('set_uart_baud'), 'dashboard must expose UART baud command');

console.log('remote MQTT service regression passed');
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/remote_mqtt_server_regression.mjs
```

Expected: FAIL with a missing `tools/remote_mqtt/...` file assertion.

- [ ] **Step 3: Create Docker Compose and Mosquitto config**

Create `tools/remote_mqtt/docker-compose.yml`:

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro

  remote-server:
    image: node:22-alpine
    working_dir: /app
    command: sh -c "npm install && npm start"
    environment:
      - MQTT_URL=mqtt://mosquitto:1883
      - PORT=3000
      - DEVICE_NAMESPACE=wireless-debug
    ports:
      - "3000:3000"
    volumes:
      - ./server:/app
    depends_on:
      - mosquitto
```

Create `tools/remote_mqtt/mosquitto/mosquitto.conf`:

```conf
listener 1883 0.0.0.0
allow_anonymous true
persistence false
log_type error
log_type warning
log_type notice
log_type information
```

- [ ] **Step 4: Create the Node service package**

Create `tools/remote_mqtt/server/package.json`:

```json
{
  "name": "wireless-debug-remote-mqtt",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "mock": "node src/mock_device.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "mqtt": "^5.10.1"
  }
}
```

- [ ] **Step 5: Implement the Node MQTT bridge**

Create `tools/remote_mqtt/server/src/index.js`:

```js
import express from 'express';
import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const NAMESPACE = process.env.DEVICE_NAMESPACE || 'wireless-debug';
const COMMAND_TIMEOUT_MS = 8000;
const STALE_AFTER_MS = 15000;

const COMMAND_TYPES = new Set([
  'query_status',
  'set_wifi_mode',
  'set_uart_baud',
  'set_comm_mode',
  'ble_start',
  'display_text',
]);

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(join(__dirname, '..', 'public')));

const devices = new Map();
const pending = new Map();
const sseClients = new Set();
let brokerConnected = false;
let commandSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function getDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      device_id: id,
      online: false,
      availability: 'unknown',
      status: null,
      status_at: null,
      ack_log: [],
    });
  }
  return devices.get(id);
}

function isDeviceOnline(device) {
  if (!device || device.availability !== 'online' || !device.status_at) {
    return false;
  }
  return Date.now() - Date.parse(device.status_at) <= STALE_AFTER_MS;
}

function publicDevice(device) {
  return {
    ...device,
    online: isDeviceOnline(device),
    broker_connected: brokerConnected,
    pending_commands: [...pending.values()].filter((cmd) => cmd.device_id === device.device_id),
  };
}

function sendEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function broadcastDevices() {
  sendEvent('devices', [...devices.values()].map(publicDevice));
}

function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== NAMESPACE) {
    return null;
  }
  return { deviceId: parts[1], kind: parts[2] };
}

const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: `wireless-debug-remote-${randomUUID()}`,
  reconnectPeriod: 2000,
});

mqttClient.on('connect', () => {
  brokerConnected = true;
  mqttClient.subscribe(`${NAMESPACE}/+/status`);
  mqttClient.subscribe(`${NAMESPACE}/+/availability`);
  mqttClient.subscribe(`${NAMESPACE}/+/ack`);
  sendEvent('broker', { connected: true, at: nowIso() });
  broadcastDevices();
});

mqttClient.on('close', () => {
  brokerConnected = false;
  sendEvent('broker', { connected: false, at: nowIso() });
  broadcastDevices();
});

mqttClient.on('message', (topic, payload) => {
  const parsed = parseTopic(topic);
  if (!parsed) {
    return;
  }

  const device = getDevice(parsed.deviceId);
  if (parsed.kind === 'status') {
    try {
      device.status = JSON.parse(payload.toString());
      device.status_at = nowIso();
      device.availability = 'online';
    } catch (err) {
      device.status = { parse_error: err.message, raw: payload.toString() };
      device.status_at = nowIso();
    }
    sendEvent('status', publicDevice(device));
    broadcastDevices();
    return;
  }

  if (parsed.kind === 'availability') {
    device.availability = payload.toString() === 'online' ? 'online' : 'offline';
    sendEvent('availability', publicDevice(device));
    broadcastDevices();
    return;
  }

  if (parsed.kind === 'ack') {
    let ack;
    try {
      ack = JSON.parse(payload.toString());
    } catch (err) {
      ack = { ok: false, message: `ack parse error: ${err.message}` };
    }
    ack.received_at = nowIso();
    device.ack_log = [ack, ...device.ack_log].slice(0, 50);
    if (ack.command_id && pending.has(ack.command_id)) {
      const item = pending.get(ack.command_id);
      clearTimeout(item.timeout);
      pending.delete(ack.command_id);
    }
    sendEvent('ack', { device: publicDevice(device), ack });
    broadcastDevices();
  }
});

app.get('/api/devices', (req, res) => {
  res.json({
    ok: true,
    broker_connected: brokerConnected,
    devices: [...devices.values()].map(publicDevice),
  });
});

app.get('/api/devices/:id/status', (req, res) => {
  res.json({ ok: true, device: publicDevice(getDevice(req.params.id)) });
});

app.post('/api/devices/:id/command', (req, res) => {
  const device = getDevice(req.params.id);
  if (!brokerConnected) {
    res.status(503).json({ ok: false, message: 'mqtt broker disconnected' });
    return;
  }
  if (!isDeviceOnline(device)) {
    res.status(409).json({ ok: false, message: 'device offline or stale' });
    return;
  }

  const type = String(req.body?.type || '');
  if (!COMMAND_TYPES.has(type)) {
    res.status(400).json({ ok: false, message: 'unsupported command type' });
    return;
  }

  const commandId = `cmd-${String(++commandSeq).padStart(6, '0')}`;
  const command = {
    command_id: commandId,
    type,
    args: req.body?.args && typeof req.body.args === 'object' ? req.body.args : {},
  };

  const timeout = setTimeout(() => {
    pending.delete(commandId);
    const timeoutAck = {
      device_id: device.device_id,
      command_id: commandId,
      type,
      ok: false,
      message: 'ack timeout',
      received_at: nowIso(),
    };
    device.ack_log = [timeoutAck, ...device.ack_log].slice(0, 50);
    sendEvent('ack', { device: publicDevice(device), ack: timeoutAck });
    broadcastDevices();
  }, COMMAND_TIMEOUT_MS);

  pending.set(commandId, {
    command_id: commandId,
    device_id: device.device_id,
    type,
    sent_at: nowIso(),
    timeout,
  });

  mqttClient.publish(`${NAMESPACE}/${device.device_id}/cmd`, JSON.stringify(command), { qos: 1 }, (err) => {
    if (err) {
      clearTimeout(timeout);
      pending.delete(commandId);
      res.status(502).json({ ok: false, message: err.message });
      return;
    }
    sendEvent('command', { device_id: device.device_id, command });
    broadcastDevices();
    res.json({ ok: true, command });
  });
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso(), broker_connected: brokerConnected })}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`remote MQTT web listening on http://localhost:${PORT}`);
  console.log(`mqtt broker ${MQTT_URL}`);
});
```

- [ ] **Step 6: Implement the mock device**

Create `tools/remote_mqtt/server/src/mock_device.js`:

```js
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const DEVICE_ID = process.env.DEVICE_ID || 'esp32-001';
const NAMESPACE = process.env.DEVICE_NAMESPACE || 'wireless-debug';

const client = mqtt.connect(MQTT_URL, {
  clientId: `${DEVICE_ID}-mock`,
  will: {
    topic: `${NAMESPACE}/${DEVICE_ID}/availability`,
    payload: 'offline',
    qos: 1,
    retain: true,
  },
});

let status = {
  device_id: DEVICE_ID,
  fw: 'wireless-debug-mock',
  uptime_ms: 0,
  net_mode: 'apsta',
  sta_configured: true,
  sta_connecting: false,
  sta_connected: true,
  ap_ip: '192.168.4.1',
  sta_ip: '192.168.1.23',
  uart_baud: 2000000,
  comm_mode: 'auto',
  ble_ready: false,
  ble_subscribed: false,
  wifi_ws_client: false,
};

function publishStatus() {
  status = { ...status, uptime_ms: status.uptime_ms + 5000 };
  client.publish(`${NAMESPACE}/${DEVICE_ID}/status`, JSON.stringify(status), { qos: 1, retain: true });
}

function ack(command, ok, message) {
  client.publish(`${NAMESPACE}/${DEVICE_ID}/ack`, JSON.stringify({
    device_id: DEVICE_ID,
    command_id: command.command_id,
    type: command.type,
    ok,
    message,
  }), { qos: 1 });
}

client.on('connect', () => {
  client.publish(`${NAMESPACE}/${DEVICE_ID}/availability`, 'online', { qos: 1, retain: true });
  client.subscribe(`${NAMESPACE}/${DEVICE_ID}/cmd`);
  publishStatus();
  setInterval(publishStatus, 5000);
  console.log(`mock device online at ${MQTT_URL}`);
});

client.on('message', (topic, payload) => {
  if (topic !== `${NAMESPACE}/${DEVICE_ID}/cmd`) {
    return;
  }
  const command = JSON.parse(payload.toString());
  const args = command.args || {};

  if (command.type === 'query_status') {
    publishStatus();
    ack(command, true, 'status published');
  } else if (command.type === 'set_wifi_mode') {
    status.net_mode = String(args.mode || status.net_mode);
    ack(command, true, 'queued');
  } else if (command.type === 'set_uart_baud') {
    status.uart_baud = Number(args.baud || status.uart_baud);
    ack(command, true, 'applied');
  } else if (command.type === 'set_comm_mode') {
    status.comm_mode = String(args.mode || status.comm_mode);
    ack(command, true, 'applied');
  } else if (command.type === 'ble_start') {
    status.ble_ready = true;
    ack(command, true, 'ble started');
  } else if (command.type === 'display_text') {
    ack(command, true, `displayed ${String(args.text || '').slice(0, 32)}`);
  } else {
    ack(command, false, 'unsupported command type');
  }
  publishStatus();
});
```

- [ ] **Step 7: Create the browser dashboard**

Create `tools/remote_mqtt/server/public/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wireless Debug Remote</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; }
    body { margin: 0; background: #f4f6f8; color: #17202a; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 14px; }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid #eef1f4; }
    .row:last-child { border-bottom: 0; }
    label { display: block; margin: 8px 0 4px; font-size: 13px; color: #4e5965; }
    select, input, button { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #c8d0d8; border-radius: 6px; background: #fff; }
    button { cursor: pointer; background: #145da0; color: #fff; border-color: #145da0; margin-top: 8px; }
    button.secondary { background: #fff; color: #145da0; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: #e8eef5; font-size: 13px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #a0a8b0; }
    .dot.on { background: #1f9d55; }
    pre { min-height: 180px; max-height: 260px; overflow: auto; background: #111827; color: #d1fae5; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>Wireless Debug Remote</h1>
    <p class="pill"><span id="onlineDot" class="dot"></span><span id="onlineText">offline</span></p>
    <section class="grid">
      <div class="card">
        <h2>状态</h2>
        <div id="statusRows"></div>
      </div>
      <div class="card">
        <h2>控制</h2>
        <label for="wifiMode">WiFi Mode</label>
        <select id="wifiMode"><option value="ap">ap</option><option value="sta">sta</option><option value="apsta" selected>apsta</option></select>
        <button data-command="set_wifi_mode">Set WiFi Mode</button>
        <label for="uartBaud">UART Baud</label>
        <select id="uartBaud"><option>115200</option><option>921600</option><option selected>2000000</option><option>3000000</option></select>
        <button data-command="set_uart_baud">Set UART Baud</button>
        <label for="commMode">Comm Mode</label>
        <select id="commMode"><option value="auto">auto</option><option value="wifi">wifi</option><option value="ble">ble</option></select>
        <button data-command="set_comm_mode">Set Comm Mode</button>
        <button data-command="ble_start" class="secondary">Start BLE</button>
        <label for="displayText">OLED Text</label>
        <input id="displayText" value="Remote MQTT OK">
        <button data-command="display_text">Display Text</button>
        <button data-command="query_status" class="secondary">Query Status</button>
      </div>
    </section>
    <h2>命令日志</h2>
    <pre id="log"></pre>
  </main>
  <script>
    const DEVICE_ID = 'esp32-001';
    const statusRows = document.querySelector('#statusRows');
    const log = document.querySelector('#log');
    let currentDevice = null;

    function writeLog(line) {
      log.textContent = `${new Date().toLocaleTimeString()} ${line}\n${log.textContent}`.slice(0, 6000);
    }

    function row(label, value) {
      return `<div class="row"><span>${label}</span><strong>${value ?? '-'}</strong></div>`;
    }

    function render(device) {
      currentDevice = device;
      const status = device?.status || {};
      document.querySelector('#onlineDot').classList.toggle('on', !!device?.online);
      document.querySelector('#onlineText').textContent = device?.online ? 'online' : 'offline';
      statusRows.innerHTML = [
        row('Device', device?.device_id || DEVICE_ID),
        row('Broker', device?.broker_connected ? 'connected' : 'disconnected'),
        row('Last Status', device?.status_at || '-'),
        row('WiFi Mode', status.net_mode),
        row('STA', status.sta_connected ? 'connected' : status.sta_connecting ? 'connecting' : 'offline'),
        row('AP IP', status.ap_ip),
        row('STA IP', status.sta_ip),
        row('UART', status.uart_baud),
        row('Comm', status.comm_mode),
        row('BLE', status.ble_ready ? 'ready' : 'off'),
      ].join('');
      if (Array.isArray(device?.ack_log) && device.ack_log[0]) {
        writeLog(`ACK ${device.ack_log[0].type} ${device.ack_log[0].ok ? 'ok' : 'fail'} ${device.ack_log[0].message || ''}`);
      }
    }

    async function refresh() {
      const res = await fetch(`/api/devices/${DEVICE_ID}/status`);
      const data = await res.json();
      render(data.device);
    }

    async function sendCommand(type) {
      const args = {};
      if (type === 'set_wifi_mode') args.mode = document.querySelector('#wifiMode').value;
      if (type === 'set_uart_baud') args.baud = Number(document.querySelector('#uartBaud').value);
      if (type === 'set_comm_mode') args.mode = document.querySelector('#commMode').value;
      if (type === 'display_text') args.text = document.querySelector('#displayText').value;
      const res = await fetch(`/api/devices/${DEVICE_ID}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, args }),
      });
      const data = await res.json();
      writeLog(`${type} ${data.ok ? data.command.command_id : data.message}`);
      await refresh();
    }

    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => sendCommand(button.dataset.command));
    });

    const events = new EventSource('/events');
    events.addEventListener('status', (ev) => render(JSON.parse(ev.data)));
    events.addEventListener('availability', (ev) => render(JSON.parse(ev.data)));
    events.addEventListener('ack', (ev) => render(JSON.parse(ev.data).device));
    events.addEventListener('devices', (ev) => {
      const device = JSON.parse(ev.data).find((item) => item.device_id === DEVICE_ID);
      if (device) render(device);
    });
    refresh().catch((err) => writeLog(err.message));
    setInterval(refresh, 5000);
  </script>
</body>
</html>
```

- [ ] **Step 8: Write local run documentation**

Create `tools/remote_mqtt/README.md`:

````markdown
# Wireless Debug Remote MQTT MVP

This directory runs the local-first remote access MVP.

## Local Run

Start Mosquitto and the Node.js service:

```bash
cd tools/remote_mqtt
docker compose up
```

Open:

```text
http://localhost:3000
```

In a second terminal, run the mock ESP32:

```bash
cd tools/remote_mqtt/server
npm install
MQTT_URL=mqtt://localhost:1883 npm run mock
```

## ESP32 Broker Address

The real ESP32 must use the PC's LAN IP, not `localhost`.

Example:

```text
mqtt://192.168.1.100:1883
```

Mosquitto listens on `0.0.0.0:1883`. If ESP32 cannot connect, allow inbound TCP port `1883` in Windows firewall.

## Ubuntu Deployment

Copy this directory to the Ubuntu server, install Docker, and run:

```bash
docker compose up -d
```

Open inbound ports `1883` and `3000` for the MVP. Before broader exposure, add broker username/password, web login, and TLS.
````

- [ ] **Step 9: Run the regression and service smoke test**

Run:

```bash
node scripts/remote_mqtt_server_regression.mjs
```

Expected: PASS with `remote MQTT service regression passed`.

Optional local smoke test when Docker is available:

```bash
cd tools/remote_mqtt
docker compose up --build
```

Expected: Mosquitto starts, Node prints `remote MQTT web listening on http://localhost:3000`, and `http://localhost:3000` loads.

- [ ] **Step 10: Commit**

```bash
git add tools/remote_mqtt scripts/remote_mqtt_server_regression.mjs
git commit -m "Add local MQTT remote control service"
```

---

### Task 2: Firmware Cloud MQTT Contract And Build Scaffold

**Files:**
- Create: `scripts/cloud_mqtt_contract_regression.mjs`
- Create: `main/Kconfig.projbuild`
- Create: `main/cloud_mqtt.h`
- Create: `main/cloud_mqtt.c`
- Modify: `main/CMakeLists.txt`

**Interfaces:**
- Consumes: existing `wifi_manager_status_t`, `system_net_mode_t`, and `app_comm_mode_t`.
- Produces: `cloud_mqtt_init`, `cloud_mqtt_notify_wifi_state`, and `cloud_mqtt_publish_status_now`.

- [ ] **Step 1: Write the failing firmware contract regression**

Create `scripts/cloud_mqtt_contract_regression.mjs`:

```js
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

const kconfig = readFileSync(resolve(root, 'main/Kconfig.projbuild'), 'utf8');
assert.ok(kconfig.includes('config CLOUD_MQTT_ENABLE'), 'missing CLOUD_MQTT_ENABLE');
assert.ok(kconfig.includes('config CLOUD_MQTT_DEVICE_ID'), 'missing CLOUD_MQTT_DEVICE_ID');
assert.ok(kconfig.includes('config CLOUD_MQTT_URI'), 'missing CLOUD_MQTT_URI');
assert.ok(kconfig.includes('default "esp32-001"'), 'default device ID mismatch');

console.log('cloud MQTT contract regression passed');
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
```

Expected: FAIL with missing `main/cloud_mqtt.h`.

- [ ] **Step 3: Add compile-time MQTT config**

Create `main/Kconfig.projbuild`:

```text
menu "Wireless Debug Cloud MQTT"

config CLOUD_MQTT_ENABLE
    bool "Enable cloud MQTT remote status and control"
    default y

config CLOUD_MQTT_DEVICE_ID
    string "Cloud MQTT device ID"
    default "esp32-001"

config CLOUD_MQTT_URI
    string "Cloud MQTT broker URI"
    default "mqtt://192.168.1.100:1883"

endmenu
```

- [ ] **Step 4: Add the public firmware interface**

Create `main/cloud_mqtt.h`:

```c
#ifndef CLOUD_MQTT_H
#define CLOUD_MQTT_H

#include <stdbool.h>
#include <stdint.h>
#include "app_core.h"
#include "esp_err.h"
#include "system_menu.h"
#include "wifi_manager.h"

typedef struct {
    const char *device_id;
    const char *mqtt_uri;
    bool enabled;
} cloud_mqtt_config_t;

typedef struct {
    esp_err_t (*set_wifi_mode)(system_net_mode_t mode, void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    esp_err_t (*set_comm_mode)(app_comm_mode_t mode, void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    esp_err_t (*display_text)(const char *text, void *ctx);
    void (*get_wifi_status)(wifi_manager_status_t *out, void *ctx);
    uint32_t (*get_uart_baud)(void *ctx);
    app_comm_mode_t (*get_comm_mode)(void *ctx);
    bool (*ble_is_started)(void *ctx);
    bool (*ble_has_subscribers)(void *ctx);
    bool (*wifi_ws_client_connected)(void *ctx);
    void *ctx;
} cloud_mqtt_runtime_t;

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime);
void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status);
void cloud_mqtt_publish_status_now(void);

#endif /* CLOUD_MQTT_H */
```

- [ ] **Step 5: Add a compiling MQTT scaffold**

Create `main/cloud_mqtt.c` with these declarations first; Task 3 fills the command behavior:

```c
#include "cloud_mqtt.h"

#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mqtt_client.h"

#define CLOUD_MQTT_STATUS_INTERVAL_US (5LL * 1000LL * 1000LL)

static const char *TAG = "cloud_mqtt";
static cloud_mqtt_config_t s_config;
static cloud_mqtt_runtime_t s_runtime;
static esp_mqtt_client_handle_t s_client;
static esp_timer_handle_t s_status_timer;
static bool s_initialized;
static bool s_started;
static bool s_connected;

static int make_topic(char *out, size_t out_size, const char *suffix)
{
    return snprintf(out, out_size, "wireless-debug/%s/%s", s_config.device_id, suffix);
}

static const char *net_mode_json_name(system_net_mode_t mode)
{
    switch (mode) {
    case SYSTEM_NET_STA:
        return "sta";
    case SYSTEM_NET_APSTA:
        return "apsta";
    case SYSTEM_NET_AP:
    default:
        return "ap";
    }
}

static const char *comm_mode_json_name(app_comm_mode_t mode)
{
    switch (mode) {
    case APP_COMM_BLE:
        return "ble";
    case APP_COMM_WIFI:
        return "wifi";
    case APP_COMM_AUTO:
    default:
        return "auto";
    }
}

static void status_timer_cb(void *arg)
{
    (void)arg;
    cloud_mqtt_publish_status_now();
}

static void publish_ack(const char *command_id, const char *type, bool ok, const char *message)
{
    if (!s_connected || s_client == NULL) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "command_id", command_id != NULL ? command_id : "");
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "type", type != NULL ? type : "");
    cJSON_AddStringToObject(root, "message", message != NULL ? message : "");

    char topic[96];
    make_topic(topic, sizeof(topic), "ack");
    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 0);
        cJSON_free(payload);
    }
    cJSON_Delete(root);
}

static void handle_command(const char *payload, int payload_len)
{
    cJSON *root = cJSON_ParseWithLength(payload, payload_len);
    if (root == NULL) {
        publish_ack("", "", false, "invalid json");
        return;
    }

    const cJSON *command_id = cJSON_GetObjectItem(root, "command_id");
    const cJSON *type = cJSON_GetObjectItem(root, "type");
    const char *command_id_text = cJSON_IsString(command_id) ? command_id->valuestring : "";
    const char *type_text = cJSON_IsString(type) ? type->valuestring : "";

    if (strcmp(type_text, "query_status") == 0) {
        cloud_mqtt_publish_status_now();
        publish_ack(command_id_text, type_text, true, "status published");
    } else if (strcmp(type_text, "set_wifi_mode") == 0 ||
               strcmp(type_text, "set_uart_baud") == 0 ||
               strcmp(type_text, "set_comm_mode") == 0 ||
               strcmp(type_text, "ble_start") == 0 ||
               strcmp(type_text, "display_text") == 0) {
        publish_ack(command_id_text, type_text, false, "command scaffold only");
    } else {
        publish_ack(command_id_text, type_text, false, "unsupported command type");
    }

    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;

    if (event_id == MQTT_EVENT_CONNECTED) {
        s_connected = true;
        char topic[96];
        make_topic(topic, sizeof(topic), "availability");
        esp_mqtt_client_publish(s_client, topic, "online", 0, 1, 1);
        make_topic(topic, sizeof(topic), "cmd");
        esp_mqtt_client_subscribe(s_client, topic, 1);
        cloud_mqtt_publish_status_now();
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        s_connected = false;
    } else if (event_id == MQTT_EVENT_DATA && event != NULL) {
        char cmd_topic[96];
        make_topic(cmd_topic, sizeof(cmd_topic), "cmd");
        if ((int)strlen(cmd_topic) == event->topic_len &&
            strncmp(event->topic, cmd_topic, event->topic_len) == 0) {
            handle_command(event->data, event->data_len);
        }
    }
}

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime)
{
    if (config == NULL || runtime == NULL || config->device_id == NULL ||
        config->mqtt_uri == NULL || config->device_id[0] == '\0' ||
        config->mqtt_uri[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    s_runtime = *runtime;
    if (!s_config.enabled) {
        s_initialized = true;
        return ESP_OK;
    }

    const esp_timer_create_args_t timer_args = {
        .callback = status_timer_cb,
        .name = "cloud_mqtt_status",
    };
    esp_err_t err = esp_timer_create(&timer_args, &s_status_timer);
    if (err != ESP_OK) {
        return err;
    }

    char will_topic[96];
    make_topic(will_topic, sizeof(will_topic), "availability");
    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = s_config.mqtt_uri,
        .session.last_will.topic = will_topic,
        .session.last_will.msg = "offline",
        .session.last_will.qos = 1,
        .session.last_will.retain = true,
    };

    s_client = esp_mqtt_client_init(&mqtt_cfg);
    if (s_client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    s_initialized = true;
    ESP_LOGI(TAG, "cloud MQTT configured: id=%s uri=%s", s_config.device_id, s_config.mqtt_uri);
    return ESP_OK;
}

void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status)
{
    if (!s_initialized || !s_config.enabled || s_client == NULL || status == NULL) {
        return;
    }

    bool should_run = status->mode != SYSTEM_NET_AP && status->sta_connected;
    if (should_run && !s_started) {
        s_started = true;
        esp_mqtt_client_start(s_client);
        if (s_status_timer != NULL) {
            esp_timer_start_periodic(s_status_timer, CLOUD_MQTT_STATUS_INTERVAL_US);
        }
    } else if (!should_run && s_started) {
        if (s_connected) {
            char topic[96];
            make_topic(topic, sizeof(topic), "availability");
            esp_mqtt_client_publish(s_client, topic, "offline", 0, 1, 1);
        }
        if (s_status_timer != NULL) {
            esp_timer_stop(s_status_timer);
        }
        esp_mqtt_client_stop(s_client);
        s_started = false;
        s_connected = false;
    }
}

void cloud_mqtt_publish_status_now(void)
{
    if (!s_connected || s_client == NULL || s_runtime.get_wifi_status == NULL) {
        return;
    }

    wifi_manager_status_t wifi;
    memset(&wifi, 0, sizeof(wifi));
    s_runtime.get_wifi_status(&wifi, s_runtime.ctx);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "fw", "wireless-debug");
    cJSON_AddNumberToObject(root, "uptime_ms", (double)(esp_timer_get_time() / 1000));
    cJSON_AddStringToObject(root, "net_mode", net_mode_json_name(wifi.mode));
    cJSON_AddBoolToObject(root, "sta_configured", wifi.sta_configured);
    cJSON_AddBoolToObject(root, "sta_connecting", wifi.sta_connecting);
    cJSON_AddBoolToObject(root, "sta_connected", wifi.sta_connected);
    cJSON_AddStringToObject(root, "ap_ip", wifi.ap_ip);
    cJSON_AddStringToObject(root, "sta_ip", wifi.sta_ip);
    cJSON_AddNumberToObject(root, "uart_baud",
                            s_runtime.get_uart_baud != NULL ? s_runtime.get_uart_baud(s_runtime.ctx) : 0);
    cJSON_AddStringToObject(root, "comm_mode",
                            s_runtime.get_comm_mode != NULL ?
                            comm_mode_json_name(s_runtime.get_comm_mode(s_runtime.ctx)) : "auto");
    cJSON_AddBoolToObject(root, "ble_ready",
                          s_runtime.ble_is_started != NULL && s_runtime.ble_is_started(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "ble_subscribed",
                          s_runtime.ble_has_subscribers != NULL && s_runtime.ble_has_subscribers(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "wifi_ws_client",
                          s_runtime.wifi_ws_client_connected != NULL &&
                          s_runtime.wifi_ws_client_connected(s_runtime.ctx));

    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        char topic[96];
        make_topic(topic, sizeof(topic), "status");
        esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 1);
        cJSON_free(payload);
    }
    cJSON_Delete(root);
}
```

- [ ] **Step 6: Update CMake**

Modify `main/CMakeLists.txt` so the source list includes `"cloud_mqtt.c"` and the `REQUIRES` list includes `mqtt json`.

Expected relevant line shape:

```cmake
idf_component_register(SRCS "input_buttons.c" "system_menu.c" "motor_diag.c" "display_font_fusion_12_zh.c" "health_reporter.c" "comm_stats.c" "ble_transport.c" "wifi_manager.c" "ui_controller.c" "app_core.c" "wifi_transport.c" "web_api.c" "uart_transport.c" "router_service.c" "web_static.c" "http_utils.c" "cloud_mqtt.c" "main.c" "display_port.c" "display_lvgl.c" "display_ui.c"
                    INCLUDE_DIRS "."
                    REQUIRES nvs_flash esp_driver_uart esp_driver_gpio esp_driver_i2c bt nimble_peripheral_utils esp_wifi esp_http_server spiffs esp_timer esp_psram esp_app_format lvgl__lvgl mqtt json)
```

- [ ] **Step 7: Run the regression and commit**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
```

Expected: PASS with `cloud MQTT contract regression passed`.

Then run:

```bash
git diff --check
git add main/Kconfig.projbuild main/cloud_mqtt.h main/cloud_mqtt.c main/CMakeLists.txt scripts/cloud_mqtt_contract_regression.mjs
git commit -m "Add cloud MQTT firmware scaffold"
```

---

### Task 3: Firmware MQTT Command Handling

**Files:**
- Modify: `main/cloud_mqtt.c`
- Modify: `scripts/cloud_mqtt_contract_regression.mjs`

**Interfaces:**
- Consumes: `cloud_mqtt_runtime_t` callbacks from Task 2.
- Produces: Full command behavior for `query_status`, `set_wifi_mode`, `set_uart_baud`, `set_comm_mode`, `ble_start`, and `display_text`.

- [ ] **Step 1: Extend the regression for real command execution paths**

Append these assertions to `scripts/cloud_mqtt_contract_regression.mjs` before the final `console.log`:

```js
for (const token of [
  'parse_net_mode',
  'parse_comm_mode',
  'handle_set_wifi_mode',
  'handle_set_uart_baud',
  'handle_set_comm_mode',
  'handle_ble_start',
  'handle_display_text',
  's_runtime.set_wifi_mode',
  's_runtime.set_uart_baud',
  's_runtime.set_comm_mode',
  's_runtime.ble_start',
  's_runtime.display_text',
  'publish_ack(command_id_text, type_text, true',
]) {
  assert.ok(source.includes(token), `cloud_mqtt.c missing command execution token ${token}`);
}

assert.ok(!source.includes('command scaffold only'), 'command scaffold message must be removed');
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
```

Expected: FAIL because the scaffold still contains `command scaffold only`.

- [ ] **Step 3: Add parsing helpers**

In `main/cloud_mqtt.c`, add these helpers above `handle_command`:

```c
static bool parse_net_mode(const cJSON *args, system_net_mode_t *out)
{
    const cJSON *mode = cJSON_GetObjectItem(args, "mode");
    if (!cJSON_IsString(mode) || out == NULL) {
        return false;
    }
    if (strcmp(mode->valuestring, "ap") == 0) {
        *out = SYSTEM_NET_AP;
        return true;
    }
    if (strcmp(mode->valuestring, "sta") == 0) {
        *out = SYSTEM_NET_STA;
        return true;
    }
    if (strcmp(mode->valuestring, "apsta") == 0) {
        *out = SYSTEM_NET_APSTA;
        return true;
    }
    return false;
}

static bool parse_comm_mode(const cJSON *args, app_comm_mode_t *out)
{
    const cJSON *mode = cJSON_GetObjectItem(args, "mode");
    if (!cJSON_IsString(mode) || out == NULL) {
        return false;
    }
    if (strcmp(mode->valuestring, "auto") == 0) {
        *out = APP_COMM_AUTO;
        return true;
    }
    if (strcmp(mode->valuestring, "wifi") == 0) {
        *out = APP_COMM_WIFI;
        return true;
    }
    if (strcmp(mode->valuestring, "ble") == 0) {
        *out = APP_COMM_BLE;
        return true;
    }
    return false;
}
```

- [ ] **Step 4: Add command handler functions**

Add these functions above `handle_command`:

```c
static void handle_set_wifi_mode(const char *command_id, const char *type, const cJSON *args)
{
    system_net_mode_t mode;
    if (!parse_net_mode(args, &mode)) {
        publish_ack(command_id, type, false, "mode must be ap/sta/apsta");
        return;
    }
    if (s_runtime.set_wifi_mode == NULL) {
        publish_ack(command_id, type, false, "wifi mode callback missing");
        return;
    }
    esp_err_t err = s_runtime.set_wifi_mode(mode, s_runtime.ctx);
    publish_ack(command_id, type, err == ESP_OK, err == ESP_OK ? "queued" : esp_err_to_name(err));
}

static void handle_set_uart_baud(const char *command_id, const char *type, const cJSON *args)
{
    const cJSON *baud = cJSON_GetObjectItem(args, "baud");
    if (!cJSON_IsNumber(baud) || baud->valuedouble < 1200 || baud->valuedouble > 5000000) {
        publish_ack(command_id, type, false, "baud out of range");
        return;
    }
    if (s_runtime.set_uart_baud == NULL) {
        publish_ack(command_id, type, false, "uart callback missing");
        return;
    }
    esp_err_t err = s_runtime.set_uart_baud((uint32_t)baud->valuedouble, s_runtime.ctx);
    publish_ack(command_id, type, err == ESP_OK, err == ESP_OK ? "applied" : esp_err_to_name(err));
}

static void handle_set_comm_mode(const char *command_id, const char *type, const cJSON *args)
{
    app_comm_mode_t mode;
    if (!parse_comm_mode(args, &mode)) {
        publish_ack(command_id, type, false, "mode must be auto/wifi/ble");
        return;
    }
    if (s_runtime.set_comm_mode == NULL) {
        publish_ack(command_id, type, false, "comm callback missing");
        return;
    }
    esp_err_t err = s_runtime.set_comm_mode(mode, s_runtime.ctx);
    publish_ack(command_id, type, err == ESP_OK, err == ESP_OK ? "applied" : esp_err_to_name(err));
}

static void handle_ble_start(const char *command_id, const char *type)
{
    if (s_runtime.ble_start == NULL) {
        publish_ack(command_id, type, false, "ble callback missing");
        return;
    }
    esp_err_t err = s_runtime.ble_start(s_runtime.ctx);
    publish_ack(command_id, type, err == ESP_OK, err == ESP_OK ? "ble started" : esp_err_to_name(err));
}

static void handle_display_text(const char *command_id, const char *type, const cJSON *args)
{
    const cJSON *text = cJSON_GetObjectItem(args, "text");
    if (!cJSON_IsString(text) || text->valuestring[0] == '\0') {
        publish_ack(command_id, type, false, "text required");
        return;
    }
    if (s_runtime.display_text == NULL) {
        publish_ack(command_id, type, false, "display callback missing");
        return;
    }
    esp_err_t err = s_runtime.display_text(text->valuestring, s_runtime.ctx);
    publish_ack(command_id, type, err == ESP_OK, err == ESP_OK ? "displayed" : esp_err_to_name(err));
}
```

- [ ] **Step 5: Replace scaffold command dispatch**

Replace the `if` chain in `handle_command` with:

```c
    const cJSON *args = cJSON_GetObjectItem(root, "args");
    if (!cJSON_IsObject(args)) {
        args = root;
    }

    if (strcmp(type_text, "query_status") == 0) {
        cloud_mqtt_publish_status_now();
        publish_ack(command_id_text, type_text, true, "status published");
    } else if (strcmp(type_text, "set_wifi_mode") == 0) {
        handle_set_wifi_mode(command_id_text, type_text, args);
    } else if (strcmp(type_text, "set_uart_baud") == 0) {
        handle_set_uart_baud(command_id_text, type_text, args);
    } else if (strcmp(type_text, "set_comm_mode") == 0) {
        handle_set_comm_mode(command_id_text, type_text, args);
    } else if (strcmp(type_text, "ble_start") == 0) {
        handle_ble_start(command_id_text, type_text);
    } else if (strcmp(type_text, "display_text") == 0) {
        handle_display_text(command_id_text, type_text, args);
    } else {
        publish_ack(command_id_text, type_text, false, "unsupported command type");
    }
```

- [ ] **Step 6: Publish fresh status after successful commands**

At the end of each handler, after `publish_ack`, call `cloud_mqtt_publish_status_now()` when `err == ESP_OK`. Example for `handle_set_uart_baud`:

```c
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "applied" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
```

Apply that pattern to `handle_set_wifi_mode`, `handle_set_uart_baud`, `handle_set_comm_mode`, `handle_ble_start`, and `handle_display_text`.

- [ ] **Step 7: Run regression and commit**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
git diff --check
```

Expected: regression PASS and `git diff --check` prints no output.

Commit:

```bash
git add main/cloud_mqtt.c scripts/cloud_mqtt_contract_regression.mjs
git commit -m "Implement cloud MQTT commands"
```

---

### Task 4: Wire Cloud MQTT Into Firmware Runtime

**Files:**
- Modify: `main/main.c`
- Modify: `scripts/cloud_mqtt_contract_regression.mjs`

**Interfaces:**
- Consumes: `cloud_mqtt_config_t`, `cloud_mqtt_runtime_t`, and `cloud_mqtt_notify_wifi_state`.
- Produces: Cloud MQTT starts/stops with STA state and can call existing firmware actions.

- [ ] **Step 1: Extend regression for main wiring**

Append these assertions to `scripts/cloud_mqtt_contract_regression.mjs`:

```js
const main = readFileSync(resolve(root, 'main/main.c'), 'utf8');
for (const token of [
  '#include "cloud_mqtt.h"',
  'cloud_mqtt_runtime_t cloud_runtime',
  'cloud_mqtt_config_t cloud_config',
  'CONFIG_CLOUD_MQTT_DEVICE_ID',
  'CONFIG_CLOUD_MQTT_URI',
  'CONFIG_CLOUD_MQTT_ENABLE',
  'cloud_mqtt_init(&cloud_config, &cloud_runtime)',
  'cloud_mqtt_notify_wifi_state(status)',
  'cloud_set_wifi_mode',
  'cloud_set_uart_baud',
  'cloud_set_comm_mode',
  'cloud_ble_start',
  'cloud_display_text',
]) {
  assert.ok(main.includes(token), `main.c missing cloud MQTT wiring token ${token}`);
}
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
```

Expected: FAIL because `main.c` is not wired yet.

- [ ] **Step 3: Include the cloud module**

In `main/main.c`, add:

```c
#include "cloud_mqtt.h"
```

Place it with the other local module includes.

- [ ] **Step 4: Add cloud callback functions**

Add these functions in the `#if CONFIG_ENABLE_WIFI` section after the existing `web_api_send_ble_frame` function:

```c
static esp_err_t cloud_set_wifi_mode(system_net_mode_t mode, void *ctx)
{
    (void)ctx;
    wifi_manager_schedule_net_mode(mode);
    display_lvgl_set_status(mode == SYSTEM_NET_AP ? "cloud_ap" :
                            mode == SYSTEM_NET_STA ? "cloud_sta" : "cloud_apsta");
    return ESP_OK;
}

static esp_err_t cloud_set_uart_baud(uint32_t baud, void *ctx)
{
    (void)ctx;
    return set_uart_baud(baud);
}

static esp_err_t cloud_set_comm_mode(app_comm_mode_t mode, void *ctx)
{
    (void)ctx;
    app_core_set_comm_mode(mode);
    if (mode == APP_COMM_WIFI) {
        system_menu_set_comm_mode(SYSTEM_COMM_WIFI);
        display_lvgl_set_mode("WIFI");
        display_port_set_status("cloud_comm_wifi");
    } else if (mode == APP_COMM_BLE) {
        system_menu_set_comm_mode(SYSTEM_COMM_BLE);
        display_lvgl_set_mode("BLE");
        display_port_set_status("cloud_comm_ble");
    } else {
        system_menu_set_comm_mode(SYSTEM_COMM_AUTO);
        display_lvgl_set_mode("AUTO");
        display_port_set_status("cloud_comm_auto");
    }
    display_lvgl_set_status("cloud_comm");
    return ESP_OK;
}

static esp_err_t cloud_ble_start(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_start();
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

static esp_err_t cloud_display_text(const char *text, void *ctx)
{
    (void)ctx;
    if (text == NULL || text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    display_lvgl_set_text_scroll("REMOTE", text, "MQTT");
    display_port_set_status("cloud_text");
    return ESP_OK;
}

static void cloud_get_wifi_status(wifi_manager_status_t *out, void *ctx)
{
    (void)ctx;
    wifi_manager_get_status(out);
}

static uint32_t cloud_get_uart_baud(void *ctx)
{
    (void)ctx;
    return app_core_get_uart_baud();
}

static app_comm_mode_t cloud_get_comm_mode(void *ctx)
{
    (void)ctx;
    return app_core_get_comm_mode();
}

static bool cloud_ble_is_started(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_is_started();
#else
    return false;
#endif
}

static bool cloud_ble_has_subscribers(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_has_subscribers();
#else
    return false;
#endif
}

static bool cloud_wifi_ws_client_connected(void *ctx)
{
    (void)ctx;
    return wifi_transport_client_connected();
}
```

- [ ] **Step 5: Notify cloud MQTT when WiFi state changes**

In `wifi_manager_state_changed`, after the existing `display_lvgl_set_wifi_state(...)` call, add:

```c
    cloud_mqtt_notify_wifi_state(status);
```

- [ ] **Step 6: Initialize cloud MQTT after WiFi manager init**

In `app_main`, after `wifi_manager_init(&wifi_config)` succeeds and before `start_webserver();`, add:

```c
    cloud_mqtt_config_t cloud_config = {
        .device_id = CONFIG_CLOUD_MQTT_DEVICE_ID,
        .mqtt_uri = CONFIG_CLOUD_MQTT_URI,
        .enabled = CONFIG_CLOUD_MQTT_ENABLE,
    };
    cloud_mqtt_runtime_t cloud_runtime = {
        .set_wifi_mode = cloud_set_wifi_mode,
        .set_uart_baud = cloud_set_uart_baud,
        .set_comm_mode = cloud_set_comm_mode,
        .ble_start = cloud_ble_start,
        .display_text = cloud_display_text,
        .get_wifi_status = cloud_get_wifi_status,
        .get_uart_baud = cloud_get_uart_baud,
        .get_comm_mode = cloud_get_comm_mode,
        .ble_is_started = cloud_ble_is_started,
        .ble_has_subscribers = cloud_ble_has_subscribers,
        .wifi_ws_client_connected = cloud_wifi_ws_client_connected,
        .ctx = NULL,
    };
    esp_err_t cloud_ret = cloud_mqtt_init(&cloud_config, &cloud_runtime);
    if (cloud_ret != ESP_OK) {
        ESP_LOGW(TAG, "cloud MQTT init failed: %s", esp_err_to_name(cloud_ret));
    } else {
        wifi_manager_status_t initial_wifi;
        wifi_manager_get_status(&initial_wifi);
        cloud_mqtt_notify_wifi_state(&initial_wifi);
    }
```

- [ ] **Step 7: Run source regressions**

Run:

```bash
node scripts/cloud_mqtt_contract_regression.mjs
node scripts/wifi_true_modes_regression.mjs
node scripts/oled_wifi_status_regression.mjs
git diff --check
```

Expected: all scripts PASS and `git diff --check` prints no output.

- [ ] **Step 8: Run ESP-IDF build**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: output includes `Project build complete.` and generates `build/uart_ble_wifi.bin`.

- [ ] **Step 9: Commit**

```bash
git add main/main.c scripts/cloud_mqtt_contract_regression.mjs
git commit -m "Wire cloud MQTT into firmware"
```

---

### Task 5: End-To-End Local Verification Notes

**Files:**
- Modify: `tools/remote_mqtt/README.md`
- Modify: `docs/CLOUD_LOCAL_WORKFLOW.md`

**Interfaces:**
- Consumes: running Docker stack from Task 1 and firmware from Tasks 2-4.
- Produces: documented local-to-cloud verification path for the next flashing session.

- [ ] **Step 1: Add a hardware verification section to the remote README**

Append to `tools/remote_mqtt/README.md`:

````markdown
## Real ESP32 Test

1. Find the PC LAN IP.
2. Set `CONFIG_CLOUD_MQTT_URI` to `mqtt://<PC_LAN_IP>:1883` through ESP-IDF menuconfig or by editing the project config for the test build.
3. Build and flash the firmware.
4. Put the ESP32 in STA or APSTA mode and connect it to the same LAN as the PC.
5. Start the local stack:

```bash
cd tools/remote_mqtt
docker compose up
```

6. Open:

```text
http://localhost:3000
```

7. Verify status updates about every 5 seconds.
8. Send `query_status`, `set_uart_baud`, `set_comm_mode`, `ble_start`, and `display_text`.
9. Verify every command produces an ACK in the command log.
10. Switch ESP32 to AP mode and verify the remote page becomes offline or stale after MQTT disconnects.
````

- [ ] **Step 2: Add the cloud deployment handoff to the workflow doc**

Append to `docs/CLOUD_LOCAL_WORKFLOW.md`:

````markdown
## Remote MQTT MVP

The remote-access MVP lives under:

```text
tools/remote_mqtt/
```

Local validation uses Docker Compose:

```bash
cd tools/remote_mqtt
docker compose up
```

The browser opens:

```text
http://localhost:3000
```

For ESP32 hardware testing, set the firmware MQTT URI to the PC LAN address:

```text
mqtt://<PC_LAN_IP>:1883
```

For Ubuntu deployment, copy `tools/remote_mqtt/` to the server, run `docker compose up -d`, expose ports `1883` and `3000`, and change the firmware MQTT URI to the cloud server IP or domain.
````

- [ ] **Step 3: Run final local source checks**

Run:

```bash
node scripts/remote_mqtt_server_regression.mjs
node scripts/cloud_mqtt_contract_regression.mjs
node scripts/wifi_true_modes_regression.mjs
node scripts/oled_layout_regression.mjs
node scripts/oled_wifi_status_regression.mjs
node scripts/wifi_auto_scan_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
git diff --check
```

Expected: all scripts PASS and `git diff --check` prints no output.

- [ ] **Step 4: Run final ESP-IDF build**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: output includes `Project build complete.`.

- [ ] **Step 5: Commit docs and verification updates**

```bash
git add tools/remote_mqtt/README.md docs/CLOUD_LOCAL_WORKFLOW.md
git commit -m "Document remote MQTT validation workflow"
```

---

## Full Verification Matrix

Run after all tasks are complete:

```bash
node scripts/remote_mqtt_server_regression.mjs
node scripts/cloud_mqtt_contract_regression.mjs
node scripts/wifi_true_modes_regression.mjs
node scripts/oled_layout_regression.mjs
node scripts/oled_wifi_status_regression.mjs
node scripts/wifi_auto_scan_regression.mjs
node scripts/wifi_scan_ap_stability_regression.mjs
node scripts/wifi_scan_timing_regression.mjs
node scripts/wifi_page_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
git diff --check
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected:

- Every Node regression script prints its PASS message or exits with code 0.
- `git diff --check` prints no output.
- ESP-IDF build prints `Project build complete.`.
- With Docker available, `cd tools/remote_mqtt && docker compose up` starts Mosquitto and the web service.
- With the mock device running, the browser dashboard shows `esp32-001` online and command ACKs appear.
- With real hardware in STA/APSTA and MQTT URI pointed to the PC LAN IP, status updates and command ACKs appear in the browser.
