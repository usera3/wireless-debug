```text
/make-plan Redesign remote MQTT dashboard. Current design failed audit at 13/30 with critical gaps in principles #3 aesthetic, #4 understandable, #5 unobtrusive, #8 thorough detail, #9 environmentally friendly, and #10 as little design as possible.

Verdict paragraph (quoted from 03-verdict.md):
> Verdict: REDESIGN. The current remote dashboard is useful and honest, but at 13/30 it fails the audit threshold because its information architecture, visual hierarchy, detail states, and restraint are not strong enough for a professional operations console.

Why redesign and not refine: The main problem is structural, not cosmetic: repeated status layers and card-heavy grouping cause the same concepts to compete across the page, so restyling would preserve the confusing hierarchy.

Preserve from current design (MUST be non-empty):
- Working MQTT command behavior and endpoint wiring in `tools/remote_mqtt/server/public/index.html:835`, `tools/remote_mqtt/server/public/index.html:841`, `tools/remote_mqtt/server/public/index.html:884`.
- Chinese-first dashboard purpose and operational copy direction in `tools/remote_mqtt/server/public/index.html:494`, `tools/remote_mqtt/server/public/index.html:496`.
- Required controls: WiFi mode, UART baud, communication mode, BLE broadcast, OLED text, refresh status, and clear log. Evidence: `tools/remote_mqtt/server/public/index.html:539`, `tools/remote_mqtt/server/public/index.html:560`, `tools/remote_mqtt/server/public/index.html:578`, `tools/remote_mqtt/server/public/index.html:597`, `tools/remote_mqtt/server/public/index.html:605`, `tools/remote_mqtt/server/public/index.html:614`, `tools/remote_mqtt/server/public/index.html:627`.
- Live status fields that operators need: device online, broker, WiFi mode, AP IP, STA IP, STA state, UART baud, BLE, WebSocket, uptime, pending command, recent ACK. Evidence: `tools/remote_mqtt/server/public/index.html:727`, `tools/remote_mqtt/server/public/index.html:735`, `tools/remote_mqtt/server/public/index.html:742`, `tools/remote_mqtt/server/public/index.html:748`.

Discard (MUST be non-empty):
- Three duplicated status layers: header badges, 5 summary cards, and status-section rows/chips. Evidence: `tools/remote_mqtt/server/public/index.html:498`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:726`. Caused failure on principles #10 and #4.
- Nested cards inside the status panel. Evidence: `tools/remote_mqtt/server/public/index.html:166`, `tools/remote_mqtt/server/public/index.html:201`. Caused failure on principles #3 and #5.
- Fragmented token usage: 21 rendered/referenced colors, many spacing values, and low-contrast status chips. Evidence: `tools/remote_mqtt/server/public/index.html:8`, `tools/remote_mqtt/server/public/index.html:255`, `tools/remote_mqtt/server/public/index.html:261`. Caused failure on principles #3 and #8.

Top 3-5 moves from the audit (verbatim):
1. Principle #10 — As little design as possible: collapse the header badges, 5 summary cards, and repeated status rows into one primary device-state strip plus one detailed table. Evidence: `tools/remote_mqtt/server/public/index.html:498`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:726`.
2. Principle #4 — Understandable: replace unexplained operational jargon with Chinese-first labels and short secondary technical labels, especially for `Broker`, `SSE`, `ACK`, `AP / STA / APSTA`, `UART Baud`, `BLE`, and `WebSocket`. Evidence: `tools/remote_mqtt/server/public/index.html:500`, `tools/remote_mqtt/server/public/index.html:537`, `tools/remote_mqtt/server/public/index.html:548`, `tools/remote_mqtt/server/public/index.html:555`, `tools/remote_mqtt/server/public/index.html:573`, `tools/remote_mqtt/server/public/index.html:740`.
3. Principle #3 — Aesthetic: replace the nested-card layout with a denser console layout using one tokenized spacing scale, fewer color roles, and clearer state severity colors. Evidence: `tools/remote_mqtt/server/public/index.html:121`, `tools/remote_mqtt/server/public/index.html:166`, `tools/remote_mqtt/server/public/index.html:201`.
4. Principle #8 — Thorough detail: add explicit focus states, a deliberate command-pending state, and accessible status-chip contrast. Evidence: `tools/remote_mqtt/server/public/index.html:255`, `tools/remote_mqtt/server/public/index.html:261`, `tools/remote_mqtt/server/public/index.html:321`, `tools/remote_mqtt/server/public/index.html:764`.
5. Principle #5 — Unobtrusive: reduce border/chip/card chrome so the current connection state, IPs, and command result become the dominant information. Evidence: `/tmp/design-is-remote-dashboard-desktop.png`, `tools/remote_mqtt/server/public/index.html:128`, `tools/remote_mqtt/server/public/index.html:201`, `tools/remote_mqtt/server/public/index.html:241`.

Redesign principles in priority order:
1. Principle #10 — As little design as possible: one primary device-state strip, one detailed status table, one command console, and one log stream; remove duplicated summaries.
2. Principle #4 — Understandable: Chinese-first operational labels with compact technical secondary labels, so a field operator can scan status without decoding abbreviations.
3. Principle #3 — Aesthetic: quiet enterprise console, restrained density, consistent 4/8/12/16/24 spacing, limited semantic color roles, no nested cards.
4. Principle #8 — Thorough detail: explicit focus-visible, disabled, empty, pending, success, and error states; state colors must meet contrast for normal text.

Deliverables for the plan:
- New information architecture (not derived from old)
- New primary flow (low-fi, labeled, compared side-by-side to current)
- States checklist (empty, loading, error, success, focus, disabled)
- Migration path for users currently on the old design
- Cutover criteria (when is the old design retired)
- Verification plan: `node scripts/remote_mqtt_server_regression.mjs`, `git diff --check`, Playwright desktop/mobile screenshots, and live command ACK if the ESP32 remains online.

Anti-patterns to guard against (specific to REDESIGN):
- Porting old structure under new styling
- Keeping both designs behind a flag indefinitely
- Redesigning to follow a trend rather than the principles above
- Treating the Preserve list as optional — it must be filled before this handoff is valid
```
