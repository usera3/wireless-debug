# 183 Deployment Evidence

These files describe the Wireless Debug service running on private host 183 on
2026-08-25. The backend and `dist/orig/` assets match firmware/cloud commit
`f3e705c` and frontend commit `fd40805`.

- `app.env.redacted` contains non-secret runtime settings only.
- `supervisord.conf` is the captured Supervisor program definition with secret
  values removed.
- `source-sha256.txt` hashes the source and static files copied into
  `cloud-183/source/`.

The live host has no Git metadata in `/apps/svr/wireless-debug-cloud`, so this
snapshot is the source-of-record for the deployed runtime. Do not recreate or
commit `/apps/conf/wireless-debug-cloud/app.env`, `credentials.txt`, database
files, TLS material, or runtime caches from this evidence directory.

The remote checks recorded for this capture were: Supervisor programs
`cloud`, `mosquitto`, and `postgres` running; listeners on `18080`, `18088`,
`18089`, and `1883`; HTTP `200` on the local test page; HTTP `426` on the
WebSocket listener without an upgrade request; and a successful MQTT CONNACK.
Before the device-naming deployment, the runtime and configuration were backed
up to `/apps/backups/wireless-debug-cloud/pre-device-naming-20260825T174136.tar.gz`.
Only the `cloud` Supervisor program was restarted; Mosquitto and PostgreSQL
were left running. Health and device APIs returned HTTP 200, the WebSocket HTTP
probe returned 426, MQTT returned a valid CONNACK, and the device API returned
`ESP32_B849`, `ESP32_B885`, and `ESP32_7C9D` after migration.
