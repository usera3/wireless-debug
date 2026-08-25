# Frontend Runtime Source

This directory is a source snapshot of the web application used to build the
2026-08-25 runtime assets.

Base commit (tested asset source):

```text
22fb25a
```

The `source/` tree excludes `node_modules/` and generated `dist/` files. Build
the checked-in source with:

```bash
npm ci --no-audit --no-fund
npm run lint
npm run build
```

The generated bundle is archived separately in the parent firmware snapshot,
and `source-worktree-status.txt` records the source worktree state at capture
time. The source tree is copied from the clean `22fb25a` frontend commit.
