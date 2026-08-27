# 183 Deployment Evidence

These files describe the Wireless Debug service running on private host 183 on
2026-08-27. The backend matches firmware/cloud commit `fc022fa`; the
`dist/orig/` assets match frontend commit `fd40805`.

- `app.env.redacted` contains non-secret runtime settings only.
- `supervisord.conf` is the captured Supervisor program definition with secret
  values removed.
- `source-sha256.txt` hashes the source and static files copied into
  `cloud-183/source/`.

The live host has no Git metadata in `/apps/svr/wireless-debug-cloud`, so this
snapshot is the source-of-record for the deployed runtime. Do not recreate or
commit `/apps/conf/wireless-debug-cloud/app.env`, `credentials.txt`, database
files, TLS material, or runtime caches from this evidence directory.

The 2026-08-27 online capture checked every archived source and `dist/orig/`
asset against `/apps/svr/wireless-debug-cloud`. Supervisor reported `cloud`,
`mosquitto`, and `postgres` running. Before the parameter-upload update, the
runtime was backed up to
`/apps/backups/wireless-debug-cloud/pre-param-upload-20260826T181509.tar.gz`.
Only the `cloud` program was restarted for that deployment.

The deployed backend accepts `multipart/form-data` from the browser while
retaining raw `X-Filename` and Base64 JSON compatibility. A real 47,495-byte
`ParameterTable.xlsx` passed upload and subsequent server-load validation.
