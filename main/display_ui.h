#ifndef DISPLAY_UI_H
#define DISPLAY_UI_H

#include <stdbool.h>
#include <stdint.h>
#include "comm_stats.h"
#include "lvgl.h"
#include "system_menu.h"

#ifndef DISPLAY_WIDTH
#define DISPLAY_WIDTH 128
#endif

#ifndef DISPLAY_HEIGHT
#define DISPLAY_HEIGHT 64
#endif

typedef struct {
    char mode[12];
    char status[32];
    char firmware[24];
    char ssid[32];
    char wifi_ap_ip[16];
    char wifi_sta_ip[16];
    bool wifi_sta_connecting;
    bool wifi_sta_connected;
    uint32_t baud;
    uint32_t uptime_s;
    uint32_t heap_internal_kb;
    uint32_t heap_min_internal_kb;
    uint32_t heap_largest_kb;
    int ble_ready;
    uint32_t update_count;
    comm_stats_snapshot_t stats;
    bool overlay_active;
    char overlay_title[32];
    char overlay_lines[4][32];
    char overlay_footer[32];
    bool overlay_scroll;
    uint32_t overlay_scroll_tick;
    char overlay_text[512];
    system_menu_snapshot_t menu;
} display_ui_state_t;

void display_ui_build(lv_obj_t *screen);
void display_ui_update(const display_ui_state_t *state);

#endif /* DISPLAY_UI_H */
