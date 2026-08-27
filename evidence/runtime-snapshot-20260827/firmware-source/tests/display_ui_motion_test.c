#include <assert.h>
#include <stdint.h>

#include "display_ui_motion.h"

static display_ui_motion_result_t step(display_ui_motion_state_t *state,
                                       display_ui_motion_view_t view,
                                       uint8_t page,
                                       uint8_t depth,
                                       int8_t cursor_row)
{
    return display_ui_motion_step(state, view, page, depth, cursor_row);
}

int main(void)
{
    display_ui_motion_state_t state = {0};
    display_ui_motion_result_t result;

    result = step(&state, DISPLAY_UI_MOTION_VIEW_HOME, 0, 0, -1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_NONE);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_HIDE);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_FORWARD);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_SNAP);
    assert(result.cursor_row == 0);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_NONE);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_ANIMATE);
    assert(result.cursor_row == 1);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_NONE);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_NONE);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 1, 1, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_FORWARD);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_SNAP);

    /* Some nested pages currently share a reported depth. Their stable page
       ordering still distinguishes entering from returning. */
    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 2, 1, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_FORWARD);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 1, 1, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_BACK);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_BACK);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, -1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_NONE);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_HIDE);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 0);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_SNAP);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_OVERLAY, 0, 0, -1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_FORWARD);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_HIDE);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_MENU, 0, 0, 0);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_BACK);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_SNAP);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_HOME, 0, 0, -1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_BACK);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_HIDE);

    result = step(&state, DISPLAY_UI_MOTION_VIEW_OVERLAY, 0, 0, -1);
    assert(result.slide == DISPLAY_UI_MOTION_SLIDE_NONE);
    assert(result.cursor == DISPLAY_UI_MOTION_CURSOR_HIDE);

    assert(display_ui_motion_slide_start(DISPLAY_UI_MOTION_SLIDE_FORWARD, 0, 24) == 24);
    assert(display_ui_motion_slide_start(DISPLAY_UI_MOTION_SLIDE_BACK, 0, 24) == -24);
    assert(display_ui_motion_slide_start(DISPLAY_UI_MOTION_SLIDE_FORWARD, 12, 24) == 12);
    assert(display_ui_motion_slide_start(DISPLAY_UI_MOTION_SLIDE_BACK, 12, 24) == 12);
    assert(display_ui_motion_slide_start(DISPLAY_UI_MOTION_SLIDE_FORWARD, -8, 24) == -8);

    return 0;
}
