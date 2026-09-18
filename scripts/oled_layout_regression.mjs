import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'main/display_ui.c'), 'utf8');

const menuView = source.match(/static void update_menu_view[\s\S]*?\n}\n\nstatic void update_overlay_view/);
assert.ok(menuView, 'display_ui.c must contain update_menu_view before update_overlay_view');
assert.ok(
  /static void update_menu_view[\s\S]*?\{\s*const system_menu_snapshot_t \*menu = &state->menu;\s*set_standard_layout\(\);/.test(source),
  'menu view must always restore the standard row layout after the home screen moved rows',
);
assert.ok(
  !/static void update_menu_view[\s\S]*?if \(s_overlay_text_layout\) \{\s*set_standard_layout\(\);[\s\S]*?\}/.test(menuView[0]),
  'menu view must not restore standard layout only for overlay text transitions',
);

const overlayView = source.match(/static void update_overlay_view[\s\S]*?\n}\n\nvoid display_ui_build/);
assert.ok(overlayView, 'display_ui.c must contain update_overlay_view before display_ui_build');
assert.ok(
  /if \(state->overlay_scroll && state->overlay_text\[0\] != '\\0'\)[\s\S]*?return;[\s\S]*?set_standard_layout\(\);/.test(overlayView[0]),
  'non-scrolling overlay view must also restore standard row layout after home layout',
);
