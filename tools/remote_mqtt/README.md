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

The real ESP32 must use the PC address reachable from the hotspot network, not `localhost`.

Example:

```text
mqtt://192.168.137.1:1883
```

Mosquitto listens on `0.0.0.0:1883`. If ESP32 cannot connect, allow inbound TCP port `1883` in Windows firewall.

## Ubuntu Deployment

Copy this directory to the Ubuntu server, install Docker, and run:

```bash
docker compose up -d
```

Open inbound ports `1883` and `3000` for the MVP. Before broader exposure, add broker username/password, web login, and TLS.

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
