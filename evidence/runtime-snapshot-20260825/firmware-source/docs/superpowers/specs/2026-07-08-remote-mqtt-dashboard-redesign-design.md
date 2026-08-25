# Remote MQTT Dashboard Redesign Design

## Goal

Redesign the remote MQTT dashboard so it reads like a professional operations console while preserving the existing local MQTT control behavior.

## Approved Direction

Use one compact device-state strip, one detailed status table, one command panel, and one command log. Remove duplicated summary cards and nested status cards.

## Interface

- Header: Chinese-first title and concise page purpose.
- Device-state strip: online state, MQTT broker state, network mode, AP IP, STA IP, latest heartbeat.
- Status detail: table-like rows grouped by network, communication, runtime, and command status.
- Command panel: WiFi mode, UART baud, communication mode, BLE broadcast, OLED text, refresh status.
- Log: command pending, success, and failure records.

## Copy Rules

- Use Chinese-first labels.
- Keep technical abbreviations as secondary labels where they are useful: MQTT Broker, AP, STA, APSTA, UART, BLE, WebSocket, SSE, ACK.
- Avoid marketing copy and demo-looking English hero labels.

## Visual Rules

- No nested cards.
- Use a compact console layout with clear hierarchy and limited semantic colors.
- Include explicit `:focus-visible`, disabled, pending, empty, success, and error states.
- Honor dark-mode color scheme.

## Testing

- Static regression must prove the new information architecture exists and old summary/nested-card structure is removed.
- Playwright screenshots must confirm desktop/mobile layout has no horizontal overflow and all controls remain reachable.
