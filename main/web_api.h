#ifndef WEB_API_H
#define WEB_API_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_http_server.h"
#include "system_menu.h"
#include "wifi_manager.h"

typedef struct {
    uint32_t (*get_uart_baud)(void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    esp_err_t (*send_uart_frame)(const uint8_t *data, size_t len, void *ctx);
    esp_err_t (*apply_menu_action)(system_menu_action_t action,
                                   system_action_source_t source,
                                   void *ctx);
    void (*get_wifi_status)(wifi_manager_status_t *out, void *ctx);
    esp_err_t (*save_wifi_sta_config)(const char *ssid, const char *password, void *ctx);
    esp_err_t (*clear_wifi_sta_config)(void *ctx);
    esp_err_t (*wifi_scan)(wifi_manager_scan_ap_t *out, size_t capacity,
                           size_t *out_count, void *ctx);
    esp_err_t (*wifi_connect_sta)(const char *ssid, const char *password,
                                  bool save_on_success, void *ctx);
    void (*request_wifi_net_mode)(system_net_mode_t mode, void *ctx);
    bool (*wifi_client_connected)(void *ctx);
    bool (*ble_is_started)(void *ctx);
    bool (*ble_has_subscribers)(void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    size_t (*send_ble_frame)(const uint8_t *data, size_t len, void *ctx);
    void *ctx;
} web_api_context_t;

esp_err_t web_api_register_handlers(httpd_handle_t server, const web_api_context_t *ctx);

#endif /* WEB_API_H */
