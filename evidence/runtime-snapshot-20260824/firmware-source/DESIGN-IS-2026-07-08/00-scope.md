# Design Audit Scope

Date: 2026-07-08

## Audited Surface

- Live URL: `http://127.0.0.1:3000`
- Source file: `tools/remote_mqtt/server/public/index.html`
- Screenshots:
  - Desktop: `/tmp/design-is-remote-dashboard-desktop.png`
  - Mobile: `/tmp/design-is-remote-dashboard-mobile.png`

## Primary User

Engineer, field support, or operator who needs to inspect one ESP32 wireless debug terminal remotely and issue low-risk MQTT commands.

## Primary Task

Confirm device/broker/network status quickly, then safely send remote configuration/control commands and verify ACK results.

## Constraints

- Existing stack is a simple Express static page with inline CSS and JavaScript.
- Keep the UI Chinese-first; technical abbreviations such as MQTT, AP, STA, APSTA, BLE, UART, ACK, and IP are acceptable when useful.
- Do not introduce a frontend framework unless the redesign clearly needs one.
- The page must stay useful for local development now and later cloud deployment.
- Current implementation should preserve working MQTT command behavior.

## Reference Standard

Audit against Dieter Rams' ten principles using the shipped page, not intended future behavior.
