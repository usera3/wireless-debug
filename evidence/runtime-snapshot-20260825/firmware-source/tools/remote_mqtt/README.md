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

When Docker runs through Windows Docker Desktop or WSL, the published MQTT
port may be reachable from Windows as `127.0.0.1:1883` but not from the
hotspot adapter as `192.168.137.1:1883`. In that case, keep this relay
running in a Windows terminal:

```bat
tools\remote_mqtt\start_hotspot_mqtt_relay.bat
```

The relay forwards `192.168.137.1:1883` to `127.0.0.1:1883`, which matches
the firmware test build MQTT URI.

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

6. If testing through the Windows hotspot, start the hotspot relay:

```bat
tools\remote_mqtt\start_hotspot_mqtt_relay.bat
```

7. Open:

```text
http://localhost:3000
```

8. Verify status updates about every 5 seconds.
9. Send `query_status`, `set_uart_baud`, `set_comm_mode`, `ble_start`, and `display_text`.
10. Verify every command produces an ACK in the command log.
11. Switch ESP32 to AP mode and verify the remote page becomes offline or stale after MQTT disconnects.
