import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const systemHeader = readFileSync(resolve(root, 'main/system_menu.h'), 'utf8');
const systemMenu = readFileSync(resolve(root, 'main/system_menu.c'), 'utf8');
const wifiHeader = readFileSync(resolve(root, 'main/wifi_manager.h'), 'utf8');
const wifiManager = readFileSync(resolve(root, 'main/wifi_manager.c'), 'utf8');
const uiHeader = readFileSync(resolve(root, 'main/ui_controller.h'), 'utf8');
const uiController = readFileSync(resolve(root, 'main/ui_controller.c'), 'utf8');
const webHeader = readFileSync(resolve(root, 'main/web_api.h'), 'utf8');
const webApi = readFileSync(resolve(root, 'main/web_api.c'), 'utf8');
const main = readFileSync(resolve(root, 'main/main.c'), 'utf8');
const displayUi = readFileSync(resolve(root, 'main/display_ui.c'), 'utf8');

assert.ok(
  /typedef enum \{[\s\S]*?SYSTEM_NET_AP,[\s\S]*?SYSTEM_NET_STA,[\s\S]*?SYSTEM_NET_APSTA,[\s\S]*?\} system_net_mode_t;/.test(systemHeader),
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
  assert.ok(systemHeader.includes(action), `missing menu action ${action}`);
}

assert.ok(
  /typedef enum \{[\s\S]*?NET_ITEM_AP,[\s\S]*?NET_ITEM_STA,[\s\S]*?NET_ITEM_APSTA,[\s\S]*?NET_ITEM_COUNT,[\s\S]*?\} network_item_t;/.test(systemMenu),
  'Network page must contain exactly AP, STA, and APSTA items',
);

assert.ok(
  /typedef enum \{[\s\S]*?STA_ITEM_QUICK,[\s\S]*?STA_ITEM_WEB_SETUP,[\s\S]*?STA_ITEM_COUNT,[\s\S]*?\} sta_item_t;/.test(systemMenu),
  'STA page must contain exactly Quick Connect and Web Setup',
);

assert.ok(
  /typedef enum \{[\s\S]*?APSTA_ITEM_QUICK,[\s\S]*?APSTA_ITEM_WEB_SETUP,[\s\S]*?APSTA_ITEM_COUNT,[\s\S]*?\} apsta_item_t;/.test(systemMenu),
  'APSTA page must contain exactly Quick Connect and Web Setup',
);

for (const label of ['AP Mode', 'STA Mode', 'APSTA Mode', 'Quick Connect', 'Web Setup']) {
  assert.ok(systemMenu.includes(label), `OLED menu label missing: ${label}`);
}

assert.ok(/case SYSTEM_NET_APSTA:\s*return "APSTA";/.test(systemMenu),
  'system_menu_net_name must render APSTA');

for (const api of [
  'wifi_manager_begin_web_setup',
  'wifi_manager_quick_connect_for_mode',
  'wifi_manager_connect_sta_for_mode',
  'wifi_manager_schedule_connect_sta_for_mode',
]) {
  assert.ok(wifiHeader.includes(api), `wifi_manager.h missing ${api}`);
  assert.ok(wifiManager.includes(api), `wifi_manager.c missing ${api}`);
}

assert.ok(wifiManager.includes('static system_net_mode_t s_connect_target_mode = SYSTEM_NET_APSTA;'),
  'wifi_manager must track pending connect target mode');

assert.ok(/static esp_err_t start_ap_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_AP\)/.test(wifiManager),
  'AP mode must use true WIFI_MODE_AP');
assert.ok(/static esp_err_t start_sta_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_STA\)/.test(wifiManager),
  'STA mode must use true WIFI_MODE_STA');
assert.ok(/static esp_err_t start_apsta_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_APSTA\)/.test(wifiManager),
  'APSTA mode must use true WIFI_MODE_APSTA');
assert.ok(/sta_fallback_timer_cb[\s\S]*?schedule_auto_scan_locked\(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS\)/.test(wifiManager),
  'STA timeout must schedule background auto scan instead of falling back to AP');
assert.ok(!wifiManager.includes('falling back to AP'),
  'wifi_manager must not describe STA timeout as falling back to AP');

assert.ok(uiHeader.includes('wifi_quick_connect_for_mode'),
  'ui_controller_config_t must include target-aware quick connect callback');
assert.ok(uiHeader.includes('wifi_begin_web_setup'),
  'ui_controller_config_t must include web setup callback');
assert.ok(/case SYSTEM_ACTION_NET_STA_QUICK:[\s\S]*?apply_sta_quick_scan\(source, SYSTEM_NET_STA\)/.test(uiController),
  'STA Quick Connect must scan with STA target');
assert.ok(/case SYSTEM_ACTION_NET_APSTA_QUICK:[\s\S]*?apply_sta_quick_scan\(source, SYSTEM_NET_APSTA\)/.test(uiController),
  'APSTA Quick Connect must scan with APSTA target');
assert.ok(/case SYSTEM_ACTION_NET_STA_WEB_SETUP:[\s\S]*?apply_sta_web_setup\(source, SYSTEM_NET_STA\)/.test(uiController),
  'STA Web Setup must begin with STA target');
assert.ok(/case SYSTEM_ACTION_NET_APSTA_WEB_SETUP:[\s\S]*?apply_sta_web_setup\(source, SYSTEM_NET_APSTA\)/.test(uiController),
  'APSTA Web Setup must begin with APSTA target');

assert.ok(webHeader.includes('system_net_mode_t target_mode'),
  'web_api wifi_connect_sta callback must accept target_mode');
assert.ok(webApi.includes('mode must be ap/sta/apsta'),
  '/api/wifi/mode validation must mention apsta');
assert.ok(webApi.includes('{mode:ap|sta|apsta}'),
  'device capabilities must document apsta mode');
assert.ok(main.includes('AT+WIFI=APSTA'),
  'UART help and parser must include AT+WIFI=APSTA');
assert.ok(main.includes('wifi_manager_schedule_net_mode(SYSTEM_NET_APSTA)'),
  'UART APSTA command must schedule APSTA mode');
assert.ok(/case SYSTEM_NET_APSTA:[\s\S]*?AP:%s[\s\S]*?lv_label_set_text\(s_rows\[2\],[\s\S]*?state->wifi_sta_ip/.test(displayUi),
  'OLED home IP formatting must handle APSTA AP IP plus raw STA IP lines');
