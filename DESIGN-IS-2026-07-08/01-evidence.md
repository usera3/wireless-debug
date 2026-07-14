# Design Audit Evidence

## Collection Notes

Subagents were not launched because the available multi-agent tool requires explicit user authorization for subagents. Evidence was collected from the live local page, Playwright measurements, screenshots, and source inspection.

## Structural Evidence

- The primary surface contains 11 interactive elements: refresh status, 3 selects, 6 command buttons, and the OLED text input. Measured by Playwright on `http://127.0.0.1:3000`; source locations: `tools/remote_mqtt/server/public/index.html:539`, `tools/remote_mqtt/server/public/index.html:560`, `tools/remote_mqtt/server/public/index.html:566`, `tools/remote_mqtt/server/public/index.html:578`, `tools/remote_mqtt/server/public/index.html:585`, `tools/remote_mqtt/server/public/index.html:597`, `tools/remote_mqtt/server/public/index.html:603`, `tools/remote_mqtt/server/public/index.html:605`, `tools/remote_mqtt/server/public/index.html:614`, `tools/remote_mqtt/server/public/index.html:615`, `tools/remote_mqtt/server/public/index.html:627`.
- The page repeats status information across multiple regions: online/broker badges in the header, 5 summary cards, and the generated status sections. Static sources: `tools/remote_mqtt/server/public/index.html:498`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:726`.
- The desktop layout uses 5 top summary cards, then a workspace split into a status panel and a control panel, then a log panel. Sources: `tools/remote_mqtt/server/public/index.html:121`, `tools/remote_mqtt/server/public/index.html:159`, `tools/remote_mqtt/server/public/index.html:385`.
- The status panel contains cards inside a panel: `.panel` defines a bordered outer card, and `.status-section` defines inner bordered sections. Sources: `tools/remote_mqtt/server/public/index.html:166`, `tools/remote_mqtt/server/public/index.html:201`.
- The dynamic status renderer always outputs four status groups: network status, communication link, runtime information, and command status. Source: `tools/remote_mqtt/server/public/index.html:726`.
- Repeated-pattern count: at least 3 repeated status affordance layers serve the same status-reading purpose: header pills, summary cards, and status-section chips/rows. Sources: `tools/remote_mqtt/server/public/index.html:498`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:717`.
- Dead prop / unused import count: 0 observed. The page is a single static HTML file with inline CSS/JS and no imports. Sources: `tools/remote_mqtt/server/public/index.html:633`, byte check result: no `src=` or `href=` assets.

## Visual Evidence

- Desktop screenshot shows the page is functional but visually fragmented: 5 summary cards on top, a left status card with 4 nested cards, a right control card with 4 sections, and a separate log card. Screenshot: `/tmp/design-is-remote-dashboard-desktop.png`.
- Mobile screenshot turns the same structure into a long vertical stack: 5 summary cards, status panel, 4 nested status cards, remote control panel, and log panel. Screenshot: `/tmp/design-is-remote-dashboard-mobile.png`.
- Spacing values observed in CSS and computed inspection include `1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 22, 24, 28, 130px`. Sources include `tools/remote_mqtt/server/public/index.html:40`, `tools/remote_mqtt/server/public/index.html:48`, `tools/remote_mqtt/server/public/index.html:88`, `tools/remote_mqtt/server/public/index.html:124`, `tools/remote_mqtt/server/public/index.html:178`, `tools/remote_mqtt/server/public/index.html:218`, `tools/remote_mqtt/server/public/index.html:323`.
- Type scale observed: `12, 13, 14, 16, 17, 20, 26px`. Sources: `tools/remote_mqtt/server/public/index.html:53`, `tools/remote_mqtt/server/public/index.html:65`, `tools/remote_mqtt/server/public/index.html:72`, `tools/remote_mqtt/server/public/index.html:146`, `tools/remote_mqtt/server/public/index.html:183`, `tools/remote_mqtt/server/public/index.html:326`, `tools/remote_mqtt/server/public/index.html:398`.
- Distinct rendered/referenced color count observed: 21. Core tokens are declared at `tools/remote_mqtt/server/public/index.html:8`; additional one-off colors appear in chips, buttons, and log styles at `tools/remote_mqtt/server/public/index.html:102`, `tools/remote_mqtt/server/public/index.html:109`, `tools/remote_mqtt/server/public/index.html:251`, `tools/remote_mqtt/server/public/index.html:395`, `tools/remote_mqtt/server/public/index.html:423`.
- Border radii observed: `7px`, `8px`, and `999px`. Sources: `tools/remote_mqtt/server/public/index.html:90`, `tools/remote_mqtt/server/public/index.html:132`, `tools/remote_mqtt/server/public/index.html:247`, `tools/remote_mqtt/server/public/index.html:324`.
- Contrast checks: body text on page background is 14.62:1; subtitle text is 4.42:1; summary note text is 4.97:1; warning chip text is 4.41:1; OK chip text is 4.13:1; primary/secondary button text is 6.77:1; log text is 12.04:1. The green and amber status chips fall below 4.5:1 for normal-size text. Sources: chip colors at `tools/remote_mqtt/server/public/index.html:255` and `tools/remote_mqtt/server/public/index.html:261`.
- State checklist:
  - Empty: present for command log. Source: `tools/remote_mqtt/server/public/index.html:797`.
  - Loading/busy: present as text replacement `下发中...`, but not visually designed beyond button label mutation. Source: `tools/remote_mqtt/server/public/index.html:764`.
  - Error: present in command log and initialization catch. Sources: `tools/remote_mqtt/server/public/index.html:869`, `tools/remote_mqtt/server/public/index.html:902`.
  - Success: present through ACK log and state chips. Sources: `tools/remote_mqtt/server/public/index.html:820`, `tools/remote_mqtt/server/public/index.html:802`.
  - Focus: no explicit `:focus` or `:focus-visible` style in CSS. CSS controls are defined at `tools/remote_mqtt/server/public/index.html:321`, button states at `tools/remote_mqtt/server/public/index.html:347`.
  - Disabled: present through `disabled` style and JS enablement. Sources: `tools/remote_mqtt/server/public/index.html:380`, `tools/remote_mqtt/server/public/index.html:757`.

## Copy And Honesty Evidence

- Static strings include the page title and header copy: `远程设备控制台`, `Wireless Debug Remote`, and `面向调试终端的在线状态监控、MQTT 远程控制和命令回执追踪。` Sources: `tools/remote_mqtt/server/public/index.html:6`, `tools/remote_mqtt/server/public/index.html:494`, `tools/remote_mqtt/server/public/index.html:496`.
- Header status strings: `设备离线`, `Broker 未连接`. Source: `tools/remote_mqtt/server/public/index.html:499`.
- Summary-card strings: `设备`, `当前管理对象`, `运行状态`, `等待设备心跳`, `最近心跳`, `15 秒内视为在线`, `网络模式`, `STA 未连接`, `STA IP`, `热点或路由器分配`. Sources: `tools/remote_mqtt/server/public/index.html:506`, `tools/remote_mqtt/server/public/index.html:508`, `tools/remote_mqtt/server/public/index.html:511`, `tools/remote_mqtt/server/public/index.html:513`, `tools/remote_mqtt/server/public/index.html:516`, `tools/remote_mqtt/server/public/index.html:518`, `tools/remote_mqtt/server/public/index.html:521`, `tools/remote_mqtt/server/public/index.html:523`, `tools/remote_mqtt/server/public/index.html:526`, `tools/remote_mqtt/server/public/index.html:528`.
- Status panel strings: `状态总览`, `设备每 5 秒上报一次状态；页面通过 SSE 实时刷新。`, `刷新状态`. Sources: `tools/remote_mqtt/server/public/index.html:536`, `tools/remote_mqtt/server/public/index.html:537`, `tools/remote_mqtt/server/public/index.html:539`.
- Control strings: `远程控制`, `设备离线时控制项会自动锁定；命令下发后等待 ACK 确认。`, `网络模式`, `AP / STA / APSTA`, `WiFi 模式`, `AP 模式`, `STA 模式`, `APSTA 模式`, `应用模式`, `串口参数`, `UART Baud`, `波特率`, `应用波特率`, `通信链路`, `自动 / WiFi / BLE`, `通信模式`, `自动选择`, `仅 WiFi`, `仅 BLE`, `应用链路`, `启动 BLE 广播`, `OLED 显示`, `远程显示测试`, `显示文本`, `Remote MQTT OK`, `发送到 OLED`. Sources: `tools/remote_mqtt/server/public/index.html:547`, `tools/remote_mqtt/server/public/index.html:548`, `tools/remote_mqtt/server/public/index.html:554`, `tools/remote_mqtt/server/public/index.html:555`, `tools/remote_mqtt/server/public/index.html:559`, `tools/remote_mqtt/server/public/index.html:561`, `tools/remote_mqtt/server/public/index.html:562`, `tools/remote_mqtt/server/public/index.html:563`, `tools/remote_mqtt/server/public/index.html:566`, `tools/remote_mqtt/server/public/index.html:572`, `tools/remote_mqtt/server/public/index.html:573`, `tools/remote_mqtt/server/public/index.html:577`, `tools/remote_mqtt/server/public/index.html:585`, `tools/remote_mqtt/server/public/index.html:591`, `tools/remote_mqtt/server/public/index.html:592`, `tools/remote_mqtt/server/public/index.html:596`, `tools/remote_mqtt/server/public/index.html:598`, `tools/remote_mqtt/server/public/index.html:599`, `tools/remote_mqtt/server/public/index.html:600`, `tools/remote_mqtt/server/public/index.html:603`, `tools/remote_mqtt/server/public/index.html:605`, `tools/remote_mqtt/server/public/index.html:610`, `tools/remote_mqtt/server/public/index.html:611`, `tools/remote_mqtt/server/public/index.html:613`, `tools/remote_mqtt/server/public/index.html:614`, `tools/remote_mqtt/server/public/index.html:615`.
- Log strings: `命令日志`, `记录远程命令、等待确认和设备 ACK，便于现场复盘。`, `清空日志`, `暂无命令日志。发送命令后会在这里显示等待确认和 ACK 结果。`. Sources: `tools/remote_mqtt/server/public/index.html:624`, `tools/remote_mqtt/server/public/index.html:625`, `tools/remote_mqtt/server/public/index.html:627`, `tools/remote_mqtt/server/public/index.html:799`.
- Dynamic strings include command names, network mode names, communication mode names, online/offline states, and ACK/failure messages. Sources: `tools/remote_mqtt/server/public/index.html:639`, `tools/remote_mqtt/server/public/index.html:647`, `tools/remote_mqtt/server/public/index.html:648`, `tools/remote_mqtt/server/public/index.html:696`, `tools/remote_mqtt/server/public/index.html:719`, `tools/remote_mqtt/server/public/index.html:820`, `tools/remote_mqtt/server/public/index.html:860`, `tools/remote_mqtt/server/public/index.html:866`.
- Inflations: none observed. The page does not make marketing claims beyond its implemented monitoring/control purpose.
- Dark patterns: none observed.
- Jargon / unclear labels: `Broker`, `SSE`, `ACK`, `AP / STA / APSTA`, `UART Baud`, `BLE`, `WebSocket`, and `STA 配置` are useful to engineers but unexplained for a first-time field operator. Sources: `tools/remote_mqtt/server/public/index.html:500`, `tools/remote_mqtt/server/public/index.html:537`, `tools/remote_mqtt/server/public/index.html:548`, `tools/remote_mqtt/server/public/index.html:555`, `tools/remote_mqtt/server/public/index.html:573`, `tools/remote_mqtt/server/public/index.html:605`, `tools/remote_mqtt/server/public/index.html:740`, `tools/remote_mqtt/server/public/index.html:745`.
- Label-to-behavior mismatches: none confirmed.

## Weight And Friction Evidence

- Initial page file size: 26,929 bytes.
- Inline JavaScript size: 11,165 bytes.
- Inline CSS size: 9,416 bytes.
- Network request count for the primary view: 3 (`/`, `/api/devices/esp32-001/status`, `/events`).
- Time to interactive: approximately 859ms from Playwright measurement on the local page.
- Idle animation count: 0.
- Notification / badge / modal count on initial load: 2 status badges, 0 modals.
- The page explicitly sets `color-scheme: light`, so user dark-mode preference is not honored. Source: `tools/remote_mqtt/server/public/index.html:9`.

## Accessibility Evidence

- ARIA/semantic landmark count observed: 16. Sources include `main`, `header`, `section`, `article`, `aside`, `role="log"`, and `aria-live="polite"` at `tools/remote_mqtt/server/public/index.html:491`, `tools/remote_mqtt/server/public/index.html:492`, `tools/remote_mqtt/server/public/index.html:504`, `tools/remote_mqtt/server/public/index.html:533`, `tools/remote_mqtt/server/public/index.html:544`, `tools/remote_mqtt/server/public/index.html:621`, `tools/remote_mqtt/server/public/index.html:629`.
- Skip link: absent. No skip-link markup or style found.
- Focus order follows DOM order: refresh, WiFi mode, apply mode, UART baud, apply baud, communication mode, apply link, start BLE, OLED text, send OLED, clear log.
- Keyboard reachability: all 11 primary controls are reachable by Tab in the live page.
- Contrast pass/fail:
  - Body text: pass, 14.62:1.
  - Subtitle: marginal fail for normal text, 4.42:1.
  - Summary note / panel description: pass, 4.97:1.
  - OK chip: fail for normal text, 4.13:1.
  - Warning chip: fail for normal text, 4.41:1.
  - Button text: pass, 6.77:1.
  - Log text: pass, 12.04:1.
