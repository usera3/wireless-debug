# Cloud Runtime Capture

This directory captures the Wireless Debug production deployment as observed
on 2026-08-17.

- `source/remote_mqtt_python/` contains only explicitly selected non-secret
  application and deployment files.
- `deployed-dist/orig/` contains all eight deployed frontend assets.
- `runtime-services.jsonl` records the three Wireless Debug Compose services.
- `deployed-file-stat.txt` and `server-capture-time.txt` record server-side
  timing information.

The production `.env`, historical backups, credentials, keys, database data,
Docker volumes, and unrelated server applications are intentionally absent.

