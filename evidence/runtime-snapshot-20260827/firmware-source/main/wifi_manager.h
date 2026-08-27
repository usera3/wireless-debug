#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "system_menu.h"

#define WIFI_MANAGER_SCAN_MAX_APS 8
#define WIFI_MANAGER_QUICK_PASSWORD "12345678"
#define WIFI_MANAGER_AP_IP "192.168.4.1"

typedef struct {
    system_net_mode_t mode;
    char ap_ssid[33];
    char ap_ip[16];
    char sta_ssid[33];
    char sta_ip[16];
    bool sta_configured;
    bool sta_connecting;
    bool sta_connected;
} wifi_manager_status_t;

typedef struct {
    char ssid[33];
    int8_t rssi;
    uint8_t authmode;
    bool saved;
} wifi_manager_scan_ap_t;

typedef struct {
    void (*on_net_mode)(system_net_mode_t mode, void *ctx);
    void (*on_message)(const char *message, void *ctx);
    void (*on_wifi_label)(const char *label, void *ctx);
    void (*on_wifi_state)(const wifi_manager_status_t *status, void *ctx);
    void (*on_status)(const char *status, void *ctx);
    void *ctx;
} wifi_manager_config_t;

esp_err_t wifi_manager_init(const wifi_manager_config_t *config);
bool wifi_manager_has_sta_config(void);
esp_err_t wifi_manager_save_sta_config(const char *ssid, const char *password);
esp_err_t wifi_manager_clear_sta_config(void);
bool wifi_manager_get_saved_sta_config(char *ssid, size_t ssid_size,
                                       char *password, size_t password_size);
esp_err_t wifi_manager_scan(wifi_manager_scan_ap_t *out, size_t capacity,
                            size_t *out_count);
esp_err_t wifi_manager_connect_sta(const char *ssid, const char *password,
                                   bool save_on_success);
esp_err_t wifi_manager_connect_sta_for_mode(const char *ssid, const char *password,
                                            bool save_on_success,
                                            system_net_mode_t target_mode);
esp_err_t wifi_manager_schedule_connect_sta(const char *ssid, const char *password,
                                            bool save_on_success,
                                            uint32_t delay_ms);
esp_err_t wifi_manager_schedule_connect_sta_for_mode(const char *ssid,
                                                     const char *password,
                                                     bool save_on_success,
                                                     uint32_t delay_ms,
                                                     system_net_mode_t target_mode);
esp_err_t wifi_manager_quick_connect(const char *ssid);
esp_err_t wifi_manager_quick_connect_for_mode(const char *ssid,
                                              system_net_mode_t target_mode);
esp_err_t wifi_manager_begin_web_setup(system_net_mode_t target_mode);
void wifi_manager_schedule_net_mode(system_net_mode_t mode);
esp_err_t wifi_manager_request_net_mode(system_net_mode_t mode);
void wifi_manager_get_status(wifi_manager_status_t *out);

#endif /* WIFI_MANAGER_H */
