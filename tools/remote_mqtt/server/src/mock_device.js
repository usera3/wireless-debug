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
