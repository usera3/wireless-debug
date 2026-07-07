import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

assert.ok(
  /static esp_err_t start_ap_locked\(void\)[\s\S]*?esp_wifi_set_mode\(WIFI_MODE_APSTA\)/.test(source),
  'AP 逻辑状态下底层也应保持 WIFI_MODE_APSTA，避免扫描前切换模式',
);
assert.ok(
  !source.includes('restore_ap_mode_after_scan_if_needed'),
  'wifi_manager_scan 不应再扫描后恢复 AP-only，避免再次触发 AP 断连',
);
assert.ok(
  !source.includes('restore_ap_mode = true;'),
  'wifi_manager_scan 不应再记录临时 AP-only 恢复状态',
);
