#include "display_ui_motion.h"

#include <stddef.h>

static display_ui_motion_slide_t page_slide_direction(
    const display_ui_motion_state_t *state,
    uint8_t page,
    uint8_t depth)
{
    if (depth > state->depth) {
        return DISPLAY_UI_MOTION_SLIDE_FORWARD;
    }
    if (depth < state->depth) {
        return DISPLAY_UI_MOTION_SLIDE_BACK;
    }
    return page > state->page ? DISPLAY_UI_MOTION_SLIDE_FORWARD
                              : DISPLAY_UI_MOTION_SLIDE_BACK;
}

static display_ui_motion_slide_t view_slide_direction(
    display_ui_motion_view_t from,
    display_ui_motion_view_t to)
{
    if ((from == DISPLAY_UI_MOTION_VIEW_HOME &&
         to == DISPLAY_UI_MOTION_VIEW_MENU) ||
        (from == DISPLAY_UI_MOTION_VIEW_MENU &&
         to == DISPLAY_UI_MOTION_VIEW_OVERLAY)) {
        return DISPLAY_UI_MOTION_SLIDE_FORWARD;
    }
    if ((from == DISPLAY_UI_MOTION_VIEW_OVERLAY &&
         to == DISPLAY_UI_MOTION_VIEW_MENU) ||
        (from == DISPLAY_UI_MOTION_VIEW_MENU &&
         to == DISPLAY_UI_MOTION_VIEW_HOME)) {
        return DISPLAY_UI_MOTION_SLIDE_BACK;
    }
    return DISPLAY_UI_MOTION_SLIDE_NONE;
}

display_ui_motion_result_t display_ui_motion_step(
    display_ui_motion_state_t *state,
    display_ui_motion_view_t view,
    uint8_t page,
    uint8_t depth,
    int8_t cursor_row)
{
    display_ui_motion_result_t result = {
        .slide = DISPLAY_UI_MOTION_SLIDE_NONE,
        .cursor = DISPLAY_UI_MOTION_CURSOR_NONE,
        .cursor_row = cursor_row,
    };

    if (state == NULL) {
        result.cursor = DISPLAY_UI_MOTION_CURSOR_HIDE;
        return result;
    }

    if (cursor_row < 0) {
        cursor_row = -1;
        result.cursor_row = -1;
    }

    if (!state->initialized) {
        result.cursor = view == DISPLAY_UI_MOTION_VIEW_MENU && cursor_row >= 0
                            ? DISPLAY_UI_MOTION_CURSOR_SNAP
                            : DISPLAY_UI_MOTION_CURSOR_HIDE;
        state->initialized = true;
    } else {
        bool was_menu = state->view == DISPLAY_UI_MOTION_VIEW_MENU;
        bool is_menu = view == DISPLAY_UI_MOTION_VIEW_MENU;
        bool page_changed = was_menu && is_menu && page != state->page;

        if (view != state->view) {
            result.slide = view_slide_direction(state->view, view);
        } else if (page_changed) {
            result.slide = page_slide_direction(state, page, depth);
        }

        if (!is_menu || cursor_row < 0) {
            result.cursor = DISPLAY_UI_MOTION_CURSOR_HIDE;
        } else if (!was_menu || page_changed || state->cursor_row < 0) {
            result.cursor = DISPLAY_UI_MOTION_CURSOR_SNAP;
        } else if (cursor_row != state->cursor_row) {
            result.cursor = DISPLAY_UI_MOTION_CURSOR_ANIMATE;
        }
    }

    state->view = view;
    state->page = page;
    state->depth = depth;
    state->cursor_row = cursor_row;
    return result;
}

int32_t display_ui_motion_slide_start(display_ui_motion_slide_t slide,
                                      int32_t current_x,
                                      int32_t offset)
{
    if (current_x != 0 || slide == DISPLAY_UI_MOTION_SLIDE_NONE) {
        return current_x;
    }
    if (offset < 0) {
        offset = -offset;
    }
    return slide == DISPLAY_UI_MOTION_SLIDE_FORWARD ? offset : -offset;
}
