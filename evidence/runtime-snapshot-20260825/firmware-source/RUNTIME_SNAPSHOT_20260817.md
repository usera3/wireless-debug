# Wireless Debug Runtime Snapshot - 2026-08-17

This branch preserves the code and artifacts that identify the system in use
after the 2026-08-07 flash. It intentionally keeps firmware, frontend, live
board evidence, and cloud deployment evidence in one Git snapshot.

## Proven result

- Firmware Git base: `9be8d1b4ec0f216f10cb2cabb010fc6917bb15f6`
- Firmware source branch at capture: `wifi-provisioning-fix-20260803`
- Firmware cloud uplink schema: `7`
- Frontend Git base: `a60c85f883820478a2fab4c4a292258dc455ac16`
- Frontend source: that commit plus the preserved working-tree overlay from
  `.codex-osc-continuity-20260723`
- Snapshot branch and tag: `runtime-snapshot-20260817`

The firmware worktree was rebuilt incrementally on 2026-08-17. The resulting
application and SPIFFS images still match the 2026-08-07 flash package exactly:

```text
347ae447ad4dcf25e5db55fd30cb77d9030a0d71dacca3d69fe00e167de0e562  uart_ble_wifi.bin
1f415c162cdfddcfc7ecfefb6d205fd5e1f7a1cf45d41568c9b92f7544e946fa  storage.bin
```

The incremental ESP-IDF build completed successfully in five Ninja steps. The
application size was `0x19ae60`, with `0xe51a0` bytes free in the smallest app
partition.

## Snapshot layout

- Repository root: firmware source based on `9be8d1b`, with the exact runtime
  web assets restored under `dist/orig/`.
- `evidence/flash-20260807/`: complete flash package, including the combined
  8 MB image and the original ZIP.
- `evidence/runtime-build-20260807/`: matching build outputs and flash args.
- `evidence/frontend-runtime-20260807/`: exact frontend source, its Git bundle,
  source overlay patch, and independently rebuilt `dist` output.
- `evidence/board-20260817/`: read-only API captures and web bytes fetched from
  the live board at `192.168.4.1`.
- `evidence/cloud-current-20260817/`: current non-secret cloud source, deployed
  static assets, and service status captured from the production host.
- `evidence/main-worktree-local-changes/`: a binary-capable patch and four
  untracked source files from the older main firmware checkout. These are
  preserved but are not treated as the board's runtime baseline.
- `evidence/SHA256SUMS`: hashes for every file under `evidence/` except the
  hash list itself.

## Frontend proof

The frontend repository's currently checked-out `fe0d7da` branch is older and
does not produce the 2026-08-07 web bundle. The retained worktree based on
`a60c85f` contains uncommitted source changes. Building that source in an
isolated directory with `npm ci` and `npm run build` reproduced every runtime
asset byte-for-byte, including:

```text
39098a7dc462048940be4d29ae10af3c07455538f65b0a1909628eb9a5e94097  a.js
a33bb4e0ff95273084cf37100473b58f1a53f9380a0c8f7bfa2654ccc9027596  a.js.gz
79a994bb52c9df09367dac7d7dda8f5167cf38588059a4064a882835fcfd16d4  a.css
0276ea637ff0a2ab594c28d0dcacc1a0260aa07b36ba76e53641ff53d1ae3944  a.css.gz
```

The frontend `.env.production` is retained because it contains only the public
local `VITE_WS_URL`; it has no username, password, query, or fragment.

## Live board proof

The read-only status capture reports:

```text
cloud_ws_uplink.schema_version = 7
net = APSTA
comm = WIFI
uart_baud = 2000000
```

The board serves precompressed bytes even when the requested path omits `.gz`.
Those bytes match the firmware's `dist/orig/*.gz` files for HTML, CSS, the app
bundle, and `x.js`. No flash or configuration change was performed during the
capture.

## Cloud capture boundary

The cloud host was copied from `/home/ubuntu/wireless-debug-cloud`. Only the
explicit application modules, compose/build files, schema, deployed static
assets, timestamps, and service status are included. Production `.env` files,
credentials, backup configs, databases, volumes, keys, and unrelated services
are excluded.

The deployed cloud `a.js` differs from the board-local `a.js`; both are kept in
separate directories because they are distinct runtime surfaces.

## GitLab limitation

The local remote-tracking ref
`midea/wifi-provisioning-fix-20260803` points to `9be8d1b`. A fresh unauthenticated
`git ls-remote` check on 2026-08-17 was rejected because the Midea GitLab server
required credentials, so this snapshot does not claim an independently fetched
real-time remote head. The runtime identification instead rests on reproducible
builds and byte-identical 2026-08-07 artifacts.
