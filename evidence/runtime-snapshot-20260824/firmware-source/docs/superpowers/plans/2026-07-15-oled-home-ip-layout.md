# OLED Home IP Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render AP and STA labels on separate OLED home-screen rows, with each IPv4 address on the following row.

**Architecture:** Keep the existing four `s_rows` labels for menus and overlays, and add two home-only labels so APSTA mode can use six rows. A small home-row accessor maps indices 0-3 to existing labels and 4-5 to the extra labels; standard and overlay layouts hide the extras.

**Tech Stack:** ESP-IDF 6.0, LVGL, C, Node.js source-level regression scripts.

## Global Constraints

- Display remains 128x64 SSD1315 on the existing pins and I2C configuration.
- APSTA home uses six status rows; AP and STA homes use five.
- Menu pages remain four rows with unchanged footer and button behavior.
- Home rows must not overlap the footer at y=56.
- Existing `OK`/`TRY`/`OFF`, invalid-IP fallback, UART, and BLE behavior remains unchanged.

---

### Task 1: Lock the Six-Row Home Contract

**Files:**
- Modify: `scripts/oled_wifi_status_regression.mjs`
- Test: `scripts/oled_wifi_status_regression.mjs`

**Interfaces:**
- Consumes: `main/display_ui.c` as source text.
- Produces: assertions requiring six home rows and the approved AP, STA, and APSTA text assignments.

- [ ] **Step 1: Replace old compact-row assertions with the approved layout assertions**

Add these assertions:

```js
assert.ok(displayUi.includes('#define HOME_ROW_COUNT  6'));
assert.ok(displayUi.includes('static lv_obj_t *s_home_extra_rows[2];'));
assert.ok(/case SYSTEM_NET_AP:[\s\S]*?"AP:"[\s\S]*?state->wifi_ap_ip[\s\S]*?"UART:%s"[\s\S]*?"BLE:%s"/.test(closedView[0]));
assert.ok(/case SYSTEM_NET_STA:[\s\S]*?"STA:"[\s\S]*?state->wifi_sta_ip[\s\S]*?"UART:%s"[\s\S]*?"BLE:%s"/.test(closedView[0]));
assert.ok(/case SYSTEM_NET_APSTA:[\s\S]*?"AP:"[\s\S]*?state->wifi_ap_ip[\s\S]*?"STA:"[\s\S]*?state->wifi_sta_ip[\s\S]*?"U:%s BLE:%s"/.test(closedView[0]));
assert.ok(!closedView[0].includes('"AP:%s"'));
```

Also assert that `set_standard_layout` hides both extra labels and `set_home_layout` shows them.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
node scripts/oled_wifi_status_regression.mjs
```

Expected: FAIL because `HOME_ROW_COUNT`, `s_home_extra_rows`, and split AP/STA label rows do not exist.

### Task 2: Implement Home-Only Rows

**Files:**
- Modify: `main/display_ui.c`
- Test: `scripts/oled_wifi_status_regression.mjs`
- Test: `scripts/oled_layout_regression.mjs`

**Interfaces:**
- Consumes: existing `s_rows[SYSTEM_MENU_ROWS]`, `set_standard_layout`, `set_home_layout`, and `update_closed_view`.
- Produces: `home_row(uint8_t index) -> lv_obj_t *` and six-row closed-home rendering.

- [ ] **Step 1: Add home row constants, storage, and accessor**

Add two home-only labels and map six home indices:

```c
#define HOME_ROW_COUNT  6
#define HOME_ROW_STEP   9

static lv_obj_t *s_home_extra_rows[HOME_ROW_COUNT - SYSTEM_MENU_ROWS];

static lv_obj_t *home_row(uint8_t index)
{
    return index < SYSTEM_MENU_ROWS
               ? s_rows[index]
               : s_home_extra_rows[index - SYSTEM_MENU_ROWS];
}
```

- [ ] **Step 2: Separate home and standard visibility**

In `set_home_layout`, show and position all six home rows at `0, 9, 18, 27, 36, 45`. In `set_standard_layout` and the scrolling-overlay path, hide the two extra labels so menus and overlays retain four rows.

```c
for (uint8_t i = 0; i < HOME_ROW_COUNT; i++) {
    lv_obj_t *row = home_row(i);
    lv_obj_remove_flag(row, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_y(row, HOME_ROW_Y + i * HOME_ROW_STEP);
}

for (uint8_t i = 0; i < HOME_ROW_COUNT - SYSTEM_MENU_ROWS; i++) {
    lv_obj_add_flag(s_home_extra_rows[i], LV_OBJ_FLAG_HIDDEN);
}
```

- [ ] **Step 3: Render the approved AP, STA, and APSTA rows**

Use `home_row(0)` through `home_row(5)` in `update_closed_view`. APSTA renders `WiFi`, `AP:`, AP address, `STA:`, STA address, and combined UART/BLE in that order. AP and STA render their label, address, UART, and BLE rows, then clear the unused sixth row with:

```c
lv_label_set_text(home_row(5), " ");
```

- [ ] **Step 4: Create the two labels during UI construction**

Create the extra labels with the same width, font, clipping, and height as existing rows, then hide them initially:

```c
for (uint8_t i = 0; i < HOME_ROW_COUNT - SYSTEM_MENU_ROWS; i++) {
    s_home_extra_rows[i] = make_label(s_root, UI_MARGIN_X, 0, 124, UI_ROW_H, " ");
    lv_obj_add_flag(s_home_extra_rows[i], LV_OBJ_FLAG_HIDDEN);
}
```

- [ ] **Step 5: Run focused regressions and verify GREEN**

Run:

```bash
node scripts/oled_wifi_status_regression.mjs
node scripts/oled_layout_regression.mjs
```

Expected: both commands exit 0 without assertion failures.

### Task 3: Build and Check the Firmware

**Files:**
- Verify: `build/uart_ble_wifi.bin`
- Verify: `build/storage.bin`

**Interfaces:**
- Consumes: updated `main/display_ui.c` and existing ESP-IDF project configuration.
- Produces: flashable ESP32-S3 images.

- [ ] **Step 1: Build with ESP-IDF**

Run:

```bash
cmd.exe /C "cd /D D:\\Users\\sunqi39\\Desktop\\wireless_debug-main\\build && C:\\Espressif\\tools\\ninja\\1.12.1\\ninja.EXE -j8"
```

Expected: Ninja exits 0; application and bootloader partition size checks pass.

- [ ] **Step 2: Inspect the final diff and artifact timestamps**

Run:

```bash
git diff --check -- main/display_ui.c scripts/oled_wifi_status_regression.mjs
stat -c '%y %s %n' build/uart_ble_wifi.bin build/storage.bin
```

Expected: no whitespace errors and freshly built artifacts.

- [ ] **Step 3: Commit only the OLED implementation**

Run:

```bash
git add main/display_ui.c scripts/oled_wifi_status_regression.mjs
git commit -m "Improve OLED home IP layout"
```

Expected: the existing unrelated `main/main.c` and generated web asset changes remain unstaged.
