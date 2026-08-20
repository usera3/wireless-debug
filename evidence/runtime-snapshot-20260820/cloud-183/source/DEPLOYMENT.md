# Wireless Debug 183 Deployment

Deployed: 2026-08-03 (Asia/Shanghai)

## Source

- Firmware/cloud repository branch: `wifi-provisioning-fix-20260803`
- Firmware/cloud repository commit: `9be8d1b`
- Web source commit: `a60c85f`
- `app.py` SHA-256: `1eca61826a999adfdd229d9bde034ea20b62c8c30e2a34f3ae00713f2515333e`
- `ws_fanout.py` SHA-256: `50ada87f72696c1b86512ea9514a191eaa53bce9ef080fa83884d781055af1a3`
- `a.js` SHA-256: `adf4da9cba75bc2e84d1c1eb5038b9f3e48b2d2eca9b8b2bfd4b20f773702598`

This is a fresh deployment. It does not contain a copy of the Japan PostgreSQL data.

## Runtime

- Python 3.11.15
- Flask 3.1.3
- Waitress 3.0.2
- WebSockets 15.0.1
- Paho MQTT 2.1.0
- Psycopg 3.3.4
- PostgreSQL 17.10
- Mosquitto 2.0.20
- Supervisor 4.3.0

The runtime is installed under:

`/apps/.local/share/micromamba/envs/wireless-debug`

## Layout

- Application: `/apps/svr/wireless-debug-cloud`
- Configuration: `/apps/conf/wireless-debug-cloud`
- Persistent data: `/apps/dbdat/wireless-debug-cloud`
- Logs: `/apps/logs/wireless-debug-cloud`
- Runtime state: `/apps/run/wireless-debug-cloud`
- Login credentials: `/apps/conf/wireless-debug-cloud/credentials.txt` (mode 600)

## Ports

- `18088/tcp`: HTTP/API, bound to all interfaces
- `18089/tcp`: browser/device WebSocket, bound to all interfaces
- `1883/tcp`: MQTT, bound to all interfaces
- `5432/tcp`: PostgreSQL, bound to `127.0.0.1` only

## Operations

```bash
runtime=/apps/.local/share/micromamba/envs/wireless-debug
config=/apps/conf/wireless-debug-cloud/supervisord.conf

$runtime/bin/supervisorctl -c $config status
$runtime/bin/supervisorctl -c $config restart cloud
$runtime/bin/supervisorctl -c $config restart all
```

Supervisor starts from the `apps` user's crontab after a server reboot. The existing VNT startup entry is preserved.

## Public Ingress Follow-up

1. Point the approved public IP/load balancer and domain to HTTP service port `18088`.
2. Route `/ws/device/*` and `/ws/uplink/*` to WebSocket port `18089` with WebSocket upgrade headers.
3. Set `CLOUD_WS_PUBLIC_URL=wss://<domain>` in `app.env` after TLS is available, then restart only `cloud`.
4. Put human browser/API paths behind MAS authentication.
5. Give ESP32 device traffic separate device authentication; do not apply browser MAS redirects to device WebSocket or MQTT traffic.
6. Protect public MQTT with TLS and per-device credentials before exposing `1883` externally.
7. Never expose PostgreSQL port `5432` publicly.

