import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

assert.match(
  source,
  /static const uint8_t s_auto_scan_channels\[\]\s*=\s*\{\s*1,\s*6,\s*11,\s*2,\s*3,\s*4,\s*5,\s*7,\s*8,\s*9,\s*10,\s*12,\s*13,?\s*\};/,
  'automatic scan must prioritize 1/6/11 and still cover every China 2.4 GHz channel',
);

for (const define of [
  '#define WIFI_MANAGER_AUTO_SCAN_STA_MS 30000',
  '#define WIFI_MANAGER_AUTO_SCAN_APSTA_MS 60000',
  '#define WIFI_MANAGER_AUTO_SCAN_CHANNEL_GAP_MS 5000',
  '#define WIFI_MANAGER_AUTO_SCAN_BACKOFF_AFTER 5',
  '#define WIFI_MANAGER_AUTO_SCAN_MAX_MS 120000',
]) {
  assert.ok(source.includes(define), `missing ${define}`);
}

for (const symbol of [
  'static esp_timer_handle_t s_auto_scan_timer;',
  'static uint8_t s_auto_scan_failures;',
  'static uint8_t s_auto_scan_channel_index;',
  'static bool s_auto_scan_task_running;',
  'static bool s_auto_scan_cancel_requested;',
  'static bool s_auto_scan_started;',
  'static esp_err_t auto_scan_saved_channel',
  'static bool advance_auto_scan_channel_locked',
  'static bool auto_scan_ap_service_active_locked',
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
const autoScanTask = source.match(
  /static void auto_scan_task\(void \*arg\)\s*\{[\s\S]*?\n}\n\nstatic esp_err_t start_ap_locked/,
)?.[0];

assert.ok(autoScanTask, 'auto scan task implementation must exist');
assert.doesNotMatch(
  autoScanTask,
  /wifi_manager_scan\(/,
  'automatic reconnect must not use the blocking all-channel provisioning scan',
);
assert.match(
  autoScanTask,
  /auto_scan_saved_channel\(saved_ssid,\s*scan_channel,\s*&found_saved\)/,
  'automatic reconnect must probe only the current saved-SSID channel',
);
assert.match(
  autoScanTask,
  /wifi_manager_connect_sta_for_mode\(saved_ssid,\s*saved_pass,\s*false,\s*target_mode\)/,
  'automatic reconnect must use the saved credentials after finding the SSID',
);
assert.match(
  autoScanTask,
  /completed_sweep\s*=\s*advance_auto_scan_channel_locked\(\)[\s\S]*?completed_sweep\s*\?[\s\S]*?auto_scan_delay_for_target\(target_mode\)[\s\S]*?:\s*WIFI_MANAGER_AUTO_SCAN_CHANNEL_GAP_MS/,
  'automatic reconnect must rotate channels quickly and back off only after a full sweep',
);
assert.match(
  autoScanTask,
  /auto_scan_ap_service_active_locked\(\)\s*&&\s*ap_client_count\(\)\s*>\s*0[\s\S]*?stop_auto_scan_locked\(\)[\s\S]*?else\s*\{[\s\S]*?advance_auto_scan_channel_locked\(\)/,
  'an AP client interrupting a scan must pause without skipping the interrupted channel',
);
assert.match(
  autoScanTask,
  /scan_ret\s*==\s*ESP_ERR_INVALID_STATE[\s\S]*?schedule_auto_scan_locked\(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS\)[\s\S]*?else\s*\{[\s\S]*?advance_auto_scan_channel_locked\(\)/,
  'a prevented or cancelled scan must retry the same channel instead of consuming it',
);

const channelScan = source.match(
  /static esp_err_t auto_scan_saved_channel\([\s\S]*?\n}\n\nstatic void auto_scan_task/,
)?.[0];

assert.ok(channelScan, 'saved-SSID channel scan implementation must exist');
assert.match(channelScan, /\.ssid\s*=\s*\(uint8_t \*\)ssid/);
assert.match(channelScan, /\.channel\s*=\s*channel/);
assert.match(channelScan, /\.coex_background_scan\s*=\s*true/);
assert.match(
  channelScan,
  /esp_wifi_scan_start\(&scan_config,\s*true\)/,
  'the dedicated auto-scan task must let the WiFi driver own completion synchronization',
);
assert.match(
  channelScan,
  /cancel_before_start\s*=\s*auto_scan_mark_started\(\)[\s\S]*?if\s*\(cancel_before_start\)[\s\S]*?ESP_ERR_INVALID_STATE[\s\S]*?else[\s\S]*?esp_wifi_scan_start\(&scan_config,\s*true\)/,
  'an AP client arriving before scan start must cancel without entering the driver scan',
);
assert.doesNotMatch(
  channelScan,
  /xSemaphoreTake\(s_auto_scan_done_sem|s_auto_scan_done_sem|s_auto_scan_waiting_for_done|auto_scan_done_status/,
  'automatic scans must not duplicate the WiFi driver completion state machine',
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

for (const symbol of [
  'static portMUX_TYPE s_auto_scan_state_lock = portMUX_INITIALIZER_UNLOCKED;',
  'static uint8_t s_ap_client_count;',
  'static bool s_auto_scan_in_progress;',
  'static uint8_t ap_client_count(void)',
  'static bool auto_scan_begin_if_allowed(void)',
  'static bool auto_scan_end(void)',
]) {
  assert.ok(source.includes(symbol), `missing AP-service scan guard: ${symbol}`);
}

const shouldAutoScan = source.match(
  /static bool auto_scan_should_run_locked\([\s\S]*?\n}\n\nstatic uint32_t auto_scan_delay_for_target/,
)?.[0];

assert.ok(shouldAutoScan, 'auto scan eligibility implementation must exist');
assert.match(
  shouldAutoScan,
  /auto_scan_ap_service_active_locked\(\)[\s\S]*?ap_client_count\(\)\s*>\s*0[\s\S]*?return false/,
  'automatic scans must pause whenever the active radio mode is serving a SoftAP client',
);

assert.match(
  channelScan,
  /auto_scan_begin_if_allowed\(\)[\s\S]*?esp_wifi_scan_start\([\s\S]*?auto_scan_end\(\)/,
  'automatic scan state must cover the complete asynchronous scan lifecycle',
);

const wifiEventHandler = source.match(
  /static void wifi_event_handler\([\s\S]*?\n}\n\nvoid wifi_manager_get_status/,
)?.[0];

assert.ok(wifiEventHandler, 'WiFi event handler implementation must exist');

const noteClientConnected = source.match(
  /static bool note_ap_client_connected\(void\)\s*\{[\s\S]*?\n}\n\nstatic bool note_ap_client_disconnected/,
)?.[0];

assert.ok(noteClientConnected, 'AP client connection state transition must exist');
assert.match(
  noteClientConnected,
  /s_auto_scan_cancel_requested\s*=\s*true[\s\S]*?stop_auto_scan\s*=\s*s_auto_scan_started/,
  'a client arriving before scan start must persist cancellation without stopping a nonexistent scan',
);

assert.match(
  wifiEventHandler,
  /WIFI_EVENT_AP_STACONNECTED[\s\S]*?note_ap_client_connected\(\)[\s\S]*?stop_auto_scan_locked\(\)[\s\S]*?esp_wifi_scan_stop\(\)/,
  'first SoftAP client connection must stop pending and in-flight automatic scans',
);
assert.match(
  wifiEventHandler,
  /WIFI_EVENT_AP_STADISCONNECTED[\s\S]*?note_ap_client_disconnected\(\)[\s\S]*?schedule_auto_scan_locked\(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS\)/,
  'last SoftAP client disconnection must resume automatic scanning immediately',
);

for (const eventId of [
  'WIFI_EVENT_AP_STACONNECTED',
  'WIFI_EVENT_AP_STADISCONNECTED',
]) {
  assert.match(
    source,
    new RegExp(`esp_event_handler_instance_register\\(WIFI_EVENT,\\s*${eventId}`),
    `wifi_manager_init must register ${eventId}`,
  );
}

assert.doesNotMatch(
  source,
  /s_auto_scan_done_sem|s_auto_scan_waiting_for_done|note_auto_scan_done/,
  'automatic scanning must rely on the driver completion state instead of a parallel semaphore protocol',
);
assert.match(
  source,
  /esp_wifi_set_country_code\(WIFI_MANAGER_COUNTRY_CODE,\s*true\)/,
  'the configured China regulatory domain must make channels 12 and 13 scannable while disconnected',
);

const manualScan = source.match(
  /esp_err_t wifi_manager_scan\([\s\S]*?\n}\n\nesp_err_t wifi_manager_connect_sta_for_mode/,
)?.[0];

assert.ok(manualScan, 'manual provisioning scan implementation must exist');
assert.doesNotMatch(
  manualScan,
  /auto_scan_begin_if_allowed/,
  'explicit OLED/web provisioning scans must remain available while AP clients are connected',
);

assert.match(
  autoScanTask,
  /finish:\s*\n\s*if\s*\(lock_mode\(portMAX_DELAY\)\s*==\s*pdTRUE\)/,
  'auto-scan task cleanup must not abandon the running flag when the mode lock is busy',
);

const createFailureCleanup = source.match(
  /if\s*\(xTaskCreate\(auto_scan_task[\s\S]*?ESP_LOGW\(TAG,\s*"Failed to create WiFi auto scan task"\);\s*\n\s*}/,
)?.[0];

assert.ok(createFailureCleanup, 'auto-scan task creation failure cleanup must exist');
assert.match(
  createFailureCleanup,
  /lock_mode\(portMAX_DELAY\)/,
  'task creation failure must always clear s_auto_scan_task_running',
);
