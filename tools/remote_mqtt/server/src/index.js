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

function publicPendingCommand(command) {
  return {
    command_id: command.command_id,
    device_id: command.device_id,
    type: command.type,
    sent_at: command.sent_at,
  };
}

function publicDevice(device) {
  return {
    ...device,
    online: isDeviceOnline(device),
    broker_connected: brokerConnected,
    pending_commands: [...pending.values()]
      .filter((cmd) => cmd.device_id === device.device_id)
      .map(publicPendingCommand),
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

mqttClient.on('error', (err) => {
  sendEvent('broker', { connected: false, error: err.message, at: nowIso() });
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
