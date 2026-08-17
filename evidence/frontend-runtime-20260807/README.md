# Frontend Runtime Source

Base commit:

```text
a60c85f883820478a2fab4c4a292258dc455ac16
```

The `source/` directory already contains the tracked working-tree edits and
untracked source/test files that existed when the 2026-08-07 web bundle was
built. To reproduce the bundle:

```bash
cd source
npm ci --no-audit --no-fund
npm run build
```

That procedure was rerun in an isolated directory on 2026-08-17 with Node.js
and Vite 5.4.21. Every generated file matched `rebuilt-dist/` and the retained
2026-08-07 firmware web assets by SHA-256.

`tracked-overlay.patch` records the tracked changes relative to `a60c85f`.
`source-worktree-status.txt` records both tracked and untracked paths. The full
source tree is authoritative because untracked source files are part of the
successful build.
