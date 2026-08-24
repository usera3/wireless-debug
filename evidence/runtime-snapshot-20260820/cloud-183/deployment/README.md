# 183 Deployment Evidence

These files describe the Wireless Debug service captured from private host 183
on 2026-08-20 through the approved VNT SSH path. The `dist/orig/` static assets
and their checksums were refreshed after the verified 2026-08-21 deployment.

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
Before the August 21 static refresh, the deployed files were backed up to
`/apps/backups/wireless-debug-cloud/pre-static-20260821T124743.tar.gz`. After
the refresh, the `cloud` Supervisor service was running and the WebSocket HTTP
probe continued to return the expected `426` response.
