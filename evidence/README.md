# Evidence Index

All paths below are part of the `runtime-snapshot-20260817` snapshot.

## Firmware and flash

- `flash-20260807/` is the complete original new-board flash package.
- `runtime-build-20260807/` contains the outputs from the identified schema 7
  firmware worktree.
- `firmware-web-overlay-schema7/` preserves the four web files that were newer
  than the firmware Git base and were used to build `storage.bin`.

## Frontend

`frontend-runtime-20260807/source/` is a directly buildable source tree. It is
based on commit `a60c85f` plus the then-uncommitted source files and edits.
`rebuilt-dist/` was generated from that copied source and matches the board
assets. `frontend-history-through-a60c85f.bundle` preserves the committed
history needed to recover the base independently.

The `.gitnexus` cache, dependency directory, previous build directory, and agent
instruction files were excluded because they are not source inputs.

## Board and cloud

`board-20260817/` contains only read-only HTTP/API captures. Files requested as
normal web paths contain gzip bytes because that is how the ESP32 serves its
precompressed resources.

`cloud-current-20260817/` is a selective production capture. It deliberately
contains no `.env`, credentials, keys, database data, volumes, or backups.

## Older main checkout

`main-worktree-local-changes/tracked.patch` preserves all tracked modifications
from `wireless_debug-main` using Git's binary patch format. The `untracked/`
tree preserves its four untracked Python files. These files are recovery
material and were not applied to the runtime firmware source.

