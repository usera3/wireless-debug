# Design Audit Verdict

Verdict: REDESIGN. The current remote dashboard is useful and honest, but at 13/30 it fails the audit threshold because its information architecture, visual hierarchy, detail states, and restraint are not strong enough for a professional operations console.

## Why Not Refine

The main problem is structural, not cosmetic: repeated status layers and card-heavy grouping cause the same concepts to compete across the page. Changing colors, spacing, or typography alone would preserve the confusing hierarchy.

## Highest-Leverage Moves

1. Principle #10 — As little design as possible: collapse the header badges, 5 summary cards, and repeated status rows into one primary device-state strip plus one detailed table. Evidence: `tools/remote_mqtt/server/public/index.html:498`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:726`.
2. Principle #4 — Understandable: replace unexplained operational jargon with Chinese-first labels and short secondary technical labels, especially for `Broker`, `SSE`, `ACK`, `AP / STA / APSTA`, `UART Baud`, `BLE`, and `WebSocket`. Evidence: `tools/remote_mqtt/server/public/index.html:500`, `tools/remote_mqtt/server/public/index.html:537`, `tools/remote_mqtt/server/public/index.html:548`, `tools/remote_mqtt/server/public/index.html:555`, `tools/remote_mqtt/server/public/index.html:573`, `tools/remote_mqtt/server/public/index.html:740`.
3. Principle #3 — Aesthetic: replace the nested-card layout with a denser console layout using one tokenized spacing scale, fewer color roles, and clearer state severity colors. Evidence: `tools/remote_mqtt/server/public/index.html:121`, `tools/remote_mqtt/server/public/index.html:166`, `tools/remote_mqtt/server/public/index.html:201`.
4. Principle #8 — Thorough detail: add explicit focus states, a deliberate command-pending state, and accessible status-chip contrast. Evidence: `tools/remote_mqtt/server/public/index.html:255`, `tools/remote_mqtt/server/public/index.html:261`, `tools/remote_mqtt/server/public/index.html:321`, `tools/remote_mqtt/server/public/index.html:764`.
5. Principle #5 — Unobtrusive: reduce border/chip/card chrome so the current connection state, IPs, and command result become the dominant information. Evidence: `/tmp/design-is-remote-dashboard-desktop.png`, `tools/remote_mqtt/server/public/index.html:128`, `tools/remote_mqtt/server/public/index.html:201`, `tools/remote_mqtt/server/public/index.html:241`.
