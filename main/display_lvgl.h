#ifndef DISPLAY_LVGL_H
#define DISPLAY_LVGL_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "system_menu.h"

esp_err_t display_lvgl_start(void);
void display_lvgl_set_mode(const char *mode);
void display_lvgl_set_status(const char *status);
void display_lvgl_set_uart_baud(uint32_t baud);
void display_lvgl_set_wifi_ssid(const char *ssid);
void display_lvgl_set_wifi_state(system_net_mode_t mode, const char *ap_ip,
                                 const char *sta_ip, bool sta_connecting,
                                 bool sta_connected);
void display_lvgl_set_ble_ready(int ready);
void display_lvgl_set_text_screen(const char *title, const char *line1,
                                   const char *line2, const char *line3,
                                   const char *line4, const char *footer);
void display_lvgl_set_text_scroll(const char *title, const char *text, const char *footer);
bool display_lvgl_clear_text_screen(void);
void display_lvgl_request_redraw(void);

#endif /* DISPLAY_LVGL_H */
