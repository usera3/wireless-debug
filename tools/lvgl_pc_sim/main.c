#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <SDL2/SDL.h>
#include "display_ui.h"
#include "lvgl.h"
#include "src/drivers/sdl/lv_sdl_window.h"

#define SIM_SCALE 6

static display_ui_state_t s_state = {
    .mode = "IDLE",
    .status = "boot",
    .ssid = "ESP32-S3_AP_8951",
    .baud = 2000000,
    .ble_ready = 1,
    .update_count = 6,
};

static void sync_menu_snapshot(void)
{
    system_menu_get_snapshot(&s_state.menu);
}

static void set_demo_state(uint32_t tick)
{
    s_state.update_count = 6 + tick;

    switch ((tick / 180) % 4) {
    case 0:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "IDLE");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "lvgl_on");
        s_state.ble_ready = 1;
        break;
    case 1:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "WIFI");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "ws_rx");
        s_state.ble_ready = 1;
        break;
    case 2:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "BLE");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "ble_rx");
        s_state.ble_ready = 1;
        break;
    default:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "WIFI");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "auto");
        s_state.ble_ready = 0;
        break;
    }
    sync_menu_snapshot();
}

static void apply_sim_action(system_menu_action_t action)
{
    switch (action) {
    case SYSTEM_ACTION_COMM_AUTO:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "AUTO");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "menu_auto");
        system_menu_set_comm_mode(SYSTEM_COMM_AUTO);
        break;
    case SYSTEM_ACTION_COMM_WIFI:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "WIFI");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "menu_wifi");
        system_menu_set_comm_mode(SYSTEM_COMM_WIFI);
        break;
    case SYSTEM_ACTION_COMM_BLE:
        snprintf(s_state.mode, sizeof(s_state.mode), "%s", "BLE");
        snprintf(s_state.status, sizeof(s_state.status), "%s", "menu_ble");
        system_menu_set_comm_mode(SYSTEM_COMM_BLE);
        break;
    case SYSTEM_ACTION_NET_AP:
        snprintf(s_state.status, sizeof(s_state.status), "%s", "menu_ap");
        system_menu_set_net_mode(SYSTEM_NET_AP);
        system_menu_set_message("AP MODE READY");
        break;
    case SYSTEM_ACTION_NET_STA:
        snprintf(s_state.status, sizeof(s_state.status), "%s", "sta_need_cfg");
        system_menu_set_net_mode(SYSTEM_NET_STA);
        system_menu_set_message("STA NEED CFG");
        break;
    case SYSTEM_ACTION_NONE:
    default:
        break;
    }
}

static bool handle_sdl_key(SDL_Keycode key)
{
    system_key_t menu_key;

    switch (key) {
    case SDLK_UP:
    case SDLK_DOWN:
    case SDLK_LEFT:
    case SDLK_RIGHT:
    case SDLK_n:
        menu_key = SYSTEM_KEY_NEXT;
        break;
    case SDLK_RETURN:
    case SDLK_KP_ENTER:
        menu_key = SYSTEM_KEY_OK;
        break;
    case SDLK_ESCAPE:
    case SDLK_BACKSPACE:
        menu_key = SYSTEM_KEY_BACK;
        break;
    default:
        return false;
    }

    system_menu_action_t action = system_menu_handle_key(menu_key);
    apply_sim_action(action);
    s_state.update_count++;
    sync_menu_snapshot();
    display_ui_update(&s_state);
    return true;
}

int main(void)
{
    lv_init();
    system_menu_init();
    system_menu_set_net_mode(SYSTEM_NET_AP);
    system_menu_set_comm_mode(SYSTEM_COMM_AUTO);
    system_menu_set_uart_baud(s_state.baud);
    system_menu_set_ble_ready(s_state.ble_ready != 0);

    lv_display_t *display = lv_sdl_window_create(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    if (display == NULL) {
        fprintf(stderr, "Failed to create LVGL SDL window\n");
        return 1;
    }
    lv_sdl_window_set_title(display, "ESP32-S3 SSD1315 LVGL OLED Preview");
    lv_sdl_window_set_resizeable(display, false);
    lv_sdl_window_set_zoom(display, SIM_SCALE);

    display_ui_build(lv_screen_active());
    sync_menu_snapshot();
    display_ui_update(&s_state);

    uint32_t tick = 0;
    bool running = true;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) {
                running = false;
            } else if (event.type == SDL_KEYDOWN && !event.key.repeat) {
                handle_sdl_key(event.key.keysym.sym);
            }
        }

        uint32_t wait_ms = lv_timer_handler();
        if (wait_ms > 20) {
            wait_ms = 20;
        }
        SDL_Delay(wait_ms);

        tick++;
        if (!s_state.menu.active && (tick % 30) == 0) {
            set_demo_state(tick);
            display_ui_update(&s_state);
        }
    }

    return 0;
}
