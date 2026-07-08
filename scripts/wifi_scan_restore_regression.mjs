import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

assert.ok(
  /static esp_err_t start_ap_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_AP\)/.test(source),
  'AP 逻辑状态下底层应使用真正的 WIFI_MODE_AP',
);
assert.ok(
  /wifi_manager_scan[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_APSTA\)[\s\S]*?restore_mode = WIFI_MODE_AP/.test(source),
  'wifi_manager_scan 应在 AP 模式扫描前临时切到 APSTA 并记录恢复 AP',
);
assert.ok(
  /restore_after_scan[\s\S]*?esp_wifi_set_mode\(restore_mode\)/.test(source),
  'wifi_manager_scan 扫描结束后应恢复原来的真 AP 模式',
);
