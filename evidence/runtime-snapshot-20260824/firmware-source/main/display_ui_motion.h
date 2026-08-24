#ifndef DISPLAY_UI_MOTION_H
#define DISPLAY_UI_MOTION_H

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    DISPLAY_UI_MOTION_VIEW_HOME,
    DISPLAY_UI_MOTION_VIEW_MENU,
    DISPLAY_UI_MOTION_VIEW_OVERLAY,
} display_ui_motion_view_t;

typedef enum {
    DISPLAY_UI_MOTION_SLIDE_BACK = -1,
    DISPLAY_UI_MOTION_SLIDE_NONE = 0,
    DISPLAY_UI_MOTION_SLIDE_FORWARD = 1,
} display_ui_motion_slide_t;

typedef enum {
    DISPLAY_UI_MOTION_CURSOR_NONE,
    DISPLAY_UI_MOTION_CURSOR_HIDE,
    DISPLAY_UI_MOTION_CURSOR_SNAP,
    DISPLAY_UI_MOTION_CURSOR_ANIMATE,
} display_ui_motion_cursor_t;

typedef struct {
    bool initialized;
    display_ui_motion_view_t view;
    uint8_t page;
    uint8_t depth;
    int8_t cursor_row;
} display_ui_motion_state_t;

typedef struct {
    display_ui_motion_slide_t slide;
    display_ui_motion_cursor_t cursor;
    int8_t cursor_row;
} display_ui_motion_result_t;

display_ui_motion_result_t display_ui_motion_step(
    display_ui_motion_state_t *state,
    display_ui_motion_view_t view,
    uint8_t page,
    uint8_t depth,
    int8_t cursor_row);

int32_t display_ui_motion_slide_start(display_ui_motion_slide_t slide,
                                      int32_t current_x,
                                      int32_t offset);

#endif /* DISPLAY_UI_MOTION_H */
