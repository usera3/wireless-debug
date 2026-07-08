import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const displayHeader = readFileSync(resolve(root, 'main/display_ui.h'), 'utf8');
const displayLvglHeader = readFileSync(resolve(root, 'main/display_lvgl.h'), 'utf8');
const displayLvgl = readFileSync(resolve(root, 'main/display_lvgl.c'), 'utf8');
const displayUi = readFileSync(resolve(root, 'main/display_ui.c'), 'utf8');
const wifiHeader = readFileSync(resolve(root, 'main/wifi_manager.h'), 'utf8');
const wifiManager = readFileSync(resolve(root, 'main/wifi_manager.c'), 'utf8');
const main = readFileSync(resolve(root, 'main/main.c'), 'utf8');

for (const field of [
  'char wifi_ap_ip[16];',
  'char wifi_sta_ip[16];',
  'bool wifi_sta_connecting;',
  'bool wifi_sta_connected;',
]) {
  assert.ok(displayHeader.includes(field), `display_ui_state_t missing ${field}`);
}

assert.ok(
  displayLvglHeader.includes('display_lvgl_set_wifi_state'),
  'display_lvgl must expose a target-aware WiFi state setter',
);
assert.ok(
  /void display_lvgl_set_wifi_state\([^)]*system_net_mode_t mode[^)]*const char \*ap_ip[^)]*const char \*sta_ip[^)]*bool sta_connecting[^)]*bool sta_connected/.test(displayLvgl),
  'display_lvgl_set_wifi_state must accept mode, AP IP, STA IP, and STA connection booleans',
);

assert.ok(wifiHeader.includes('char ap_ip[16];'),
  'wifi_manager_status_t must expose AP IP separately from STA IP');
assert.ok(wifiHeader.includes('void (*on_wifi_state)(const wifi_manager_status_t *status, void *ctx);'),
  'wifi_manager_config_t must expose a full WiFi state callback');
assert.ok(wifiManager.includes('report_wifi_state_locked'),
  'wifi_manager must report full WiFi state changes');
assert.ok(main.includes('display_lvgl_set_wifi_state(status->mode'),
  'main WiFi state callback must update OLED with full WiFi state');

const closedView = displayUi.match(/static void update_closed_view[\s\S]*?\n}\n\nstatic void update_menu_view/);
assert.ok(closedView, 'display_ui.c must contain update_closed_view');

assert.ok(closedView[0].includes('wifi_sta_status'),
  'OLED home must show STA connection status');
assert.ok(/case SYSTEM_NET_AP:[\s\S]*?IP:%s[\s\S]*?state->wifi_ap_ip/.test(closedView[0]),
  'AP home view must show only the AP IP');
assert.ok(/case SYSTEM_NET_STA:[\s\S]*?IP:%s[\s\S]*?state->wifi_sta_ip/.test(closedView[0]),
  'STA home view must show only the STA IP');
assert.ok(/case SYSTEM_NET_APSTA:[\s\S]*?AP:%s[\s\S]*?state->wifi_ap_ip[\s\S]*?STA:%s[\s\S]*?state->wifi_sta_ip/.test(closedView[0]),
  'APSTA home view must show AP and STA IPs separately');
const staBlock = closedView[0].match(/case SYSTEM_NET_STA:[\s\S]*?break;/);
assert.ok(staBlock, 'display_ui.c must contain an isolated STA home branch');
assert.ok(!staBlock[0].includes('192.168.4.1') && !staBlock[0].includes('wifi_ap_ip'),
  'STA home view must not hard-code or fall back to the AP IP');
