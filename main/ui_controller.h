#ifndef UI_CONTROLLER_H
#define UI_CONTROLLER_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "system_menu.h"

typedef struct {
    bool (*wifi_has_sta_config)(void *ctx);
    void (*wifi_schedule_net_mode)(system_net_mode_t mode, void *ctx);
    esp_err_t (*wifi_clear_sta_config)(void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    bool (*ble_is_started)(void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    void (*log_heap)(const char *label, void *ctx);
    void *ctx;
} ui_controller_config_t;

esp_err_t ui_controller_init(const ui_controller_config_t *config);
void ui_controller_apply_menu_action(system_menu_action_t action);

#endif /* UI_CONTROLLER_H */
