# ELF Aggregate Variable Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the 2026-08-24 address-oscilloscope snapshot so users can lazily browse structures and arrays from arbitrary ELF32 `.out/.elf` files in the channel-name field and write the selected scalar address into the matching address field.

**Architecture:** Keep ELF parsing entirely in the browser and extend the compact DWARF graph with array subrange metadata. `AddressParser` owns expression traversal and returns at most 50 immediate, strict-prefix suggestions; the React component only manages input state, aggregate continuation, and scalar selection. The same built static assets are copied unchanged into the ESP32 SPIFFS tree and the 183 cloud snapshot.

**Tech Stack:** TypeScript 5.6, React 18, Vite 5, browser `ArrayBuffer`/`Uint8Array`, ELF32/DWARF4, Node assertion regressions, ESP-IDF 6.0, Playwright.

## Global Constraints

- Use only the 2026-08-24 snapshot baseline: web commit `f8de10883d6ca23da706f454485d126d1df45e74`, firmware commit `2c548ac95309fd10d9cd5161ef07f8f07e19485f`.
- Do not hard-code variable names or addresses from either fixture in production code.
- Keep the upload limit at exactly `64 * 1024 * 1024` bytes and reject oversized files before `arrayBuffer()` is called.
- Keep ELF section access zero-copy with `Uint8Array.subarray()`; do not replace it with whole-section `slice()` copies.
- Keep only address/type-related DWARF DIEs and never flatten all structure members or array elements at file-load time.
- Match every suggestion segment with case-insensitive `startsWith`, cap each result set at 50, and return no suggestions for an empty root query.
- Keep `.out/.elf` bytes in the browser; never upload them to ESP32 or the 183 server.
- Keep the left address input manually editable as hexadecimal; search only from the right channel-name input.
- A scalar selection always writes the complete expression into `label` and the uppercase address without `0x` into `varAddrHex`.
- Reject selected addresses outside `0x0000..0xFFFF` before updating the channel row.
- Flash the main firmware only to `COM4`; never flash the WD-BootRelay controller on `COM7`.

---

### Task 1: Preserve DWARF Array Bounds

**Files:**
- Modify: `src/lib/elfParser/binary-parser.ts`
- Modify: `src/lib/elfParser/model.ts`
- Test: `scripts/elf-address-parser-regression.ts`

**Interfaces:**
- Consumes: ELF32 `.debug_info`, `.debug_types`, `.debug_abbrev`, and existing compact `Die` objects.
- Produces: retained `DW_TAG_subrange_type` children with `DW_AT_lower_bound`, `DW_AT_upper_bound`, or `DW_AT_count` attributes.

- [ ] **Step 1: Write failing binary-parser assertions**

Add real-fixture assertions through the public parser that require `PwmSampleCmp[2]` and `iRtMcBoardList[0]` to be suggested, while `PwmSampleCmp[3]` and `iRtMcBoardList[1]` are absent.

- [ ] **Step 2: Run the regression and verify RED**

Run: `npm run test:elf-address-parser`

Expected: FAIL because the parser has no aggregate suggestion API and does not name or retain DWARF subranges.

- [ ] **Step 3: Add exact DWARF constants and retained tags**

Add `0x21: 'DW_TAG_subrange_type'`, `0x22: 'DW_AT_lower_bound'`, and `0x2f: 'DW_AT_upper_bound'`; retain the subrange DIE and keep `DW_AT_count` support. In `readAbbrevs`, preserve the decoded tag code separately so unknown tags are reported from the tag code rather than the abbreviation code.

- [ ] **Step 4: Keep byte access bounded**

Change only small string/location reads to copying operations where decoding requires owned bytes. Keep `sectionData()` and debug-section selection backed by `subarray()` views.

- [ ] **Step 5: Run the focused regression**

Run: `npm run test:elf-address-parser`

Expected: array metadata assertions advance to the address-parser behavior under test without ELF parsing errors.

### Task 2: Add Lazy Structure and Array Suggestions

**Files:**
- Modify: `src/lib/elfParser/address-parser.ts`
- Modify: `src/lib/elfParser/model.ts`
- Modify: `src/lib/elfAddressParser.ts`
- Test: `scripts/elf-address-parser-regression.ts`

**Interfaces:**
- Produces: `VariableSuggestion { expression: string; kind: 'value' | 'structure' | 'union' | 'array'; continuation: '' | '.' | '[' }`.
- Produces: `AddressParser.getSuggestions(query: string, limit?: number): VariableSuggestion[]`.
- Produces: `buildElfChannelPatch(expression: string, address: bigint | number): { label: string; varAddrHex: string }`.

- [ ] **Step 1: Add strict root, member, and array tests**

Cover `M -> McStatus1`, `McStatus1.P -> McStatus1.Pu`, `McStatus1.Pu.I -> Ia/Ib/...`, `iRtMcBoardList[ -> [0]`, and `iRtMcBoardList[0].P -> PwmSampleCmp`. Assert unrelated names never appear and every call returns at most 50 entries.

- [ ] **Step 2: Add a no-pre-expansion test**

Query a 201-element array and assert the initial bracket query returns exactly 50 entries, then query a later numeric prefix and assert matching indices remain available without storing all 201 expressions.

- [ ] **Step 3: Verify RED**

Run: `npm run test:elf-address-parser`

Expected: FAIL with `getSuggestions is not a function`.

- [ ] **Step 4: Implement expression traversal once**

Factor root/member/index traversal so `resolve()` and suggestion type inspection share the same rules. Apply DWARF lower/upper/count bounds, calculate array strides from element size and remaining dimensions, and reject out-of-range indices.

- [ ] **Step 5: Implement immediate-child suggestions**

For roots, filter sorted symbol names by strict prefix. For `.` contexts, resolve only the parent expression and inspect only its direct member DIEs. For `[` contexts, derive numeric intervals from the current DWARF subrange and emit at most `limit` canonical indices that start with the typed digits.

- [ ] **Step 6: Implement the pure channel patch helper**

Return `{ label: expression, varAddrHex: formatElfAddress(address) }` for `0x0000..0xFFFF`; throw a Chinese range error otherwise. This makes “selected name stays visible beside its waveform” testable without rendering React.

- [ ] **Step 7: Verify GREEN**

Run: `npm run test:elf-address-parser`

Expected: `elf address parser regression passed`.

### Task 3: Move Search to the Channel-Name Field

**Files:**
- Modify: `src/components/OscChannelConfig.tsx`
- Test: `scripts/elf-address-parser-regression.ts`
- Test: `scripts/osc-channel-types-regression.ts`

**Interfaces:**
- Consumes: `ElfAddressParser.getSuggestions()` and `buildElfChannelPatch()`.
- Preserves: existing parameter-alias exact-match behavior and manual hexadecimal address editing.

- [ ] **Step 1: Add source-level UI regression assertions**

Assert the address field calls only `handleAddressInput`, the label field owns suggestion focus/input behavior, and scalar selection always updates both `label` and `varAddrHex` through the pure helper.

- [ ] **Step 2: Verify RED**

Run: `npm run test:osc-channel-types`

Expected: FAIL because the 24 August UI still attaches suggestions to the address input.

- [ ] **Step 3: Move interaction state to the label input**

Keep `handleAddressInput()` limited to the hexadecimal text and row-error clearing. Make label input update the visible expression, preserve exact parameter alias lookup, query ELF suggestions only when a parser is loaded, and render the dropdown under the label field.

- [ ] **Step 4: Distinguish aggregate and scalar clicks**

For `continuation='.'` or `'['`, update the label with that suffix and keep the dropdown open. For `continuation=''`, resolve the expression, apply `buildElfChannelPatch()`, clear the row error, and close suggestions.

- [ ] **Step 5: Verify focused tests and build**

Run: `npm run test:elf-address-parser`

Run: `npm run test:osc-channel-types`

Run: `npm run lint`

Run: `npm run build`

Expected: all commands exit 0.

### Task 4: Browser Acceptance on Both ELF Fixtures

**Files:**
- Create: `scripts/elf-address-picker-playwright.mjs`

**Interfaces:**
- Consumes: local Vite page and the two fixture files from `elf_addr_tool_ts-master/elf_example`.
- Produces: desktop and mobile screenshots plus DOM assertions for field ownership and selected address/name pairs.

- [ ] **Step 1: Start a local Vite server**

Run: `npm run dev -- --host 127.0.0.1 --port 5681`

Expected: Vite serves the 24 August-derived branch at `http://127.0.0.1:5681/`.

- [ ] **Step 2: Exercise the C2000 fixture**

Upload `test_platform_c2000.out`, type and select `McStatus1.Pu.Ia`, assert the right field is `McStatus1.Pu.Ia`, and assert the left field is `C534`. Repeat for `iRtMcBoardList[0].port` and assert `C938`.

- [ ] **Step 3: Exercise the IAR fixture**

Upload `ecm_out_fan_iar.out`, browse `McStatus1.Pu.swIa`, and assert the parsed address matches the reference parser.

- [ ] **Step 4: Check desktop and mobile layout**

Capture at `1440x900` and `390x844`; assert the dropdown is visible, stays within the viewport, does not overlap the preceding address/type fields, and the longest expression remains clipped rather than resizing the grid.

### Task 5: Package the Same Assets for ESP32 and 183

**Files:**
- Modify: `/mnt/d/Users/sunqi39/Desktop/.codex-latest-fw-elf/dist/orig/*`
- Modify: `runtime-snapshot-20260824/cloud-183/source/dist/orig/*`
- Modify: snapshot checksums/readmes that describe the new artifacts.

**Interfaces:**
- Consumes: verified Vite `dist/` output.
- Produces: byte-identical ESP32 and 183 static assets derived from the same frontend build.

- [ ] **Step 1: Sync the frontend build into firmware**

Copy the complete built asset set into firmware `dist/orig/` without changing `dist/index.html` redirection behavior, then verify SHA256 equality against web `dist/`.

- [ ] **Step 2: Build ESP-IDF firmware**

Run from the firmware worktree with ESP-IDF 6.0: `idf.py build`.

Expected: `Project build complete.` and generated `uart_ble_wifi.bin`, `storage.bin`, and flash arguments.

- [ ] **Step 3: Flash and verify COM4**

Use the WD-BootRelay workflow, prove `Connected to ESP32-S3 on COM4`, flash only COM4, release BOOT to RUN, request the flasher-stub watchdog reset, and verify fresh application logs plus final `GPIO14=HIGH RELAY=OFF`.

- [ ] **Step 4: Deploy only the Wireless Debug app on 183**

Back up `/apps/svr/wireless-debug-cloud`, replace only the intended static files with the same build, restart only the `cloud` Supervisor program, and verify HTTP/API/WebSocket health through `127.0.0.1:22023`.

- [ ] **Step 5: Verify both deployed pages**

Run the same upload/search/select assertions against `http://192.168.4.1/orig/i.html` and the 183 `rdev` site. Confirm the `.out` request never appears in captured network traffic.

### Task 6: Record and Publish the Snapshot-Derived Release

**Files:**
- Modify: release/checksum documentation under the 2026-08-25 snapshot or release directory.

**Interfaces:**
- Produces: local Git commits and matching GitLab/GitHub branches containing web source, firmware source, cloud source, and flash artifacts under one date.

- [ ] **Step 1: Run final fresh verification**

Re-run parser tests, channel tests, lint, Vite build, ESP-IDF build, local browser acceptance, ESP32 browser acceptance, and 183 browser acceptance. Record exact exit codes and artifact SHA256 values.

- [ ] **Step 2: Commit scoped changes**

Commit the web branch and firmware branch without including unrelated working-tree files or credentials.

- [ ] **Step 3: Publish the same dated release**

Push the branches to the configured local/midea/GitHub remotes and keep web, firmware, cloud, and flash outputs together under the same `2026-08-25` release directory.
