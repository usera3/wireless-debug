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
