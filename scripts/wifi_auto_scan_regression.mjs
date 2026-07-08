import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

for (const define of [
  '#define WIFI_MANAGER_AUTO_SCAN_STA_MS 30000',
  '#define WIFI_MANAGER_AUTO_SCAN_APSTA_MS 60000',
  '#define WIFI_MANAGER_AUTO_SCAN_BACKOFF_AFTER 5',
  '#define WIFI_MANAGER_AUTO_SCAN_MAX_MS 120000',
]) {
  assert.ok(source.includes(define), `missing ${define}`);
}

for (const symbol of [
  'static esp_timer_handle_t s_auto_scan_timer;',
  'static uint8_t s_auto_scan_failures;',
  'static bool s_auto_scan_task_running;',
  'static bool auto_scan_should_run_locked',
  'static uint32_t auto_scan_delay_for_target',
  'static void schedule_auto_scan_locked',
  'static void stop_auto_scan_locked',
  'static void auto_scan_timer_cb',
  'static void auto_scan_task',
]) {
  assert.ok(source.includes(symbol), `missing auto scan symbol: ${symbol}`);
}

assert.ok(
  /auto_scan_delay_for_target[\s\S]*?target_mode == SYSTEM_NET_STA[\s\S]*?WIFI_MANAGER_AUTO_SCAN_STA_MS[\s\S]*?WIFI_MANAGER_AUTO_SCAN_APSTA_MS/.test(source),
  'STA/APSTA auto scan must use different base intervals',
);
assert.ok(
  /s_auto_scan_failures >= WIFI_MANAGER_AUTO_SCAN_BACKOFF_AFTER[\s\S]*?WIFI_MANAGER_AUTO_SCAN_MAX_MS/.test(source),
  'auto scan must back off to max interval after repeated misses',
);
assert.ok(
  /auto_scan_task[\s\S]*?wifi_manager_scan\([\s\S]*?saved_ssid[\s\S]*?wifi_manager_connect_sta_for_mode\(saved_ssid,\s*saved_pass,\s*false,\s*target_mode\)/.test(source),
  'auto scan task must scan for the saved SSID and reconnect with saved credentials only',
);
assert.ok(
  /start_ap_locked[\s\S]*?stop_auto_scan_locked\(\)/.test(source),
  'switching to true AP must stop background STA auto scan',
);
assert.ok(
  /IP_EVENT_STA_GOT_IP[\s\S]*?s_auto_scan_failures = 0;[\s\S]*?stop_auto_scan_locked\(\)/.test(source),
  'successful STA connection must reset and stop auto scan',
);
assert.ok(
  /sta_fallback_timer_cb[\s\S]*?schedule_auto_scan_locked\(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS\)/.test(source),
  'STA timeout must hand off to immediate background auto scan',
);
assert.ok(
  /WIFI_EVENT_STA_DISCONNECTED[\s\S]*?schedule_auto_scan_locked\(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS\)/.test(source),
  'STA disconnect must hand off to immediate background auto scan',
);
