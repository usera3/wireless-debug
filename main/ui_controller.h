#ifndef UI_CONTROLLER_H
#define UI_CONTROLLER_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "system_menu.h"
#include "wifi_manager.h"

typedef struct {
    bool (*wifi_has_sta_config)(void *ctx);
    void (*wifi_get_status)(wifi_manager_status_t *out, void *ctx);
    void (*wifi_schedule_net_mode)(system_net_mode_t mode, void *ctx);
    esp_err_t (*wifi_clear_sta_config)(void *ctx);
    esp_err_t (*wifi_scan)(wifi_manager_scan_ap_t *out, size_t capacity,
                           size_t *out_count, void *ctx);
    esp_err_t (*wifi_quick_connect_for_mode)(const char *ssid,
                                             system_net_mode_t target_mode,
                                             void *ctx);
    esp_err_t (*wifi_begin_web_setup)(system_net_mode_t target_mode, void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    bool (*ble_is_started)(void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    void (*log_heap)(const char *label, void *ctx);
    void *ctx;
} ui_controller_config_t;

esp_err_t ui_controller_init(const ui_controller_config_t *config);
esp_err_t ui_controller_apply_menu_action(system_menu_action_t action,
                                          system_action_source_t source);

#endif /* UI_CONTROLLER_H */
