import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/display_port.h'), 'utf8');
const driver = readFileSync(resolve(process.cwd(), 'main/display_port.c'), 'utf8');
const speed = source.match(/#define\s+DISPLAY_SSD1315_I2C_HZ\s+(\d+)/);

assert.ok(speed, 'display_port.h must define the SSD1315 I2C clock');
assert.equal(
  Number(speed[1]),
  400000,
  'SSD1315 I2C clock must use 400 kHz fast mode for smooth OLED refresh',
);

assert.ok(driver.includes('#define SSD1315_TX_CHUNK_BYTES 128'),
  'SSD1315 writes must batch a complete 128-byte page per transaction');
