import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const buildDir = mkdtempSync(join(tmpdir(), 'oled-motion-'));
const testBin = join(buildDir, 'display_ui_motion_test');

try {
  const compile = spawnSync('cc', [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-I', resolve(root, 'main'),
    resolve(root, 'tests/display_ui_motion_test.c'),
    resolve(root, 'main/display_ui_motion.c'),
    '-o', testBin,
  ], { encoding: 'utf8' });

  assert.equal(compile.status, 0, `motion test compile failed:\n${compile.stderr}`);

  const run = spawnSync(testBin, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, `motion behavior test failed:\n${run.stderr}`);

  const displayUi = readFileSync(resolve(root, 'main/display_ui.c'), 'utf8');
  const displayLvgl = readFileSync(resolve(root, 'main/display_lvgl.c'), 'utf8');
  assert.ok(displayUi.includes('display_ui_motion_step('),
    'display_ui must drive animations through the tested motion policy');
  assert.ok(/lv_obj_set_style_blend_mode\([^;]+LV_BLEND_MODE_DIFFERENCE/.test(displayUi),
    'menu cursor must invert underlying monochrome pixels while it moves');
  assert.ok(/lv_anim_set_path_cb\([^;]+lv_anim_path_ease_out/.test(displayUi),
    'menu movement must use an ease-out path');

  const cursorDuration = displayUi.match(/#define\s+UI_CURSOR_ANIM_MS\s+(\d+)/);
  const pageDuration = displayUi.match(/#define\s+UI_PAGE_ANIM_MS\s+(\d+)/);
  assert.ok(cursorDuration, 'cursor animation duration must be explicit');
  assert.ok(pageDuration, 'page animation duration must be explicit');
  assert.ok(Number(cursorDuration[1]) >= 160 && Number(cursorDuration[1]) <= 220,
    'cursor animation must stay in the responsive 160-220 ms range');
  assert.ok(Number(pageDuration[1]) >= 160 && Number(pageDuration[1]) <= 220,
    'page animation must stay in the responsive 160-220 ms range');

  assert.ok(displayLvgl.includes('#define LVGL_TASK_MIN_WAIT_MS 5'),
    'LVGL task must define a bounded active-animation wait');
  assert.ok(displayLvgl.includes('#define LVGL_TASK_MAX_WAIT_MS 20'),
    'LVGL task must retain the existing idle wait ceiling');
  assert.ok(/wait_ms\s*=\s*lv_timer_handler\(\)/.test(displayLvgl),
    'LVGL task must schedule its next run from lv_timer_handler');
  assert.ok(/vTaskDelay\(pdMS_TO_TICKS\(wait_ms\)\)/.test(displayLvgl),
    'LVGL task must sleep for the bounded handler wait');
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
