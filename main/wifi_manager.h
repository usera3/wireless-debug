#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <stdbool.h>
#include "esp_err.h"
#include "system_menu.h"

typedef struct {
    system_net_mode_t mode;
    char ap_ssid[33];
    char sta_ssid[33];
    char sta_ip[16];
    bool sta_configured;
    bool sta_connecting;
    bool sta_connected;
} wifi_manager_status_t;

typedef struct {
    void (*on_net_mode)(system_net_mode_t mode, void *ctx);
    void (*on_message)(const char *message, void *ctx);
    void (*on_wifi_label)(const char *label, void *ctx);
    void (*on_status)(const char *status, void *ctx);
    void *ctx;
} wifi_manager_config_t;

esp_err_t wifi_manager_init(const wifi_manager_config_t *config);
bool wifi_manager_has_sta_config(void);
esp_err_t wifi_manager_save_sta_config(const char *ssid, const char *password);
esp_err_t wifi_manager_clear_sta_config(void);
void wifi_manager_schedule_net_mode(system_net_mode_t mode);
esp_err_t wifi_manager_request_net_mode(system_net_mode_t mode);
void wifi_manager_get_status(wifi_manager_status_t *out);

#endif /* WIFI_MANAGER_H */
