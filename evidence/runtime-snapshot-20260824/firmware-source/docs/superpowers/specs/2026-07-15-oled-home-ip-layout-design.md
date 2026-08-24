# OLED Home IP Layout Design

## Goal

Use the two currently unused OLED home-screen rows to place AP and STA labels on
their own lines, with each IPv4 address shown on the following line. Keep the
128x64 display readable without changing menu behavior.

## Home Layouts

APSTA mode uses six status rows plus the existing footer:

```text
WiFi:APSTA OK
AP:
192.168.4.1
STA:
10.162.92.4
U:2M BLE:ON
S5 MENU
```

AP mode uses five status rows:

```text
WiFi:AP
AP:
192.168.4.1
UART:2M
BLE:ON
S5 MENU
```

STA mode uses five status rows:

```text
WiFi:STA OK
STA:
10.162.92.4
UART:2M
BLE:ON
S5 MENU
```

Unavailable STA addresses continue to render as `-`, and the existing
`OK`/`TRY`/`OFF` connection status remains unchanged.

## Implementation Boundary

- Add two labels used only by the closed home view.
- Position six home rows above the existing footer without overlap.
- Hide the extra labels in menu and overlay views.
- Keep the existing four-row menu layout, footer text, button behavior, fonts,
  and display hardware configuration unchanged.

## Verification

- Build the ESP-IDF project successfully.
- Verify AP, STA, and APSTA text assignment in a focused host-side regression or
  equivalent source-level test.
- After flashing, inspect the physical SSD1315 OLED for clipping or overlap.
