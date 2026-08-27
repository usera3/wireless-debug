# Wireless Debug 183 Deployment

Initial deployment: 2026-08-03 (Asia/Shanghai)
Static web refresh: 2026-08-25 (Asia/Shanghai)
AP-derived device naming refresh: 2026-08-25 (Asia/Shanghai)
Parameter table upload refresh: 2026-08-26 (Asia/Shanghai)
Snapshot verification: 2026-08-27 (Asia/Shanghai)

## Source

- Snapshot branch: `runtime-snapshot-20260827`
- Firmware/cloud repository commit: `fc022fa9b19f6bd59beb2324cc8f21ad19c1c20d`
- Firmware binary commit: `f3e705cabdad6e02478a02f47ac4ac4f57ff72cd`
- Web source commit: `fd40805`
- `app.py` SHA-256: `1a418abdb8804de13953097b98180c9cb6cd05bf815fe111f53d9d4526d584d3`
- `device_naming.py` SHA-256: `f196bc07d44b57a39cf234197480fd61d800fdf6c1b296c026e1eb97f01d4000`
- `remote_excel_codec.py` SHA-256: `097adb86f364b46538c2e75e4007163a6c2c2265457e73409125b9b68df598a5`
- `ws_fanout.py` SHA-256: `50ada87f72696c1b86512ea9514a191eaa53bce9ef080fa83884d781055af1a3`
- `a.js` SHA-256: `94d03c32b9bacc98d5998ba1bd043d4aca6923c01ed4957d4300952a83cfe8f9`

This is a fresh deployment. It does not contain a copy of the Japan PostgreSQL data.

The pre-update backup is
`/apps/backups/wireless-debug-cloud/pre-param-upload-20260826T181509.tar.gz`.

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
