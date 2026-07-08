# True WiFi Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement OLED-controlled real AP, STA, and APSTA WiFi workflows with STA/APSTA child actions for Quick Connect and Web Setup.

**Architecture:** Extend the current `system_menu` state model from two network modes to three selected modes, then make `ui_controller` pass a target WiFi mode into scan/connect/setup actions. `wifi_manager` owns the real ESP-IDF driver mode and a provisioning target; OLED and web actions call narrow manager APIs instead of directly guessing whether AP should stay open.

**Tech Stack:** ESP-IDF 6.0, ESP32-S3, FreeRTOS, ESP WiFi, ESP HTTP server, LVGL OLED UI, Node.js source-regression scripts.

## Global Constraints

- Workspace path: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main`.
- Build from WSL with `cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"`.
- OLED hardware remains SSD1315, SCL GPIO19, SDA GPIO20, I2C address `0x3C`.
- The default boot mode remains APSTA.
- The Network menu shows AP Mode, STA Mode, and APSTA Mode as the only top-level mode items.
- AP Mode has no child workflow and selecting it immediately switches to true AP mode.
- STA Mode child page has exactly `Quick Connect` and `Web Setup`.
- APSTA Mode child page has exactly `Quick Connect` and `Web Setup`.
- STA Quick Connect succeeds into true STA and closes AP.
- STA Web Setup temporarily keeps or enters APSTA, then switches to true STA and closes AP after STA connection succeeds.
- APSTA Quick Connect and APSTA Web Setup keep the device in true APSTA after connection.
- WiFi scan keeps `WIFI_MANAGER_SCAN_HOME_DWELL_MS 150`.
- The firmware must not fall back from STA to AP automatically unless a future user setting explicitly enables that behavior.
- Existing dirty worktree changes may include `main/display_ui.c` and `scripts/oled_layout_regression.mjs`; do not revert or overwrite them.

---

## File Structure

- `main/system_menu.h`: Add `SYSTEM_NET_APSTA` and distinct actions for STA/APSTA quick/web workflows.
- `main/system_menu.c`: Own menu hierarchy and display labels: Network top-level has AP/STA/APSTA; STA and APSTA pages each have Quick Connect and Web Setup.
- `main/wifi_manager.h`: Add explicit APIs for selected mode, provisioning target, quick connect target, and web setup target.
- `main/wifi_manager.c`: Implement true `WIFI_MODE_AP`, `WIFI_MODE_STA`, and `WIFI_MODE_APSTA`; remove STA timeout fallback to AP; route connect success to STA or APSTA based on requested target.
- `main/ui_controller.h`: Replace mode-blind WiFi callbacks with target-aware quick connect and web setup callbacks.
- `main/ui_controller.c`: Apply menu actions and OLED messages for target-aware STA/APSTA workflows.
- `main/main.c`: Wire the new callbacks, update UART commands and status output to understand APSTA.
- `main/web_api.h`: Add target-mode hooks used by `/api/wifi/connect` and `/api/wifi/mode`.
- `main/web_api.c`: Expose `ap`, `sta`, and `apsta`; ensure browser-initiated connect converges according to current web setup target.
- `scripts/wifi_true_modes_regression.mjs`: New source regression for enum/actions/menu hierarchy/driver modes.
- `scripts/wifi_provisioning_target_regression.mjs`: New source regression for STA/APSTA quick/web setup convergence behavior.

---

### Task 1: Add Three-Mode Menu Model

**Files:**
- Modify: `main/system_menu.h`
- Modify: `main/system_menu.c`
- Create: `scripts/wifi_true_modes_regression.mjs`

**Interfaces:**
- Consumes: Existing `system_net_mode_t`, `system_menu_action_t`, `system_menu_get_snapshot()`, and menu key handling.
- Produces:
  - `SYSTEM_NET_AP`, `SYSTEM_NET_STA`, `SYSTEM_NET_APSTA`
  - `SYSTEM_ACTION_NET_AP`
  - `SYSTEM_ACTION_NET_STA_QUICK`
  - `SYSTEM_ACTION_NET_STA_WEB_SETUP`
  - `SYSTEM_ACTION_NET_STA_QUICK_CONNECT`
  - `SYSTEM_ACTION_NET_APSTA_QUICK`
  - `SYSTEM_ACTION_NET_APSTA_WEB_SETUP`
  - `SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT`
  - `const char *system_menu_net_name(system_net_mode_t mode)` returning `AP`, `STA`, or `APSTA`

- [ ] **Step 1: Write the failing regression script**

Create `scripts/wifi_true_modes_regression.mjs`:

```js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const header = readFileSync(resolve(process.cwd(), 'main/system_menu.h'), 'utf8');
const menu = readFileSync(resolve(process.cwd(), 'main/system_menu.c'), 'utf8');

assert.ok(
  /typedef enum \{[\s\S]*?SYSTEM_NET_AP,[\s\S]*?SYSTEM_NET_STA,[\s\S]*?SYSTEM_NET_APSTA,[\s\S]*?\} system_net_mode_t;/.test(header),
  'system_net_mode_t must expose AP, STA, and APSTA',
);

for (const action of [
  'SYSTEM_ACTION_NET_AP',
  'SYSTEM_ACTION_NET_STA_QUICK',
  'SYSTEM_ACTION_NET_STA_WEB_SETUP',
  'SYSTEM_ACTION_NET_STA_QUICK_CONNECT',
  'SYSTEM_ACTION_NET_APSTA_QUICK',
  'SYSTEM_ACTION_NET_APSTA_WEB_SETUP',
  'SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT',
]) {
  assert.ok(header.includes(action), `missing menu action ${action}`);
}

assert.ok(
  /typedef enum \{[\s\S]*?NET_ITEM_AP,[\s\S]*?NET_ITEM_STA,[\s\S]*?NET_ITEM_APSTA,[\s\S]*?NET_ITEM_COUNT,[\s\S]*?\} network_item_t;/.test(menu),
  'Network page must contain exactly AP, STA, and APSTA items',
);

assert.ok(
  /typedef enum \{[\s\S]*?STA_ITEM_QUICK,[\s\S]*?STA_ITEM_WEB_SETUP,[\s\S]*?STA_ITEM_COUNT,[\s\S]*?\} sta_item_t;/.test(menu),
  'STA page must contain exactly Quick Connect and Web Setup',
);

assert.ok(
  /typedef enum \{[\s\S]*?APSTA_ITEM_QUICK,[\s\S]*?APSTA_ITEM_WEB_SETUP,[\s\S]*?APSTA_ITEM_COUNT,[\s\S]*?\} apsta_item_t;/.test(menu),
  'APSTA page must contain exactly Quick Connect and Web Setup',
);

for (const label of ['AP Mode', 'STA Mode', 'APSTA Mode', 'Quick Connect', 'Web Setup']) {
  assert.ok(menu.includes(label), `OLED menu label missing: ${label}`);
}

assert.ok(
  /case SYSTEM_NET_APSTA:\s*return "APSTA";/.test(menu),
  'system_menu_net_name must render APSTA',
);
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/wifi_true_modes_regression.mjs
```

Expected: FAIL because `SYSTEM_NET_APSTA`, APSTA actions, and APSTA menu page do not exist yet.

- [ ] **Step 3: Update `system_menu.h` enums**

Change `system_net_mode_t` to:

```c
typedef enum {
    SYSTEM_NET_AP,
    SYSTEM_NET_STA,
    SYSTEM_NET_APSTA,
} system_net_mode_t;
```

Change the network action block in `system_menu_action_t` to:

```c
typedef enum {
    SYSTEM_ACTION_NONE,
    SYSTEM_ACTION_NET_AP,
    SYSTEM_ACTION_NET_STA_QUICK,
    SYSTEM_ACTION_NET_STA_WEB_SETUP,
    SYSTEM_ACTION_NET_STA_QUICK_CONNECT,
    SYSTEM_ACTION_NET_APSTA_QUICK,
    SYSTEM_ACTION_NET_APSTA_WEB_SETUP,
    SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT,
    SYSTEM_ACTION_NET_STA_CLEAR,
    SYSTEM_ACTION_COMM_AUTO,
```

Do not keep `SYSTEM_ACTION_NET_STA` unless a compile error shows a remaining legitimate direct-STA caller. Direct STA mode selection is represented by choosing a target child action, not by a top-level direct switch.

- [ ] **Step 4: Update page enums and counts in `system_menu.c`**

Change `menu_page_t` to include APSTA:

```c
typedef enum {
    MENU_PAGE_ROOT,
    MENU_PAGE_NETWORK,
    MENU_PAGE_STA,
    MENU_PAGE_APSTA,
    MENU_PAGE_WIFI_LIST,
    MENU_PAGE_COMM,
    MENU_PAGE_UART,
    MENU_PAGE_MORE,
    MENU_PAGE_BLE,
    MENU_PAGE_DISPLAY,
    MENU_PAGE_SYSTEM,
    MENU_PAGE_COUNT,
} menu_page_t;
```

Change network and child item enums:

```c
typedef enum {
    NET_ITEM_AP,
    NET_ITEM_STA,
    NET_ITEM_APSTA,
    NET_ITEM_COUNT,
} network_item_t;

typedef enum {
    STA_ITEM_QUICK,
    STA_ITEM_WEB_SETUP,
    STA_ITEM_COUNT,
} sta_item_t;

typedef enum {
    APSTA_ITEM_QUICK,
    APSTA_ITEM_WEB_SETUP,
    APSTA_ITEM_COUNT,
} apsta_item_t;
```

Update `item_count_for_page()` so:

```c
case MENU_PAGE_NETWORK:
    return NET_ITEM_COUNT;
case MENU_PAGE_STA:
    return STA_ITEM_COUNT;
case MENU_PAGE_APSTA:
    return APSTA_ITEM_COUNT;
```

- [ ] **Step 5: Update page navigation**

Update `parent_page()`:

```c
case MENU_PAGE_WIFI_LIST:
    return s_menu.net_mode == SYSTEM_NET_APSTA ? MENU_PAGE_APSTA : MENU_PAGE_STA;
case MENU_PAGE_STA:
case MENU_PAGE_APSTA:
    return MENU_PAGE_NETWORK;
```

Update `system_menu_handle_key()` for OK on the Network page:

```c
} else if (s_menu.page == MENU_PAGE_NETWORK &&
           s_menu.selected[MENU_PAGE_NETWORK] == NET_ITEM_STA) {
    s_menu.page = MENU_PAGE_STA;
    set_message_locked("-");
} else if (s_menu.page == MENU_PAGE_NETWORK &&
           s_menu.selected[MENU_PAGE_NETWORK] == NET_ITEM_APSTA) {
    s_menu.page = MENU_PAGE_APSTA;
    set_message_locked("-");
} else if (s_menu.page == MENU_PAGE_MORE) {
```

Leave `NET_ITEM_AP` as an action through `action_for_selected_locked()`.

- [ ] **Step 6: Update labels, titles, paths, and actions**

In `page_item_label()` use these exact labels:

```c
case MENU_PAGE_NETWORK:
    if (index == NET_ITEM_AP) {
        snprintf(label, label_size, "AP Mode");
        snprintf(value, value_size, "%s", s_menu.net_mode == SYSTEM_NET_AP ? "ON" : "");
    } else if (index == NET_ITEM_STA) {
        snprintf(label, label_size, "STA Mode");
        snprintf(value, value_size, "%s", s_menu.net_mode == SYSTEM_NET_STA ? "ON" : ">");
    } else {
        snprintf(label, label_size, "APSTA Mode");
        snprintf(value, value_size, "%s", s_menu.net_mode == SYSTEM_NET_APSTA ? "ON" : ">");
    }
    break;
case MENU_PAGE_STA:
    if (index == STA_ITEM_QUICK) {
        snprintf(label, label_size, "Quick Connect");
    } else {
        snprintf(label, label_size, "Web Setup");
    }
    break;
case MENU_PAGE_APSTA:
    if (index == APSTA_ITEM_QUICK) {
        snprintf(label, label_size, "Quick Connect");
    } else {
        snprintf(label, label_size, "Web Setup");
    }
    break;
```

Update `page_title()` and `page_path()`:

```c
case MENU_PAGE_STA:
    return "STA MODE";
case MENU_PAGE_APSTA:
    return "APSTA MODE";
```

```c
case MENU_PAGE_STA:
    return "MENU/STA";
case MENU_PAGE_APSTA:
    return "MENU/APSTA";
```

Update `action_for_selected_locked()`:

```c
case MENU_PAGE_NETWORK:
    if (selected == NET_ITEM_AP) return SYSTEM_ACTION_NET_AP;
    return SYSTEM_ACTION_NONE;
case MENU_PAGE_STA:
    if (selected == STA_ITEM_QUICK) return SYSTEM_ACTION_NET_STA_QUICK;
    return SYSTEM_ACTION_NET_STA_WEB_SETUP;
case MENU_PAGE_APSTA:
    if (selected == APSTA_ITEM_QUICK) return SYSTEM_ACTION_NET_APSTA_QUICK;
    return SYSTEM_ACTION_NET_APSTA_WEB_SETUP;
case MENU_PAGE_WIFI_LIST:
    return s_menu.net_mode == SYSTEM_NET_APSTA ?
           SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT :
           SYSTEM_ACTION_NET_STA_QUICK_CONNECT;
```

- [ ] **Step 7: Update action names/titles and net name**

Update `system_menu_action_name()` with:

```c
case SYSTEM_ACTION_NET_AP:
    return "net_ap";
case SYSTEM_ACTION_NET_STA_QUICK:
    return "net_sta_quick";
case SYSTEM_ACTION_NET_STA_WEB_SETUP:
    return "net_sta_web_setup";
case SYSTEM_ACTION_NET_STA_QUICK_CONNECT:
    return "net_sta_quick_connect";
case SYSTEM_ACTION_NET_APSTA_QUICK:
    return "net_apsta_quick";
case SYSTEM_ACTION_NET_APSTA_WEB_SETUP:
    return "net_apsta_web_setup";
case SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT:
    return "net_apsta_quick_connect";
case SYSTEM_ACTION_NET_STA_CLEAR:
    return "net_sta_clear";
```

Update `system_menu_action_title()` with:

```c
case SYSTEM_ACTION_NET_AP:
    return "WIFI AP";
case SYSTEM_ACTION_NET_STA_QUICK:
    return "STA QUICK";
case SYSTEM_ACTION_NET_STA_WEB_SETUP:
    return "STA WEB";
case SYSTEM_ACTION_NET_STA_QUICK_CONNECT:
    return "STA CONNECT";
case SYSTEM_ACTION_NET_APSTA_QUICK:
    return "APSTA QUICK";
case SYSTEM_ACTION_NET_APSTA_WEB_SETUP:
    return "APSTA WEB";
case SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT:
    return "APSTA CONNECT";
case SYSTEM_ACTION_NET_STA_CLEAR:
    return "CLEAR STA";
```

Update `system_menu_net_name()`:

```c
const char *system_menu_net_name(system_net_mode_t mode)
{
    switch (mode) {
    case SYSTEM_NET_STA:
        return "STA";
    case SYSTEM_NET_APSTA:
        return "APSTA";
    case SYSTEM_NET_AP:
    default:
        return "AP";
    }
}
```

- [ ] **Step 8: Run menu regression**

Run:

```bash
node scripts/wifi_true_modes_regression.mjs
```

Expected: PASS.

- [ ] **Step 9: Build-check compile errors from enum changes**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: compile may FAIL in `wifi_manager.c`, `ui_controller.c`, `web_api.c`, or `main.c` because later tasks have not updated callers. Record the first missing symbol/location, but do not patch those files in this task except to remove obsolete `SYSTEM_ACTION_NET_STA` references if the compiler requires it for menu-only compilation.

- [ ] **Step 10: Commit**

If the Node regression passes and any build failure is only expected cross-module enum fallout, commit:

```bash
git add main/system_menu.h main/system_menu.c scripts/wifi_true_modes_regression.mjs
git commit -m "Add true WiFi mode menu model"
```

---

### Task 2: Add Target-Aware WiFi Manager Modes

**Files:**
- Modify: `main/wifi_manager.h`
- Modify: `main/wifi_manager.c`
- Create: `scripts/wifi_provisioning_target_regression.mjs`

**Interfaces:**
- Consumes: `system_net_mode_t` now includes `SYSTEM_NET_APSTA`.
- Produces:
  - `esp_err_t wifi_manager_begin_web_setup(system_net_mode_t target_mode);`
  - `esp_err_t wifi_manager_quick_connect_for_mode(const char *ssid, system_net_mode_t target_mode);`
  - `esp_err_t wifi_manager_connect_sta_for_mode(const char *ssid, const char *password, bool save_on_success, system_net_mode_t target_mode);`
  - `esp_err_t wifi_manager_schedule_connect_sta_for_mode(const char *ssid, const char *password, bool save_on_success, system_net_mode_t target_mode, uint32_t delay_ms);`
  - `wifi_manager_status_t.selected_mode` is not added; keep `status.mode` as selected mode.

- [ ] **Step 1: Write the failing provisioning regression**

Create `scripts/wifi_provisioning_target_regression.mjs`:

```js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const header = readFileSync(resolve(process.cwd(), 'main/wifi_manager.h'), 'utf8');
const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

for (const api of [
  'wifi_manager_begin_web_setup',
  'wifi_manager_quick_connect_for_mode',
  'wifi_manager_connect_sta_for_mode',
  'wifi_manager_schedule_connect_sta_for_mode',
]) {
  assert.ok(header.includes(api), `wifi_manager.h missing ${api}`);
  assert.ok(source.includes(api), `wifi_manager.c missing ${api}`);
}

assert.ok(source.includes('static system_net_mode_t s_connect_target_mode = SYSTEM_NET_APSTA;'),
  'wifi_manager must track the target mode for pending STA connects');

assert.ok(
  /static esp_err_t start_apsta_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_APSTA\)/.test(source),
  'wifi_manager must have a true APSTA starter',
);

assert.ok(
  /static esp_err_t start_sta_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_STA\)/.test(source),
  'STA mode must use true WIFI_MODE_STA',
);

assert.ok(
  /static esp_err_t start_ap_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_AP\)/.test(source),
  'AP mode must use true WIFI_MODE_AP',
);

assert.ok(
  /sta_fallback_timer_cb[\s\S]*?report_message\("STA RETRY"\)/.test(source),
  'STA timeout must report retry instead of falling back to AP',
);

assert.ok(!source.includes('falling back to AP'),
  'wifi_manager must not describe STA timeout as falling back to AP');

assert.ok(
  /IP_EVENT_STA_GOT_IP[\s\S]*?if \(target_mode == SYSTEM_NET_STA\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_STA\)/.test(source),
  'STA-target connect success must close AP by switching to WIFI_MODE_STA',
);
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/wifi_provisioning_target_regression.mjs
```

Expected: FAIL because the new APIs and true AP/APSTA/STA split do not exist.

- [ ] **Step 3: Add manager API declarations**

In `main/wifi_manager.h`, keep existing APIs for compatibility and add:

```c
esp_err_t wifi_manager_connect_sta_for_mode(const char *ssid, const char *password,
                                            bool save_on_success,
                                            system_net_mode_t target_mode);
esp_err_t wifi_manager_schedule_connect_sta_for_mode(const char *ssid,
                                                     const char *password,
                                                     bool save_on_success,
                                                     system_net_mode_t target_mode,
                                                     uint32_t delay_ms);
esp_err_t wifi_manager_quick_connect_for_mode(const char *ssid,
                                              system_net_mode_t target_mode);
esp_err_t wifi_manager_begin_web_setup(system_net_mode_t target_mode);
```

- [ ] **Step 4: Add target state to `wifi_manager.c`**

Near the other static state add:

```c
static system_net_mode_t s_connect_target_mode = SYSTEM_NET_APSTA;
static system_net_mode_t s_web_setup_target_mode = SYSTEM_NET_APSTA;
```

Extend `clear_pending_save_locked()`:

```c
s_connect_target_mode = s_net_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA;
```

- [ ] **Step 5: Split AP, APSTA, and STA starters**

Update `start_ap_locked()` so it is true AP:

```c
static esp_err_t start_ap_locked(void)
{
    esp_timer_stop(s_sta_fallback_timer);
    set_ap_state_locked();

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_AP);
    if (ret != ESP_OK) {
        return ret;
    }

    wifi_config_t ap_config = {
        .ap = {
            .ssid_len = 0,
            .channel = WIFI_MANAGER_CHANNEL,
            .password = WIFI_MANAGER_PASS,
            .max_connection = WIFI_MANAGER_MAX_STA_CONN,
            .authmode = WIFI_AUTH_WPA_WPA2_PSK,
            .pmf_cfg = {
                .required = false,
            },
        },
    };
    strlcpy((char *)ap_config.ap.ssid, s_ap_ssid, sizeof(ap_config.ap.ssid));
    ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
    if (ret != ESP_OK) {
        return ret;
    }
    if (!s_driver_started) {
        ret = esp_wifi_start();
        if (ret != ESP_OK) {
            return ret;
        }
        s_driver_started = true;
    } else {
        esp_err_t disconnect_ret = esp_wifi_disconnect();
        if (disconnect_ret != ESP_OK && disconnect_ret != ESP_ERR_WIFI_NOT_CONNECT) {
            ESP_LOGW(TAG, "STA disconnect while switching to AP failed: %s",
                     esp_err_to_name(disconnect_ret));
        }
    }

    report_net_mode(SYSTEM_NET_AP);
    report_message("AP MODE READY");
    report_wifi_label(s_ap_ssid);
    report_status("ap_on");
    ESP_LOGI(TAG, "WiFi AP active: SSID=%s Web=http://192.168.4.1", s_ap_ssid);
    return ESP_OK;
}
```

Add `start_apsta_locked()`:

```c
static esp_err_t start_apsta_locked(void)
{
    esp_timer_stop(s_sta_fallback_timer);
    s_net_mode = SYSTEM_NET_APSTA;
    s_sta_connecting = false;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (ret != ESP_OK) {
        return ret;
    }

    wifi_config_t ap_config = {
        .ap = {
            .ssid_len = 0,
            .channel = WIFI_MANAGER_CHANNEL,
            .password = WIFI_MANAGER_PASS,
            .max_connection = WIFI_MANAGER_MAX_STA_CONN,
            .authmode = WIFI_AUTH_WPA_WPA2_PSK,
            .pmf_cfg = {
                .required = false,
            },
        },
    };
    strlcpy((char *)ap_config.ap.ssid, s_ap_ssid, sizeof(ap_config.ap.ssid));
    ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
    if (ret != ESP_OK) {
        return ret;
    }
    if (!s_driver_started) {
        ret = esp_wifi_start();
        if (ret != ESP_OK) {
            return ret;
        }
        s_driver_started = true;
    }

    report_net_mode(SYSTEM_NET_APSTA);
    report_message("APSTA READY");
    report_wifi_label(s_ap_ssid);
    report_status("apsta_on");
    ESP_LOGI(TAG, "WiFi APSTA active: AP=%s", s_ap_ssid);
    return ESP_OK;
}
```

Update `start_sta_locked()` to use true STA:

```c
ret = esp_wifi_set_mode(WIFI_MODE_STA);
```

Remove AP config setup from `start_sta_locked()`.

- [ ] **Step 6: Add target-aware connect functions**

Replace `wifi_manager_connect_sta()` body with a wrapper:

```c
esp_err_t wifi_manager_connect_sta(const char *ssid, const char *password,
                                   bool save_on_success)
{
    return wifi_manager_connect_sta_for_mode(ssid, password, save_on_success, SYSTEM_NET_APSTA);
}
```

Implement `wifi_manager_connect_sta_for_mode()` by moving the old validation and connect body into the new function, and set target before `start_sta_locked()`:

```c
s_connect_target_mode = target_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA;
```

If `target_mode == SYSTEM_NET_APSTA`, connect while keeping APSTA by setting the driver to APSTA before connect. If `target_mode == SYSTEM_NET_STA`, connect in true STA. The simplest implementation is:

```c
esp_err_t ret = target_mode == SYSTEM_NET_APSTA ? start_sta_in_apsta_locked() : start_sta_locked();
```

Create `start_sta_in_apsta_locked()` by copying the old APSTA-based body of `start_sta_locked()` and setting:

```c
s_net_mode = SYSTEM_NET_APSTA;
s_connect_target_mode = SYSTEM_NET_APSTA;
```

Keep `wifi_manager_quick_connect()` as a wrapper:

```c
esp_err_t wifi_manager_quick_connect(const char *ssid)
{
    return wifi_manager_quick_connect_for_mode(ssid, SYSTEM_NET_APSTA);
}
```

Implement:

```c
esp_err_t wifi_manager_quick_connect_for_mode(const char *ssid,
                                              system_net_mode_t target_mode)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    char saved_ssid[33];
    char saved_pass[65];
    bool use_saved = wifi_manager_get_saved_sta_config(saved_ssid, sizeof(saved_ssid),
                                                       saved_pass, sizeof(saved_pass)) &&
                     strcmp(saved_ssid, ssid) == 0;
    return wifi_manager_connect_sta_for_mode(ssid,
                                             use_saved ? saved_pass : WIFI_MANAGER_QUICK_PASSWORD,
                                             !use_saved,
                                             target_mode);
}
```

- [ ] **Step 7: Add scheduled target-aware connect and web setup target**

Extend `wifi_manager_connect_task_arg_t`:

```c
system_net_mode_t target_mode;
```

Make `wifi_manager_schedule_connect_sta()` wrap:

```c
return wifi_manager_schedule_connect_sta_for_mode(ssid, password, save_on_success,
                                                 SYSTEM_NET_APSTA, delay_ms);
```

Add `wifi_manager_schedule_connect_sta_for_mode()` and pass `target_mode` into the task arg. In `wifi_manager_connect_task()`, call:

```c
esp_err_t ret = wifi_manager_connect_sta_for_mode(task_arg->ssid,
                                                  task_arg->password,
                                                  task_arg->save_on_success,
                                                  task_arg->target_mode);
```

Implement `wifi_manager_begin_web_setup()`:

```c
esp_err_t wifi_manager_begin_web_setup(system_net_mode_t target_mode)
{
    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    s_web_setup_target_mode = target_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA;
    esp_err_t ret = start_apsta_locked();
    if (ret == ESP_OK) {
        report_message(s_web_setup_target_mode == SYSTEM_NET_STA ? "WEB SETUP STA" : "WEB SETUP APSTA");
        report_status("web_setup");
    }
    xSemaphoreGive(s_mode_mutex);
    return ret;
}
```

- [ ] **Step 8: Converge to target mode on IP**

In `IP_EVENT_STA_GOT_IP`, copy `s_connect_target_mode` before unlock:

```c
system_net_mode_t target_mode = s_connect_target_mode;
```

After saving pending config, if `target_mode == SYSTEM_NET_STA`, close AP:

```c
if (target_mode == SYSTEM_NET_STA) {
    if (lock_mode(pdMS_TO_TICKS(100)) == pdTRUE) {
        esp_err_t mode_ret = esp_wifi_set_mode(WIFI_MODE_STA);
        if (mode_ret == ESP_OK) {
            s_net_mode = SYSTEM_NET_STA;
        } else {
            ESP_LOGW(TAG, "Failed to close AP after STA connect: %s", esp_err_to_name(mode_ret));
        }
        unlock_mode();
    }
    report_net_mode(SYSTEM_NET_STA);
    report_status("sta_on");
} else {
    report_net_mode(SYSTEM_NET_APSTA);
    report_status("apsta_on");
}
```

Keep `report_message("STA CONNECTED")` and `report_wifi_label(s_sta_ip)`.

- [ ] **Step 9: Remove automatic fallback to AP**

Change `sta_fallback_timer_cb()`:

```c
static void sta_fallback_timer_cb(void *arg)
{
    (void)arg;
    ESP_LOGW(TAG, "STA connect timeout, retrying");
    report_message("STA RETRY");
    report_status("sta_retry");
    esp_err_t ret = esp_wifi_connect();
    if (ret != ESP_OK && ret != ESP_ERR_WIFI_CONN) {
        ESP_LOGW(TAG, "STA retry failed: %s", esp_err_to_name(ret));
    }
    esp_timer_start_once(s_sta_fallback_timer, WIFI_MANAGER_STA_CONNECT_TIMEOUT_MS * 1000ULL);
}
```

In `WIFI_EVENT_STA_DISCONNECTED`, remove scheduling AP fallback. Replace the fallback branch with:

```c
if (should_retry) {
    report_message("STA LOST");
    report_status("sta_lost");
    esp_err_t ret = esp_wifi_connect();
    if (ret != ESP_OK && ret != ESP_ERR_WIFI_CONN) {
        ESP_LOGW(TAG, "STA reconnect failed: %s", esp_err_to_name(ret));
    }
}
```

Define `should_retry` as:

```c
bool should_retry = (s_net_mode == SYSTEM_NET_STA || s_net_mode == SYSTEM_NET_APSTA) &&
                    (s_sta_connecting || s_sta_connected);
```

- [ ] **Step 10: Update request mode and boot default**

Change `wifi_manager_request_net_mode()`:

```c
switch (mode) {
case SYSTEM_NET_AP:
    ret = start_ap_locked();
    break;
case SYSTEM_NET_STA:
    ret = start_sta_locked();
    if (ret != ESP_OK) {
        report_message(ret == ESP_ERR_INVALID_STATE ? "STA NEED CFG" : "STA FAIL");
        report_status(ret == ESP_ERR_INVALID_STATE ? "sta_need_cfg" : "sta_fail");
    }
    break;
case SYSTEM_NET_APSTA:
default:
    ret = start_apsta_locked();
    break;
}
```

In `wifi_manager_init()`, boot APSTA by default:

```c
ret = wifi_manager_request_net_mode(SYSTEM_NET_APSTA);
```

Do not auto-choose STA on boot from saved config in this task.

- [ ] **Step 11: Run provisioning regression**

Run:

```bash
node scripts/wifi_provisioning_target_regression.mjs
```

Expected: PASS.

- [ ] **Step 12: Run existing scan regressions**

Run:

```bash
node scripts/wifi_scan_ap_stability_regression.mjs
node scripts/wifi_scan_timing_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
```

Expected: PASS, except `wifi_scan_restore_regression.mjs` may need its assertion updated from “AP logic state uses APSTA” to “APSTA workflows use APSTA and pure AP uses WIFI_MODE_AP”. If it fails for that reason, update the script to assert the new true-mode behavior:

```js
assert.ok(
  /static esp_err_t start_ap_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_AP\)/.test(source),
  'AP mode must use true WIFI_MODE_AP',
);
assert.ok(
  /static esp_err_t start_apsta_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_APSTA\)/.test(source),
  'APSTA mode must use true WIFI_MODE_APSTA',
);
assert.ok(
  source.includes('.home_chan_dwell_time = WIFI_MANAGER_SCAN_HOME_DWELL_MS'),
  'APSTA scan must keep the verified home-channel dwell',
);
```

- [ ] **Step 13: Build**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: compile may still fail in `ui_controller`, `web_api`, or `main` until later tasks wire new APIs. Fix only `wifi_manager.*` errors in this task.

- [ ] **Step 14: Commit**

Commit manager changes:

```bash
git add main/wifi_manager.h main/wifi_manager.c scripts/wifi_provisioning_target_regression.mjs scripts/wifi_scan_restore_regression.mjs
git commit -m "Add target-aware WiFi manager modes"
```

---

### Task 3: Wire OLED Actions Through UI Controller

**Files:**
- Modify: `main/ui_controller.h`
- Modify: `main/ui_controller.c`
- Modify: `main/main.c`
- Create: `scripts/wifi_oled_workflow_regression.mjs`

**Interfaces:**
- Consumes:
  - `wifi_manager_begin_web_setup(system_net_mode_t target_mode)`
  - `wifi_manager_quick_connect_for_mode(const char *ssid, system_net_mode_t target_mode)`
  - `wifi_manager_schedule_net_mode(system_net_mode_t mode)`
- Produces:
  - `ui_controller_config_t.wifi_begin_web_setup`
  - `ui_controller_config_t.wifi_quick_connect_for_mode`
  - OLED feedback for STA/APSTA quick/web actions.

- [ ] **Step 1: Write the failing OLED workflow regression**

Create `scripts/wifi_oled_workflow_regression.mjs`:

```js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const header = readFileSync(resolve(process.cwd(), 'main/ui_controller.h'), 'utf8');
const controller = readFileSync(resolve(process.cwd(), 'main/ui_controller.c'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'main/main.c'), 'utf8');

assert.ok(header.includes('wifi_quick_connect_for_mode'), 'ui_controller_config_t must include target-aware quick connect callback');
assert.ok(header.includes('wifi_begin_web_setup'), 'ui_controller_config_t must include web setup callback');

assert.ok(
  /case SYSTEM_ACTION_NET_STA_QUICK:[\s\S]*?apply_sta_quick_scan\(source, SYSTEM_NET_STA\)/.test(controller),
  'STA Quick Connect must scan with STA as target mode',
);
assert.ok(
  /case SYSTEM_ACTION_NET_APSTA_QUICK:[\s\S]*?apply_sta_quick_scan\(source, SYSTEM_NET_APSTA\)/.test(controller),
  'APSTA Quick Connect must scan with APSTA as target mode',
);
assert.ok(
  /case SYSTEM_ACTION_NET_STA_WEB_SETUP:[\s\S]*?apply_sta_web_setup\(source, SYSTEM_NET_STA\)/.test(controller),
  'STA Web Setup must begin web setup with STA target',
);
assert.ok(
  /case SYSTEM_ACTION_NET_APSTA_WEB_SETUP:[\s\S]*?apply_sta_web_setup\(source, SYSTEM_NET_APSTA\)/.test(controller),
  'APSTA Web Setup must begin web setup with APSTA target',
);
assert.ok(
  /SYSTEM_ACTION_NET_STA_QUICK_CONNECT[\s\S]*?wifi_quick_connect_for_mode\(ssid, SYSTEM_NET_STA\)/.test(controller),
  'STA SSID selection must connect with STA target',
);
assert.ok(
  /SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT[\s\S]*?wifi_quick_connect_for_mode\(ssid, SYSTEM_NET_APSTA\)/.test(controller),
  'APSTA SSID selection must connect with APSTA target',
);

assert.ok(main.includes('.wifi_quick_connect_for_mode = ui_wifi_quick_connect_for_mode'),
  'main must wire target-aware quick connect callback');
assert.ok(main.includes('.wifi_begin_web_setup = ui_wifi_begin_web_setup'),
  'main must wire web setup callback');
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/wifi_oled_workflow_regression.mjs
```

Expected: FAIL because controller callbacks and target-aware cases are missing.

- [ ] **Step 3: Update `ui_controller_config_t`**

In `main/ui_controller.h`, replace:

```c
esp_err_t (*wifi_quick_connect)(const char *ssid, void *ctx);
```

with:

```c
esp_err_t (*wifi_quick_connect_for_mode)(const char *ssid,
                                         system_net_mode_t target_mode,
                                         void *ctx);
esp_err_t (*wifi_begin_web_setup)(system_net_mode_t target_mode, void *ctx);
```

- [ ] **Step 4: Add controller wrappers**

In `main/ui_controller.c`, replace `wifi_quick_connect()` with:

```c
static esp_err_t wifi_quick_connect_for_mode(const char *ssid,
                                             system_net_mode_t target_mode)
{
    if (s_config.wifi_quick_connect_for_mode == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return s_config.wifi_quick_connect_for_mode(ssid, target_mode, s_config.ctx);
}

static esp_err_t wifi_begin_web_setup(system_net_mode_t target_mode)
{
    if (s_config.wifi_begin_web_setup == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return s_config.wifi_begin_web_setup(target_mode, s_config.ctx);
}
```

- [ ] **Step 5: Make scan remember target via selected mode**

Change `apply_sta_quick_scan()` signature:

```c
static esp_err_t apply_sta_quick_scan(system_action_source_t source,
                                      system_net_mode_t target_mode)
```

At the start of the function, set menu selected mode for the upcoming WiFi list:

```c
system_menu_set_net_mode(target_mode);
```

Use target-specific action in failure feedback:

```c
system_menu_action_t action = target_mode == SYSTEM_NET_STA ?
                              SYSTEM_ACTION_NET_STA_QUICK :
                              SYSTEM_ACTION_NET_APSTA_QUICK;
```

Then replace feedback calls in this function with `action`.

- [ ] **Step 6: Make quick connect target-aware**

Change `apply_sta_quick_connect()` signature:

```c
static esp_err_t apply_sta_quick_connect(system_action_source_t source,
                                         system_net_mode_t target_mode)
```

Pick feedback action:

```c
system_menu_action_t action = target_mode == SYSTEM_NET_STA ?
                              SYSTEM_ACTION_NET_STA_QUICK_CONNECT :
                              SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT;
```

Set OLED/menu target and messages:

```c
system_menu_set_net_mode(target_mode);
system_menu_set_message(target_mode == SYSTEM_NET_STA ? "STA CONNECTING" : "APSTA CONNECTING");
display_port_set_status(target_mode == SYSTEM_NET_STA ? "quick_sta_conn" : "quick_apsta_conn");
display_lvgl_set_status(target_mode == SYSTEM_NET_STA ? "sta_conn" : "apsta_conn");
```

Call:

```c
esp_err_t err = wifi_quick_connect_for_mode(ssid, target_mode);
```

On error, do not force menu mode to AP. Instead:

```c
action_feedback(action, source, "FAIL", "connect STA");
```

- [ ] **Step 7: Make web setup target-aware**

Change `apply_sta_web_setup()` signature:

```c
static esp_err_t apply_sta_web_setup(system_action_source_t source,
                                     system_net_mode_t target_mode)
```

Do not cast away `source`. Choose action:

```c
system_menu_action_t action = target_mode == SYSTEM_NET_STA ?
                              SYSTEM_ACTION_NET_STA_WEB_SETUP :
                              SYSTEM_ACTION_NET_APSTA_WEB_SETUP;
```

Call:

```c
esp_err_t err = wifi_begin_web_setup(target_mode);
if (err != ESP_OK) {
    action_feedback(action, source, "FAIL", "web setup");
    return err;
}
```

Then set OLED lines:

```c
system_menu_set_net_mode(target_mode);
system_menu_set_message(target_mode == SYSTEM_NET_STA ? "WEB SETUP STA" : "WEB SETUP APSTA");
display_port_set_status("wifi_web_setup");
display_lvgl_set_status("web_setup");
display_lvgl_set_text_screen(target_mode == SYSTEM_NET_STA ? "STA WEB" : "APSTA WEB",
                             ap_line,
                             "PASS:12345678",
                             "IP:192.168.4.1",
                             "/wifi.html",
                             "S5L BACK");
```

- [ ] **Step 8: Update controller switch cases**

In `ui_controller_apply_menu_action()` replace the network cases with:

```c
case SYSTEM_ACTION_NET_AP:
    system_menu_set_net_mode(SYSTEM_NET_AP);
    system_menu_set_message("AP SWITCHING");
    display_port_set_status("menu_ap");
    display_lvgl_set_status("ap_switch");
    wifi_schedule_net_mode(SYSTEM_NET_AP);
    action_feedback(action, source, "WORKING", "AP mode");
    break;
case SYSTEM_ACTION_NET_STA_QUICK:
    err = apply_sta_quick_scan(source, SYSTEM_NET_STA);
    break;
case SYSTEM_ACTION_NET_APSTA_QUICK:
    err = apply_sta_quick_scan(source, SYSTEM_NET_APSTA);
    break;
case SYSTEM_ACTION_NET_STA_WEB_SETUP:
    err = apply_sta_web_setup(source, SYSTEM_NET_STA);
    break;
case SYSTEM_ACTION_NET_APSTA_WEB_SETUP:
    err = apply_sta_web_setup(source, SYSTEM_NET_APSTA);
    break;
case SYSTEM_ACTION_NET_STA_QUICK_CONNECT:
    err = apply_sta_quick_connect(source, SYSTEM_NET_STA);
    break;
case SYSTEM_ACTION_NET_APSTA_QUICK_CONNECT:
    err = apply_sta_quick_connect(source, SYSTEM_NET_APSTA);
    break;
```

Remove the obsolete `SYSTEM_ACTION_NET_STA` case.

- [ ] **Step 9: Wire callbacks in `main.c`**

Replace `ui_wifi_quick_connect()` with:

```c
static esp_err_t ui_wifi_quick_connect_for_mode(const char *ssid,
                                                system_net_mode_t target_mode,
                                                void *ctx)
{
    (void)ctx;
    return wifi_manager_quick_connect_for_mode(ssid, target_mode);
}

static esp_err_t ui_wifi_begin_web_setup(system_net_mode_t target_mode, void *ctx)
{
    (void)ctx;
    return wifi_manager_begin_web_setup(target_mode);
}
```

Update `ui_controller_config_t ui_config`:

```c
.wifi_quick_connect_for_mode = ui_wifi_quick_connect_for_mode,
.wifi_begin_web_setup = ui_wifi_begin_web_setup,
```

- [ ] **Step 10: Run OLED workflow regression**

Run:

```bash
node scripts/wifi_oled_workflow_regression.mjs
```

Expected: PASS.

- [ ] **Step 11: Build**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: compile may still fail in `web_api` or `main` UART command paths until Task 4. Fix only `ui_controller.*` and callback wiring errors here.

- [ ] **Step 12: Commit**

```bash
git add main/ui_controller.h main/ui_controller.c main/main.c scripts/wifi_oled_workflow_regression.mjs
git commit -m "Wire OLED WiFi mode workflows"
```

---

### Task 4: Update Web API and UART for APSTA

**Files:**
- Modify: `main/web_api.h`
- Modify: `main/web_api.c`
- Modify: `main/main.c`
- Create: `scripts/wifi_api_apsta_regression.mjs`

**Interfaces:**
- Consumes:
  - `wifi_manager_schedule_connect_sta_for_mode(...)`
  - `wifi_manager_request_net_mode(SYSTEM_NET_AP|SYSTEM_NET_STA|SYSTEM_NET_APSTA)`
  - `system_menu_net_name(SYSTEM_NET_APSTA) == "APSTA"`
- Produces:
  - `/api/wifi/mode` accepts `{mode:"ap"|"sta"|"apsta"}`
  - `/api/wifi/connect` connects to the current provisioning target.
  - UART accepts `AT+WIFI=APSTA`.

- [ ] **Step 1: Write the failing API regression**

Create `scripts/wifi_api_apsta_regression.mjs`:

```js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiHeader = readFileSync(resolve(process.cwd(), 'main/web_api.h'), 'utf8');
const api = readFileSync(resolve(process.cwd(), 'main/web_api.c'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'main/main.c'), 'utf8');

assert.ok(apiHeader.includes('system_net_mode_t target_mode'),
  'web_api wifi_connect_sta callback must accept target_mode');

assert.ok(api.includes('mode must be ap/sta/apsta'),
  '/api/wifi/mode validation must mention apsta');
assert.ok(
  /strcmp\(mode, "apsta"\)[\s\S]*?SYSTEM_ACTION_NET_APSTA_WEB_SETUP|strcmp\(mode, "apsta"\)[\s\S]*?SYSTEM_NET_APSTA/.test(api),
  '/api/wifi/mode must parse apsta',
);
assert.ok(
  /wifi_connect_sta\(ssid, password, save_on_success, .*SYSTEM_NET/.test(api),
  '/api/wifi/connect must pass a target mode',
);
assert.ok(api.includes('{\"method\":\"POST\",\"path\":\"/api/wifi/mode\",\"body\":\"{mode:ap|sta|apsta}\"}'),
  'device capabilities must document apsta mode');

assert.ok(main.includes('AT+WIFI=APSTA'), 'UART help and parser must include AT+WIFI=APSTA');
assert.ok(main.includes('wifi_manager_schedule_net_mode(SYSTEM_NET_APSTA)'),
  'UART APSTA command must schedule APSTA mode');
```

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
node scripts/wifi_api_apsta_regression.mjs
```

Expected: FAIL because API and UART paths only know AP/STA.

- [ ] **Step 3: Update `web_api_context_t`**

In `main/web_api.h`, change `wifi_connect_sta` callback to:

```c
esp_err_t (*wifi_connect_sta)(const char *ssid, const char *password,
                              bool save_on_success,
                              system_net_mode_t target_mode,
                              void *ctx);
```

In `main/web_api.c`, change helper:

```c
static esp_err_t wifi_connect_sta(const char *ssid, const char *password,
                                  bool save_on_success,
                                  system_net_mode_t target_mode)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->wifi_connect_sta == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->wifi_connect_sta(ssid, password, save_on_success,
                                 target_mode, ctx->ctx);
}
```

- [ ] **Step 4: Track web provisioning target in `web_api.c`**

Add static state near scan state:

```c
static system_net_mode_t s_web_connect_target_mode = SYSTEM_NET_APSTA;
```

In `wifi_mode_handler()`, parse:

```c
system_net_mode_t target_mode = SYSTEM_NET_AP;
if (strcmp(mode, "ap") == 0 || strcmp(mode, "AP") == 0) {
    action = SYSTEM_ACTION_NET_AP;
    target_mode = SYSTEM_NET_AP;
} else if (strcmp(mode, "sta") == 0 || strcmp(mode, "STA") == 0) {
    action = SYSTEM_ACTION_NET_STA_WEB_SETUP;
    target_mode = SYSTEM_NET_STA;
} else if (strcmp(mode, "apsta") == 0 || strcmp(mode, "APSTA") == 0) {
    action = SYSTEM_ACTION_NET_APSTA_WEB_SETUP;
    target_mode = SYSTEM_NET_APSTA;
} else {
    httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"mode must be ap/sta/apsta\"}");
    return ESP_OK;
}
s_web_connect_target_mode = target_mode;
```

Using web setup actions for `sta` and `apsta` is intentional: web clients need AP/web availability to continue setup.

- [ ] **Step 5: Pass target mode in `/api/wifi/connect`**

In `wifi_connect_handler()`, call:

```c
system_net_mode_t target_mode = s_web_connect_target_mode;
esp_err_t err = wifi_connect_sta(ssid, password, save_on_success, target_mode);
```

Update response:

```c
snprintf(resp, sizeof(resp),
         "{\"ok\":true,\"state\":\"connecting\",\"ssid\":\"%s\",\"save\":%s,\"target\":\"%s\"}",
         esc_ssid,
         save_on_success ? "true" : "false",
         system_menu_net_name(target_mode));
```

- [ ] **Step 6: Update `main.c` web callback**

Change `web_api_wifi_connect_sta()` signature:

```c
static esp_err_t web_api_wifi_connect_sta(const char *ssid, const char *password,
                                          bool save_on_success,
                                          system_net_mode_t target_mode,
                                          void *ctx)
{
    (void)ctx;
    return wifi_manager_schedule_connect_sta_for_mode(ssid, password,
                                                     save_on_success,
                                                     target_mode,
                                                     400);
}
```

- [ ] **Step 7: Update capabilities and options docs**

In `device_capabilities_handler()`, update:

```c
"\"AT+WIFI=STA\",\"AT+WIFI=AP\",\"AT+WIFI=APSTA\"],"
```

and:

```c
"{\"method\":\"POST\",\"path\":\"/api/wifi/mode\",\"body\":\"{mode:ap|sta|apsta}\"},"
```

- [ ] **Step 8: Add UART APSTA command**

In `app_handle_uart_wifi_command()` add:

```c
static const char apsta_cmd[] = "AT+WIFI=APSTA";
```

Add parser block before AP or after STA:

```c
if (len == sizeof(apsta_cmd) - 1 &&
    memcmp(data, apsta_cmd, sizeof(apsta_cmd) - 1) == 0) {
#if CONFIG_ENABLE_WIFI
    wifi_manager_schedule_net_mode(SYSTEM_NET_APSTA);
    display_lvgl_set_status("apsta_switch");
    uart_send_text("\r\nWIFI APSTA QUEUED\r\n");
#else
    uart_send_text("\r\nWIFI ERR disabled\r\n");
#endif
    return true;
}
```

Update help:

```c
"AT+WIFI=APSTA\r\n");
```

- [ ] **Step 9: Run API regression**

Run:

```bash
node scripts/wifi_api_apsta_regression.mjs
```

Expected: PASS.

- [ ] **Step 10: Build**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: PASS or only errors directly tied to web API signature mismatch; fix those before committing.

- [ ] **Step 11: Commit**

```bash
git add main/web_api.h main/web_api.c main/main.c scripts/wifi_api_apsta_regression.mjs
git commit -m "Expose APSTA WiFi API and UART control"
```

---

### Task 5: Final Verification and Flash

**Files:**
- Modify only if verification reveals a real defect in prior tasks.
- No new source files expected.

**Interfaces:**
- Consumes all APIs and menu behaviors from Tasks 1-4.
- Produces a built and optionally flashed firmware image.

- [ ] **Step 1: Run all source regressions**

Run:

```bash
node scripts/wifi_true_modes_regression.mjs
node scripts/wifi_provisioning_target_regression.mjs
node scripts/wifi_oled_workflow_regression.mjs
node scripts/wifi_api_apsta_regression.mjs
node scripts/wifi_scan_ap_stability_regression.mjs
node scripts/wifi_scan_timing_regression.mjs
node scripts/wifi_page_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
node scripts/oled_layout_regression.mjs
```

Expected: all scripts exit 0. If `scripts/oled_layout_regression.mjs` is still untracked from the previous OLED fix, include it in the command only if the file exists:

```bash
test ! -f scripts/oled_layout_regression.mjs || node scripts/oled_layout_regression.mjs
```

- [ ] **Step 2: Build firmware**

Run:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected output contains:

```text
Project build complete.
Generated D:/Users/sunqi39/Desktop/wireless_debug-main/build/uart_ble_wifi.bin
```

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intended files from the WiFi mode work plus any pre-existing OLED fix files. Do not revert unrelated user or previous-turn changes.

- [ ] **Step 4: Flash if COM4 is present**

Check port:

```bash
cmd.exe /C mode
```

If COM4 is present and the board is in download mode, flash:

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main\build && D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash @flash_args"
```

Expected output includes `Hash of data verified.` for each image and `Hard resetting via RTS pin...`.

- [ ] **Step 5: Hardware smoke checklist**

On the OLED:

```text
Network -> AP Mode
```

Expected: home view shows `WiFi:AP` and `IP:192.168.4.1`; ESP32 hotspot is available.

```text
Network -> APSTA Mode -> Web Setup
```

Expected: OLED shows AP SSID, `PASS:12345678`, `IP:192.168.4.1`; web page remains reachable.

```text
Network -> APSTA Mode -> Quick Connect
```

Expected: WiFi list appears; selecting an SSID connects and home remains `WiFi:APSTA`.

```text
Network -> STA Mode -> Web Setup
```

Expected: web setup is reachable during setup; after a successful web WiFi connect, home becomes `WiFi:STA` and AP is no longer advertised.

```text
Network -> STA Mode -> Quick Connect
```

Expected: WiFi list appears; selecting an SSID connects and home becomes `WiFi:STA`.

- [ ] **Step 6: Final commit**

If Task 5 required fixes, commit them:

```bash
git add main scripts docs/superpowers/plans/2026-07-08-true-wifi-modes.md
git commit -m "Verify true WiFi mode workflows"
```

If no fixes were needed, commit only the plan if it has not already been committed:

```bash
git add docs/superpowers/plans/2026-07-08-true-wifi-modes.md
git commit -m "Plan true WiFi mode implementation"
```

---

## Self-Review Notes

- Spec coverage: AP/STA/APSTA selected modes are covered in Tasks 1 and 2; STA/APSTA child actions are covered in Tasks 1 and 3; web setup target convergence is covered in Tasks 2 and 4; no automatic fallback is covered in Task 2; hardware/build verification is covered in Task 5.
- Placeholder scan: no unfinished marker strings or open-ended implementation placeholders are intentionally left in this plan.
- Type consistency: all new function names use `system_net_mode_t target_mode`; compatibility wrappers keep existing callers working during staged implementation.
