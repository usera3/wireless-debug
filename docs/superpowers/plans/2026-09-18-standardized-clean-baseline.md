# Standardized Clean Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a new, history-independent `standard/main` firmware branch that contains only buildable source and required runtime web assets, with enforceable repository hygiene rules.

**Architecture:** Build an orphan root commit from the verified firmware source tree at `fc022fa9b19f6bd59beb2324cc8f21ad19c1c20d`. Remove recovery snapshots and binary release packages from the Git tree, retain the active ESP-IDF source plus `dist/`, and record provenance instead of copying other repositories. A deterministic hygiene script and GitLab CI job prevent dated snapshots, release binaries, nested source copies, and oversized files from returning.

**Tech Stack:** Git, ESP-IDF 6.0, Python 3, GitLab CI.

## Global Constraints

- The new branch is exactly `standard/main` and its first commit has no parent.
- Do not alter, delete, force-push, or retag any existing branch or tag.
- Source provenance is firmware `fc022fa9b19f6bd59beb2324cc8f21ad19c1c20d`, frontend `fd40805932197928f8f9f57f25064944ffd35248`, and firmware-binary source `f3e705cabdad6e02478a02f47ac4ac4f57ff72cd`.
- Retain the top-level ESP-IDF source, tests, scripts, tools, engineering docs, configuration, and active `dist/` assets byte-for-byte unless a task explicitly changes repository-policy files. The sole source-parity exception is the stale `wifi_true_modes_regression.mjs` APSTA OLED matcher discovered during Task 3: align it with the already-shipped dynamic `AP:%s` SSID row while continuing to require separate AP and STA IP rows.
- Remove `evidence/`, `artifacts/`, `DESIGN-IS-2026-07-08/`, and `RUNTIME_SNAPSHOT_20260817.md` from the new tree.
- Do not commit firmware/release archives, dated snapshot directories, copied firmware/frontend/cloud source trees, credentials, build output, or deployment captures. Required compressed `dist/` runtime assets remain tracked.
- Release binaries belong in GitLab Release/Package Registry or another approved artifact store; Git records only source SHAs, artifact URL/version, size, and SHA-256.
- Do not deploy, flash hardware, or change any source behavior in this task.

---

### Task 1: Define and apply the clean repository boundary

**Files:**
- Delete: `evidence/`
- Delete: `artifacts/`
- Delete: `DESIGN-IS-2026-07-08/`
- Delete: `RUNTIME_SNAPSHOT_20260817.md`
- Modify: `.gitignore`
- Create: `docs/REPOSITORY_POLICY.md`
- Create: `docs/BASELINE_PROVENANCE.md`

**Interfaces:**
- Consumes: the orphan worktree populated from firmware commit `fc022fa`.
- Produces: a buildable source tree without embedded recovery packages.

- [ ] **Step 1: Capture the pre-clean tree inventory**

Run:

```bash
git status --short --branch
git ls-files | wc -l
git ls-files 'evidence/**' 'artifacts/**' | wc -l
```

Expected: branch reports `No commits yet on standard/main`; the snapshot and artifact counts are non-zero.

- [ ] **Step 2: Remove archive-only paths from the orphan index and worktree**

Delete only the four paths named in the task file list. Do not remove top-level `dist/`; firmware builds consume those active SPIFFS assets.

- [ ] **Step 3: Replace the obsolete snapshot exception in `.gitignore`**

Remove the rule that re-includes `evidence/runtime-snapshot-*/firmware-flash/*.bin`. Add these repository-level rules:

```gitignore
# Release packages and recovery captures live outside the source repository.
/evidence/
/artifacts/
/releases/
/runtime-snapshot-*/
*.zip
*.bundle
```

Keep the existing ESP-IDF build, binary, editor, dependency, and runtime-state exclusions.

- [ ] **Step 4: Document policy and provenance**

`docs/REPOSITORY_POLICY.md` must define tracked content, excluded release content, branch rules, Conventional Commit examples, the GitLab release-manifest fields, and the prohibition against dated snapshot directories. `docs/BASELINE_PROVENANCE.md` must record the three exact SHAs from Global Constraints, the previous published branch `runtime-snapshot-20260827` at `fab0f6c58bc675af86085614ebd1c1583bc2cc57`, and explain that archived material remains accessible there.

- [ ] **Step 5: Verify the clean boundary**

Run:

```bash
test ! -e evidence
test ! -e artifacts
test ! -e DESIGN-IS-2026-07-08
test ! -e RUNTIME_SNAPSHOT_20260817.md
test -f main/main.c
test -f dist/index.html
```

Expected: all checks exit 0.

- [ ] **Step 6: Commit the clean source boundary**

Commit all retained source, policy files, and planned deletions as the first root commit:

```text
chore: define clean source boundary
```

---

### Task 2: Add an enforceable repository hygiene gate

**Files:**
- Create: `scripts/repository_hygiene_check.py`
- Create: `scripts/repository_hygiene_check_regression.py`
- Create: `.gitlab-ci.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: `scan_paths(paths: list[tuple[str, int]]) -> list[str]` and a CLI that checks `git ls-files -z`.
- Enforces: forbidden directory components, nested copied-source markers, release extensions, common credential indicators, and a 2 MiB per-file limit.

- [ ] **Step 1: Write the failing regression**

The regression imports `scan_paths` and asserts all of these inputs are rejected:

```python
FORBIDDEN = [
    ("evidence/runtime-snapshot-20260918/README.md", 10),
    ("artifacts/full-flash.zip", 10),
    ("release/firmware.bin", 10),
    ("backup/web-source/source/package.json", 10),
    ("docs/history.bundle", 10),
    ("fixtures/too-large.dat", 2 * 1024 * 1024 + 1),
]
```

It also asserts `main/main.c`, `dist/orig/a.js`, `sdkconfig`, and `docs/REPOSITORY_POLICY.md` are accepted below the size limit.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
python3 scripts/repository_hygiene_check_regression.py
```

Expected: fail because `repository_hygiene_check.py` does not exist.

- [ ] **Step 3: Implement the hygiene scanner**

Create a dependency-free Python module that normalizes paths to `/`, rejects the directory components `evidence`, `artifacts`, `releases`, and `release` at any depth, and rejects any component beginning `runtime-snapshot-`; rejects firmware/archive suffixes while preserving required compressed `dist/` assets; rejects nested markers `/firmware-source/`, `/web-source/source/`, and `/cloud-183/source/`; rejects common credential filenames and recognizable private-key/token signatures; and rejects tracked files larger than `2 * 1024 * 1024` bytes. The CLI must read tracked paths from `git ls-files -z`, inspect their worktree sizes and contents, print every violation, and exit 1 if any exist.

- [ ] **Step 4: Add the GitLab CI job**

Create `.gitlab-ci.yml` with a `test` stage and a `repository_hygiene` job that runs:

```yaml
repository_hygiene:
  stage: test
  script:
    - python3 scripts/repository_hygiene_check.py
    - python3 scripts/repository_hygiene_check_regression.py
```

- [ ] **Step 5: Update the README workflow**

Add a concise `Repository workflow` section that names `standard/main` as the future base, links both policy documents, requires feature branches from `standard/main`, and tells release authors to publish artifacts outside Git rather than create `runtime-snapshot-*` branches or directories.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
python3 scripts/repository_hygiene_check_regression.py
python3 scripts/repository_hygiene_check.py
```

Expected: both print success and exit 0.

- [ ] **Step 7: Commit the enforcement gate**

Commit subject:

```text
ci: enforce repository hygiene
```

---

### Task 3: Verify and establish the final root commit

**Files:**
- Verify: entire tracked tree
- Commit: all clean-baseline files

**Interfaces:**
- Produces: one reviewed parentless commit on local `standard/main`, ready for publication.

- [ ] **Step 1: Verify retained source parity**

For every retained path from `fc022fa`, compare blob IDs against the source commit while excluding only the four removed archive paths and the policy/hygiene files changed by this plan. Any unexplained product-source difference is a failure.

- [ ] **Step 2: Run source regressions and the ESP-IDF build**

Run this exact dependency-free regression set:

```bash
node scripts/oled_i2c_speed_regression.mjs
node scripts/oled_layout_regression.mjs
node scripts/oled_menu_animation_regression.mjs
node scripts/oled_wifi_status_regression.mjs
node scripts/wifi_page_regression.mjs
node scripts/wifi_true_modes_regression.mjs
python3 scripts/cloud_device_naming_regression.py
python3 scripts/cloud_ws_downlink_regression.py
```

`cloud_platform_react_route_regression.py` and `cloud_session_auth_regression.py`
are live-service integration probes, not dependency-free source regressions: both
require an explicit `--base-url` and authenticated test credentials. Run them only
when a cloud test environment is separately authorized and supplied; they are not
part of this source-only, no-server-access baseline verification.

Generate managed components, apply the tracked diagnostic patch, and build with
bounded concurrency:

```bat
cmd.exe /D /S /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main\.worktrees\standard-main && call C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py reconfigure"
```

```bash
patch -p1 -d managed_components/espressif__esp_websocket_client \
  < patches/esp_websocket_client_tx_diagnostics.patch
```

```bat
cmd.exe /D /S /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main\.worktrees\standard-main\build && call C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && ninja -j4"
```

Expected: regression commands pass, both patch files apply, Ninja exits 0, and
`build/uart_ble_wifi.bin` plus `build/bootloader/bootloader.bin` exist. The `-j4`
limit avoids the reproducible Windows process-launch failures seen at higher
toolchain concurrency.

- [ ] **Step 3: Verify the prospective Git tree**

Run:

```bash
python3 scripts/repository_hygiene_check.py
git diff --cached --check
git status --short --branch
```

Expected: only intended files are staged on `standard/main`; no forbidden content or whitespace errors.

- [ ] **Step 4: Collapse reviewed setup commits into the parentless baseline**

After Tasks 1 and 2 have passed their individual reviews, create a new root commit from the reviewed final tree and move only `standard/main` to it:

```bash
tree=$(git rev-parse HEAD^{tree})
root=$(printf '%s\n' 'chore: establish standardized clean baseline' | git commit-tree "$tree")
git reset --hard "$root"
```

Verify `git rev-list --parents -n 1 HEAD` prints exactly one SHA field and `git rev-list --count HEAD` prints `1`.

- [ ] **Step 5: Run the final whole-branch review**

Generate a fresh review package from the synthetic empty review base to the new
root commit. The reviewer must verify the complete tree, test/build evidence,
single-root history, and absence of forbidden content before any remote write.

---

### Task 4: Update future-agent policy and publish only the new branch

**Files:**
- Modify outside repository: `/home/sunqi39/.codex/skills/wireless-debug-espidf/SKILL.md`
- Publish: `refs/heads/standard/main`

**Interfaces:**
- Consumes: approved Task 3 root commit and the captured failing skill-policy scenario.
- Produces: a future workflow that uses `standard/main` without recreating snapshots, plus the new remote branch.

- [ ] **Step 1: Replace and validate the obsolete skill contract**

Replace the complete-snapshot contract with the clean source/release-artifact policy:
normal work branches from `standard/main`, ordinary source pushes remain code-only,
dated snapshot branches/directories are not created unless the user explicitly asks
for legacy archival work, and release artifacts live outside Git with a manifest.
Run the skill validator afterward.

- [ ] **Step 2: Run an independent forward scenario**

Have a fresh agent read the updated skill and explain how it would publish a
hypothetical one-line firmware fix. Expected: it proposes only a normal feature/fix
branch and source commit (plus an external release manifest only if a release was
requested); it must not create `runtime-snapshot-*` or `evidence/` content.

- [ ] **Step 3: Snapshot existing remote refs**

Record `standard/main` absence and every existing `runtime-snapshot-*` ref immediately
before publication so the post-push comparison can prove they were not changed.

- [ ] **Step 4: Push the new branch without modifying existing refs**

Use the authenticated Windows Git client from the main checkout:

```bat
git -C D:\Users\sunqi39\Desktop\wireless_debug-main push -u midea refs/heads/standard/main:refs/heads/standard/main
```

Do not force-push. Verify with `git ls-remote midea refs/heads/standard/main` and confirm every existing `runtime-snapshot-*` remote ref is unchanged.
