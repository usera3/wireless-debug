import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

const manualScan = source.match(
  /esp_err_t wifi_manager_scan\([\s\S]*?\n}\n\nstatic system_net_mode_t normalize_sta_target/,
)?.[0];

assert.ok(manualScan, 'wifi_manager_scan implementation must exist');

const scanConfig = manualScan.match(
  /wifi_scan_config_t scan_config = \{[\s\S]*?\n    \};/,
)?.[0];

assert.ok(scanConfig, 'wifi_manager_scan should define an explicit scan configuration');

assert.match(
  scanConfig,
  /\.scan_time\.active\.min\s*=\s*WIFI_ACTIVE_SCAN_MIN_DEFAULT_TIME/,
  'Bluetooth coexistence requires the WiFi driver default active scan minimum',
);

assert.match(
  scanConfig,
  /\.scan_time\.active\.max\s*=\s*WIFI_ACTIVE_SCAN_MAX_DEFAULT_TIME/,
  'Bluetooth coexistence requires the WiFi driver default active scan maximum',
);

assert.match(
  scanConfig,
  /\.coex_background_scan\s*=\s*true/,
  'coexistence scans must return to the SoftAP home channel between channels',
);

assert.ok(
  source.includes('#define WIFI_MANAGER_SCAN_HOME_DWELL_MS 150'),
  'APSTA scan should dwell on the AP home channel for 150ms so clients keep receiving beacons',
);

assert.ok(
  manualScan.includes('.home_chan_dwell_time = WIFI_MANAGER_SCAN_HOME_DWELL_MS'),
  'wifi_manager_scan should use the AP stability dwell constant',
);

assert.ok(
  !/\.home_chan_dwell_time\s*=\s*30\b/.test(manualScan),
  'wifi_manager_scan should not use the minimum 30ms home-channel dwell during APSTA scans',
);
