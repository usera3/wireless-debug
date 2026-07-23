#ifndef CLOUD_MQTT_H
#define CLOUD_MQTT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "app_core.h"
#include "comm_stats.h"
#include "display_port.h"
#include "esp_err.h"
#include "system_menu.h"
#include "wifi_manager.h"

typedef struct {
    const char *device_id;
    const char *device_mac;
    const char *mqtt_uri;
    bool enabled;
} cloud_mqtt_config_t;

typedef struct {
    esp_err_t (*set_wifi_mode)(system_net_mode_t mode, void *ctx);
    esp_err_t (*set_uart_baud)(uint32_t baud, void *ctx);
    esp_err_t (*set_comm_mode)(app_comm_mode_t mode, void *ctx);
    esp_err_t (*ble_start)(void *ctx);
    esp_err_t (*display_text)(const char *text, void *ctx);
    esp_err_t (*send_ws_frame)(const uint8_t *data, size_t len, void *ctx);
    void (*get_wifi_status)(wifi_manager_status_t *out, void *ctx);
    uint32_t (*get_uart_baud)(void *ctx);
    app_comm_mode_t (*get_comm_mode)(void *ctx);
    bool (*ble_is_started)(void *ctx);
    bool (*ble_has_subscribers)(void *ctx);
    bool (*wifi_ws_client_connected)(void *ctx);
    void (*get_comm_stats)(comm_stats_snapshot_t *out, void *ctx);
    void (*get_display_stats)(display_port_stats_t *out, void *ctx);
    void (*get_menu_snapshot)(system_menu_snapshot_t *out, void *ctx);
    uint32_t (*get_motor_param_count)(void *ctx);
    uint32_t (*get_motor_param_capacity)(void *ctx);
    void *ctx;
} cloud_mqtt_runtime_t;

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime);
void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status);
void cloud_mqtt_publish_status_now(void);
void cloud_mqtt_publish_ws_frame(const uint8_t *data, size_t len);
void cloud_mqtt_note_realtime_control(const uint8_t *data, size_t len);
bool cloud_mqtt_publish_ws_fallback(const uint8_t *data, size_t len, void *ctx);

#endif /* CLOUD_MQTT_H */
