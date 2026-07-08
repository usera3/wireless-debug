#ifndef CLOUD_MQTT_H
#define CLOUD_MQTT_H

#include <stdbool.h>
#include <stdint.h>
#include "app_core.h"
#include "esp_err.h"
#include "system_menu.h"
#include "wifi_manager.h"

typedef struct {
    const char *device_id;
    const char *mqtt_uri;
    bool enabled;
} cloud_mqtt_config_t;

typedef struct {
    esp_err_t (*set_wifi_mode)(system_net_mode_t mode, void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    esp_err_t (*set_comm_mode)(app_comm_mode_t mode, void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    esp_err_t (*display_text)(const char *text, void *ctx);
    void (*get_wifi_status)(wifi_manager_status_t *out, void *ctx);
    uint32_t (*get_uart_baud)(void *ctx);
    app_comm_mode_t (*get_comm_mode)(void *ctx);
    bool (*ble_is_started)(void *ctx);
    bool (*ble_has_subscribers)(void *ctx);
    bool (*wifi_ws_client_connected)(void *ctx);
    void *ctx;
} cloud_mqtt_runtime_t;

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime);
void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status);
void cloud_mqtt_publish_status_now(void);

#endif /* CLOUD_MQTT_H */
