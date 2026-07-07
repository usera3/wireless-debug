import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/wifi_manager.c'), 'utf8');

assert.ok(
  source.includes('#define WIFI_MANAGER_SCAN_HOME_DWELL_MS 150'),
  'APSTA scan should dwell on the AP home channel for 150ms so clients keep receiving beacons',
);

assert.ok(
  source.includes('.home_chan_dwell_time = WIFI_MANAGER_SCAN_HOME_DWELL_MS'),
  'wifi_manager_scan should use the AP stability dwell constant',
);

assert.ok(
  !/\.home_chan_dwell_time\s*=\s*30\b/.test(source),
  'wifi_manager_scan should not use the minimum 30ms home-channel dwell during APSTA scans',
);
