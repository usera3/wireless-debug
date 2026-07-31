#include "wifi_manager.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

#define WIFI_MANAGER_PASS WIFI_MANAGER_QUICK_PASSWORD
#define WIFI_MANAGER_CHANNEL 1
#define WIFI_MANAGER_MAX_STA_CONN 4
#define WIFI_MANAGER_STA_CONNECT_TIMEOUT_MS 10000
#define WIFI_MANAGER_STA_NVS_NAMESPACE "wifi_sta"
#define WIFI_MANAGER_STA_NVS_SSID_KEY "ssid"
#define WIFI_MANAGER_STA_NVS_PASS_KEY "pass"
#define WIFI_MANAGER_DEFAULT_STA_SSID "vivo X300"
#define WIFI_MANAGER_DEFAULT_STA_PASS "88888888"
#define WIFI_MANAGER_START_STA_ON_BOOT 1
#define WIFI_MANAGER_SCAN_HOME_DWELL_MS 150
#define WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS 1000
#define WIFI_MANAGER_AUTO_SCAN_STA_MS 30000
#define WIFI_MANAGER_AUTO_SCAN_APSTA_MS 60000
#define WIFI_MANAGER_AUTO_SCAN_CHANNEL_GAP_MS 5000
#define WIFI_MANAGER_AUTO_SCAN_BACKOFF_AFTER 5
#define WIFI_MANAGER_AUTO_SCAN_MAX_MS 120000
#define WIFI_MANAGER_COUNTRY_CODE "CN"

static const char *TAG = "wifi_manager";
static const uint8_t s_auto_scan_channels[] = {
    1, 6, 11, 2, 3, 4, 5, 7, 8, 9, 10, 12, 13,
};

static wifi_manager_config_t s_config;
static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;
static SemaphoreHandle_t s_mode_mutex;
static portMUX_TYPE s_auto_scan_state_lock = portMUX_INITIALIZER_UNLOCKED;
static esp_timer_handle_t s_sta_fallback_timer;
static esp_timer_handle_t s_auto_scan_timer;
static system_net_mode_t s_net_mode = SYSTEM_NET_APSTA;
static system_net_mode_t s_connect_target_mode = SYSTEM_NET_APSTA;
static bool s_driver_started;
static bool s_sta_connecting;
static bool s_sta_connected;
static bool s_auto_scan_task_running;
static uint8_t s_auto_scan_failures;
static uint8_t s_auto_scan_channel_index;
static uint8_t s_ap_client_count;
static bool s_auto_scan_in_progress;
static bool s_auto_scan_cancel_requested;
static bool s_auto_scan_started;
static bool s_save_sta_on_connect;
static bool s_restore_sta_on_fail;
static char s_ap_ssid[33];
static char s_sta_ssid[33];
static char s_sta_pass[65];
static char s_pending_save_ssid[33];
static char s_pending_save_pass[65];
static char s_restore_sta_ssid[33];
static char s_restore_sta_pass[65];
static char s_sta_ip[16] = "-";

static void schedule_auto_scan_locked(uint32_t delay_ms);
static void stop_auto_scan_locked(void);
static void auto_scan_timer_cb(void *arg);
static void auto_scan_task(void *arg);

static void report_net_mode(system_net_mode_t mode)
{
    if (s_config.on_net_mode != NULL) {
        s_config.on_net_mode(mode, s_config.ctx);
    }
}

static void report_message(const char *message)
{
    if (s_config.on_message != NULL) {
        s_config.on_message(message, s_config.ctx);
    }
}

static void report_wifi_label(const char *label)
{
    if (s_config.on_wifi_label != NULL) {
        s_config.on_wifi_label(label, s_config.ctx);
    }
}

static void report_status(const char *status)
{
    if (s_config.on_status != NULL) {
        s_config.on_status(status, s_config.ctx);
    }
}

static void make_status_locked(wifi_manager_status_t *out)
{
    if (out == NULL) {
        return;
    }
    memset(out, 0, sizeof(*out));
    out->mode = s_net_mode;
    snprintf(out->ap_ssid, sizeof(out->ap_ssid), "%s", s_ap_ssid);
    snprintf(out->ap_ip, sizeof(out->ap_ip), "%s", WIFI_MANAGER_AP_IP);
    snprintf(out->sta_ssid, sizeof(out->sta_ssid), "%s", s_sta_ssid);
    snprintf(out->sta_ip, sizeof(out->sta_ip), "%s", s_sta_ip);
    out->sta_configured = s_sta_ssid[0] != '\0';
    out->sta_connecting = s_sta_connecting;
    out->sta_connected = s_sta_connected;
}

static void report_wifi_state_locked(void)
{
    if (s_config.on_wifi_state != NULL) {
        wifi_manager_status_t status;
        make_status_locked(&status);
        s_config.on_wifi_state(&status, s_config.ctx);
    }
}

static bool lock_mode(TickType_t ticks)
{
    return s_mode_mutex != NULL && xSemaphoreTake(s_mode_mutex, ticks) == pdTRUE;
}

static void unlock_mode(void)
{
    if (s_mode_mutex != NULL) {
        xSemaphoreGive(s_mode_mutex);
    }
}

static bool auto_scan_ap_service_active_locked(void)
{
    return s_net_mode == SYSTEM_NET_AP || s_net_mode == SYSTEM_NET_APSTA;
}

static uint8_t ap_client_count(void)
{
    uint8_t count;
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    count = s_ap_client_count;
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return count;
}

static bool note_ap_client_connected(void)
{
    bool stop_auto_scan = false;
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    if (s_ap_client_count < UINT8_MAX) {
        s_ap_client_count++;
    }
    if (s_auto_scan_in_progress) {
        s_auto_scan_cancel_requested = true;
        stop_auto_scan = s_auto_scan_started;
    }
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return stop_auto_scan;
}

static bool note_ap_client_disconnected(void)
{
    bool became_idle = false;
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    if (s_ap_client_count > 0) {
        s_ap_client_count--;
        became_idle = s_ap_client_count == 0;
    }
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return became_idle;
}

static bool auto_scan_begin_if_allowed(void)
{
    bool allowed;
    bool ap_service_active = auto_scan_ap_service_active_locked();
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    allowed = !ap_service_active || s_ap_client_count == 0;
    if (allowed) {
        s_auto_scan_in_progress = true;
        s_auto_scan_cancel_requested = false;
        s_auto_scan_started = false;
    }
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return allowed;
}

static bool auto_scan_mark_started(void)
{
    bool cancel_requested;
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    cancel_requested = s_auto_scan_cancel_requested;
    s_auto_scan_started = !cancel_requested;
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return cancel_requested;
}

static bool auto_scan_end(void)
{
    bool cancelled;
    portENTER_CRITICAL(&s_auto_scan_state_lock);
    cancelled = s_auto_scan_cancel_requested;
    s_auto_scan_in_progress = false;
    s_auto_scan_cancel_requested = false;
    s_auto_scan_started = false;
    portEXIT_CRITICAL(&s_auto_scan_state_lock);
    return cancelled;
}

static void clear_pending_save_locked(void)
{
    s_save_sta_on_connect = false;
    s_restore_sta_on_fail = false;
    s_pending_save_ssid[0] = '\0';
    s_pending_save_pass[0] = '\0';
    s_restore_sta_ssid[0] = '\0';
    s_restore_sta_pass[0] = '\0';
}

static void restore_pending_sta_config_locked(void)
{
    if (s_restore_sta_on_fail) {
        snprintf(s_sta_ssid, sizeof(s_sta_ssid), "%s", s_restore_sta_ssid);
        snprintf(s_sta_pass, sizeof(s_sta_pass), "%s", s_restore_sta_pass);
    }
    clear_pending_save_locked();
}

static esp_err_t configure_ap_netif_no_gateway(void)
{
    if (s_ap_netif == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t ret = esp_netif_dhcps_stop(s_ap_netif);
    if (ret != ESP_OK && ret != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) {
        return ret;
    }

    esp_netif_ip_info_t ip_info;
    ret = esp_netif_get_ip_info(s_ap_netif, &ip_info);
    if (ret != ESP_OK) {
        return ret;
    }
    ip_info.gw.addr = 0;
    ret = esp_netif_set_ip_info(s_ap_netif, &ip_info);
    if (ret != ESP_OK) {
        return ret;
    }

    esp_netif_dns_info_t dns_zero = {
        .ip = {
            .type = ESP_IPADDR_TYPE_V4,
            .u_addr.ip4.addr = 0,
        },
    };
    (void)esp_netif_set_dns_info(s_ap_netif, ESP_NETIF_DNS_MAIN, &dns_zero);
    (void)esp_netif_set_dns_info(s_ap_netif, ESP_NETIF_DNS_BACKUP, &dns_zero);
    (void)esp_netif_set_dns_info(s_ap_netif, ESP_NETIF_DNS_FALLBACK, &dns_zero);

    ret = esp_netif_dhcps_start(s_ap_netif);
    if (ret == ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) {
        return ESP_OK;
    }
    return ret;
}

bool wifi_manager_has_sta_config(void)
{
    return s_sta_ssid[0] != '\0';
}

bool wifi_manager_get_saved_sta_config(char *ssid, size_t ssid_size,
                                       char *password, size_t password_size)
{
    bool has_config = false;

    if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
        const char *cfg_ssid = s_restore_sta_on_fail ? s_restore_sta_ssid : s_sta_ssid;
        const char *cfg_pass = s_restore_sta_on_fail ? s_restore_sta_pass : s_sta_pass;
        has_config = cfg_ssid[0] != '\0';
        if (ssid != NULL && ssid_size > 0) {
            snprintf(ssid, ssid_size, "%s", cfg_ssid);
        }
        if (password != NULL && password_size > 0) {
            snprintf(password, password_size, "%s", cfg_pass);
        }
        unlock_mode();
        return has_config;
    }

    has_config = s_sta_ssid[0] != '\0';
    if (ssid != NULL && ssid_size > 0) {
        snprintf(ssid, ssid_size, "%s", s_sta_ssid);
    }
    if (password != NULL && password_size > 0) {
        snprintf(password, password_size, "%s", s_sta_pass);
    }
    return has_config;
}

static esp_err_t load_sta_config(void)
{
    s_sta_ssid[0] = '\0';
    s_sta_pass[0] = '\0';

    nvs_handle_t handle;
    esp_err_t ret = nvs_open(WIFI_MANAGER_STA_NVS_NAMESPACE, NVS_READONLY, &handle);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (ret != ESP_OK) {
        return ret;
    }

    size_t ssid_len = sizeof(s_sta_ssid);
    ret = nvs_get_str(handle, WIFI_MANAGER_STA_NVS_SSID_KEY, s_sta_ssid, &ssid_len);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        ret = ESP_OK;
        s_sta_ssid[0] = '\0';
    }
    if (ret == ESP_OK) {
        size_t pass_len = sizeof(s_sta_pass);
        esp_err_t pass_ret = nvs_get_str(handle, WIFI_MANAGER_STA_NVS_PASS_KEY, s_sta_pass, &pass_len);
        if (pass_ret == ESP_ERR_NVS_NOT_FOUND) {
            s_sta_pass[0] = '\0';
        } else if (pass_ret != ESP_OK) {
            ret = pass_ret;
        }
    }
    nvs_close(handle);

    if (ret == ESP_OK && s_sta_ssid[0] != '\0') {
        ESP_LOGI(TAG, "Loaded STA config for SSID: %s", s_sta_ssid);
    }
#if WIFI_MANAGER_START_STA_ON_BOOT
    if (ret == ESP_OK && s_sta_ssid[0] == '\0' &&
        WIFI_MANAGER_DEFAULT_STA_SSID[0] != '\0') {
        snprintf(s_sta_ssid, sizeof(s_sta_ssid), "%s", WIFI_MANAGER_DEFAULT_STA_SSID);
        snprintf(s_sta_pass, sizeof(s_sta_pass), "%s", WIFI_MANAGER_DEFAULT_STA_PASS);
        ESP_LOGI(TAG, "Using default STA config for SSID: %s", s_sta_ssid);
    }
#endif
    return ret;
}

esp_err_t wifi_manager_save_sta_config(const char *ssid, const char *password)
{
    if (ssid == NULL || ssid[0] == '\0' || strlen(ssid) > 32) {
        return ESP_ERR_INVALID_ARG;
    }
    if (password == NULL) {
        password = "";
    }
    if (strlen(password) > 64) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t ret = nvs_open(WIFI_MANAGER_STA_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = nvs_set_str(handle, WIFI_MANAGER_STA_NVS_SSID_KEY, ssid);
    if (ret == ESP_OK) {
        ret = nvs_set_str(handle, WIFI_MANAGER_STA_NVS_PASS_KEY, password);
    }
    if (ret == ESP_OK) {
        ret = nvs_commit(handle);
    }
    nvs_close(handle);

    if (ret == ESP_OK) {
        if (lock_mode(pdMS_TO_TICKS(100)) == pdTRUE) {
            snprintf(s_sta_ssid, sizeof(s_sta_ssid), "%s", ssid);
            snprintf(s_sta_pass, sizeof(s_sta_pass), "%s", password);
            s_auto_scan_failures = 0;
            schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
            unlock_mode();
        } else {
            snprintf(s_sta_ssid, sizeof(s_sta_ssid), "%s", ssid);
            snprintf(s_sta_pass, sizeof(s_sta_pass), "%s", password);
        }
    }
    return ret;
}

esp_err_t wifi_manager_clear_sta_config(void)
{
    nvs_handle_t handle;
    esp_err_t ret = nvs_open(WIFI_MANAGER_STA_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        ret = ESP_OK;
    } else if (ret == ESP_OK) {
        esp_err_t ssid_ret = nvs_erase_key(handle, WIFI_MANAGER_STA_NVS_SSID_KEY);
        esp_err_t pass_ret = nvs_erase_key(handle, WIFI_MANAGER_STA_NVS_PASS_KEY);
        if (ssid_ret != ESP_OK && ssid_ret != ESP_ERR_NVS_NOT_FOUND) {
            ret = ssid_ret;
        } else if (pass_ret != ESP_OK && pass_ret != ESP_ERR_NVS_NOT_FOUND) {
            ret = pass_ret;
        } else {
            ret = nvs_commit(handle);
        }
        nvs_close(handle);
    }

    if (ret == ESP_OK) {
        if (lock_mode(pdMS_TO_TICKS(100)) == pdTRUE) {
            s_sta_ssid[0] = '\0';
            s_sta_pass[0] = '\0';
            s_sta_connected = false;
            s_sta_connecting = false;
            clear_pending_save_locked();
            stop_auto_scan_locked();
            s_auto_scan_failures = 0;
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
            unlock_mode();
        } else {
            s_sta_ssid[0] = '\0';
            s_sta_pass[0] = '\0';
            s_sta_connected = false;
            s_sta_connecting = false;
            clear_pending_save_locked();
            stop_auto_scan_locked();
            s_auto_scan_failures = 0;
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
        }
    }
    return ret;
}

static void set_ap_state_locked(void)
{
    clear_pending_save_locked();
    s_net_mode = SYSTEM_NET_AP;
    s_connect_target_mode = SYSTEM_NET_AP;
    s_sta_connecting = false;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
}

static esp_err_t configure_ap_locked(void)
{
    wifi_config_t ap_config = {
        .ap = {
            .ssid_len = 0,
            .channel = WIFI_MANAGER_CHANNEL,
            .password = WIFI_MANAGER_PASS,
            .max_connection = WIFI_MANAGER_MAX_STA_CONN,
            .authmode = WIFI_AUTH_WPA_WPA2_PSK,
            .pmf_cfg = {
                .required = false,
            },
        },
    };
    strlcpy((char *)ap_config.ap.ssid, s_ap_ssid, sizeof(ap_config.ap.ssid));
    esp_err_t ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        return ret;
    }
    return esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
}

static esp_err_t configure_sta_locked(void)
{
    if (!wifi_manager_has_sta_config()) {
        return ESP_ERR_INVALID_STATE;
    }

    wifi_config_t sta_config = {0};
    strlcpy((char *)sta_config.sta.ssid, s_sta_ssid, sizeof(sta_config.sta.ssid));
    strlcpy((char *)sta_config.sta.password, s_sta_pass, sizeof(sta_config.sta.password));
    sta_config.sta.threshold.authmode = s_sta_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    sta_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;

    return esp_wifi_set_config(WIFI_IF_STA, &sta_config);
}

static esp_err_t ensure_wifi_started_locked(void)
{
    if (!s_driver_started) {
        esp_err_t ret = esp_wifi_start();
        if (ret != ESP_OK) {
            return ret;
        }
        s_driver_started = true;
    }
    return ESP_OK;
}

static void start_sta_retry_timer_locked(void)
{
    (void)esp_timer_stop(s_sta_fallback_timer);
    (void)esp_timer_start_once(s_sta_fallback_timer,
                               WIFI_MANAGER_STA_CONNECT_TIMEOUT_MS * 1000ULL);
}

static system_net_mode_t auto_scan_target_locked(void)
{
    if (s_connect_target_mode == SYSTEM_NET_STA) {
        return SYSTEM_NET_STA;
    }
    if (s_connect_target_mode == SYSTEM_NET_APSTA ||
        s_net_mode == SYSTEM_NET_APSTA) {
        return SYSTEM_NET_APSTA;
    }
    if (s_net_mode == SYSTEM_NET_STA) {
        return SYSTEM_NET_STA;
    }
    return SYSTEM_NET_AP;
}

static bool auto_scan_should_run_locked(system_net_mode_t *target_mode,
                                        char *saved_ssid, size_t ssid_size,
                                        char *saved_pass, size_t pass_size)
{
    system_net_mode_t target = auto_scan_target_locked();

    if (target != SYSTEM_NET_STA && target != SYSTEM_NET_APSTA) {
        return false;
    }
    if (auto_scan_ap_service_active_locked() && ap_client_count() > 0) {
        return false;
    }
    if (s_sta_ssid[0] == '\0' || s_sta_connected || s_sta_connecting) {
        return false;
    }

    if (target_mode != NULL) {
        *target_mode = target;
    }
    if (saved_ssid != NULL && ssid_size > 0) {
        snprintf(saved_ssid, ssid_size, "%s", s_sta_ssid);
    }
    if (saved_pass != NULL && pass_size > 0) {
        snprintf(saved_pass, pass_size, "%s", s_sta_pass);
    }
    return true;
}

static uint32_t auto_scan_delay_for_target(system_net_mode_t target_mode)
{
    if (s_auto_scan_failures >= WIFI_MANAGER_AUTO_SCAN_BACKOFF_AFTER) {
        return WIFI_MANAGER_AUTO_SCAN_MAX_MS;
    }
    return target_mode == SYSTEM_NET_STA ?
           WIFI_MANAGER_AUTO_SCAN_STA_MS : WIFI_MANAGER_AUTO_SCAN_APSTA_MS;
}

static void stop_auto_scan_locked(void)
{
    if (s_auto_scan_timer != NULL) {
        (void)esp_timer_stop(s_auto_scan_timer);
    }
}

static void schedule_auto_scan_locked(uint32_t delay_ms)
{
    system_net_mode_t target = SYSTEM_NET_AP;

    if (s_auto_scan_timer == NULL ||
        !auto_scan_should_run_locked(&target, NULL, 0, NULL, 0)) {
        stop_auto_scan_locked();
        return;
    }
    if (delay_ms == 0) {
        delay_ms = auto_scan_delay_for_target(target);
    }
    (void)esp_timer_stop(s_auto_scan_timer);
    esp_err_t ret = esp_timer_start_once(s_auto_scan_timer, delay_ms * 1000ULL);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to schedule STA auto scan: %s", esp_err_to_name(ret));
    }
}

static void auto_scan_timer_cb(void *arg)
{
    (void)arg;
    bool start_task = false;

    if (lock_mode(0) != pdTRUE) {
        if (ap_client_count() == 0 && s_auto_scan_timer != NULL) {
            (void)esp_timer_start_once(s_auto_scan_timer,
                                       WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS * 1000ULL);
        }
        return;
    }
    if (!s_auto_scan_task_running &&
        auto_scan_should_run_locked(NULL, NULL, 0, NULL, 0)) {
        s_auto_scan_task_running = true;
        start_task = true;
    }
    unlock_mode();

    if (!start_task) {
        return;
    }
    if (xTaskCreate(auto_scan_task, "wifi_auto_scan", 4096,
                    NULL, 3, NULL) != pdPASS) {
        if (lock_mode(portMAX_DELAY) == pdTRUE) {
            s_auto_scan_task_running = false;
            if (s_auto_scan_failures < UINT8_MAX) {
                s_auto_scan_failures++;
            }
            schedule_auto_scan_locked(0);
            unlock_mode();
        }
        ESP_LOGW(TAG, "Failed to create WiFi auto scan task");
    }
}

static bool advance_auto_scan_channel_locked(void)
{
    s_auto_scan_channel_index++;
    if (s_auto_scan_channel_index >= sizeof(s_auto_scan_channels)) {
        s_auto_scan_channel_index = 0;
        return true;
    }
    return false;
}

static esp_err_t auto_scan_saved_channel(const char *ssid, uint8_t channel,
                                         bool *found)
{
    if (ssid == NULL || ssid[0] == '\0' || found == NULL ||
        channel == 0 || channel > 13) {
        return ESP_ERR_INVALID_ARG;
    }

    *found = false;
    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (!auto_scan_begin_if_allowed()) {
        xSemaphoreGive(s_mode_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    wifi_scan_config_t scan_config = {
        .ssid = (uint8_t *)ssid,
        .channel = channel,
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time.active.min = WIFI_ACTIVE_SCAN_MIN_DEFAULT_TIME,
        .scan_time.active.max = WIFI_ACTIVE_SCAN_MAX_DEFAULT_TIME,
        .home_chan_dwell_time = WIFI_MANAGER_SCAN_HOME_DWELL_MS,
        .coex_background_scan = true,
    };
    int64_t scan_started_us = esp_timer_get_time();
    bool cancel_before_start = auto_scan_mark_started();
    esp_err_t ret;
    if (cancel_before_start) {
        ret = ESP_ERR_INVALID_STATE;
    } else {
        ret = esp_wifi_scan_start(&scan_config, true);
    }
    bool scan_started = ret == ESP_OK;
    bool scan_cancelled = auto_scan_end();
    int64_t scan_duration_ms = (esp_timer_get_time() - scan_started_us) / 1000;
    uint16_t ap_count = 0;

    if (scan_cancelled) {
        ret = ESP_ERR_INVALID_STATE;
    }

    if (ret == ESP_OK) {
        ret = esp_wifi_scan_get_ap_num(&ap_count);
        if (ret == ESP_OK) {
            *found = ap_count > 0;
        }
    }
    if (scan_started) {
        esp_err_t clear_ret = esp_wifi_clear_ap_list();
        if (ret == ESP_OK && clear_ret != ESP_OK) {
            ret = clear_ret;
        }
    }

    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Auto scan channel=%u duration=%lldms found=%s",
                 (unsigned)channel, (long long)scan_duration_ms,
                 *found ? "yes" : "no");
    } else {
        ESP_LOGW(TAG, "Auto scan channel=%u failed: %s duration=%lldms",
                 (unsigned)channel, esp_err_to_name(ret),
                 (long long)scan_duration_ms);
    }

    xSemaphoreGive(s_mode_mutex);
    return ret;
}

static void auto_scan_task(void *arg)
{
    (void)arg;
    system_net_mode_t target_mode = SYSTEM_NET_APSTA;
    char saved_ssid[33] = {0};
    char saved_pass[65] = {0};
    bool should_scan = false;
    bool found_saved = false;
    esp_err_t scan_ret = ESP_OK;
    esp_err_t connect_ret = ESP_FAIL;
    uint8_t scan_channel = s_auto_scan_channels[0];

    if (lock_mode(pdMS_TO_TICKS(100)) == pdTRUE) {
        should_scan = auto_scan_should_run_locked(&target_mode,
                                                  saved_ssid, sizeof(saved_ssid),
                                                  saved_pass, sizeof(saved_pass));
        scan_channel = s_auto_scan_channels[s_auto_scan_channel_index];
        unlock_mode();
    }
    if (!should_scan) {
        goto finish;
    }

    scan_ret = auto_scan_saved_channel(saved_ssid, scan_channel, &found_saved);

    if (found_saved) {
        ESP_LOGI(TAG, "Auto scan found saved SSID %s; reconnecting as %s",
                 saved_ssid, system_menu_net_name(target_mode));
        connect_ret = wifi_manager_connect_sta_for_mode(saved_ssid, saved_pass,
                                                        false, target_mode);
    } else if (scan_ret == ESP_OK) {
        ESP_LOGI(TAG, "Auto scan did not find saved SSID %s", saved_ssid);
    } else {
        ESP_LOGW(TAG, "Auto scan failed: %s", esp_err_to_name(scan_ret));
    }

finish:
    if (lock_mode(portMAX_DELAY) == pdTRUE) {
        s_auto_scan_task_running = false;
        if (should_scan && connect_ret != ESP_OK) {
            if (auto_scan_ap_service_active_locked() && ap_client_count() > 0) {
                stop_auto_scan_locked();
            } else if (scan_ret == ESP_ERR_INVALID_STATE) {
                schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
            } else {
                bool completed_sweep = advance_auto_scan_channel_locked();
                if (completed_sweep && s_auto_scan_failures < UINT8_MAX) {
                    s_auto_scan_failures++;
                }
                schedule_auto_scan_locked(completed_sweep ?
                                          auto_scan_delay_for_target(target_mode) :
                                          WIFI_MANAGER_AUTO_SCAN_CHANNEL_GAP_MS);
            }
        }
        unlock_mode();
    }
    vTaskDelete(NULL);
}

static esp_err_t start_ap_locked(void)
{
    (void)esp_timer_stop(s_sta_fallback_timer);
    stop_auto_scan_locked();
    s_auto_scan_failures = 0;
    if (s_driver_started) {
        esp_err_t disconnect_ret = esp_wifi_disconnect();
        if (disconnect_ret != ESP_OK && disconnect_ret != ESP_ERR_WIFI_NOT_CONNECT) {
            ESP_LOGW(TAG, "STA disconnect while switching to AP failed: %s",
                     esp_err_to_name(disconnect_ret));
        }
    }
    set_ap_state_locked();

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_AP);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = configure_ap_locked();
    if (ret != ESP_OK) {
        return ret;
    }
    ret = ensure_wifi_started_locked();
    if (ret != ESP_OK) {
        return ret;
    }

    report_net_mode(SYSTEM_NET_AP);
    report_message("AP MODE READY");
    report_wifi_label(s_ap_ssid);
    report_status("ap_on");
    report_wifi_state_locked();
    ESP_LOGI(TAG, "WiFi AP active: SSID=%s Web=http://192.168.4.1", s_ap_ssid);
    return ESP_OK;
}

static esp_err_t start_sta_locked(void)
{
    (void)esp_timer_stop(s_sta_fallback_timer);
    stop_auto_scan_locked();
    s_auto_scan_failures = 0;
    s_connect_target_mode = SYSTEM_NET_STA;
    s_net_mode = SYSTEM_NET_STA;
    s_sta_connecting = true;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_STA);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = configure_sta_locked();
    if (ret != ESP_OK) {
        return ret;
    }
    ret = ensure_wifi_started_locked();
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_connect();
    if (ret != ESP_OK) {
        return ret;
    }

    start_sta_retry_timer_locked();
    report_net_mode(SYSTEM_NET_STA);
    report_message("STA CONNECTING");
    report_wifi_label(s_sta_ssid);
    report_status("sta_conn");
    report_wifi_state_locked();
    ESP_LOGI(TAG, "WiFi STA connecting: STA=%s", s_sta_ssid);
    return ESP_OK;
}

static esp_err_t start_apsta_locked(void)
{
    (void)esp_timer_stop(s_sta_fallback_timer);
    s_net_mode = SYSTEM_NET_APSTA;
    s_sta_connecting = false;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = configure_ap_locked();
    if (ret != ESP_OK) {
        return ret;
    }
    if (wifi_manager_has_sta_config()) {
        ret = configure_sta_locked();
        if (ret != ESP_OK) {
            return ret;
        }
    }
    ret = ensure_wifi_started_locked();
    if (ret != ESP_OK) {
        return ret;
    }

    report_net_mode(SYSTEM_NET_APSTA);
    report_message("APSTA MODE READY");
    report_wifi_label(s_ap_ssid);
    report_status("apsta_on");
    report_wifi_state_locked();
    schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
    ESP_LOGI(TAG, "WiFi APSTA active: AP=%s", s_ap_ssid);
    return ESP_OK;
}

static esp_err_t start_apsta_connect_locked(void)
{
    if (!wifi_manager_has_sta_config()) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t ret = start_apsta_locked();
    if (ret != ESP_OK) {
        return ret;
    }
    s_connect_target_mode = SYSTEM_NET_APSTA;
    s_sta_connecting = true;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
    stop_auto_scan_locked();
    s_auto_scan_failures = 0;

    ret = esp_wifi_connect();
    if (ret != ESP_OK) {
        return ret;
    }

    start_sta_retry_timer_locked();
    report_message("APSTA CONNECTING");
    report_wifi_label(s_sta_ssid);
    report_status("apsta_conn");
    report_wifi_state_locked();
    ESP_LOGI(TAG, "WiFi APSTA connecting: AP=%s STA=%s", s_ap_ssid, s_sta_ssid);
    return ESP_OK;
}

esp_err_t wifi_manager_scan(wifi_manager_scan_ap_t *out, size_t capacity,
                            size_t *out_count)
{
    if (out == NULL || capacity == 0 || out_count == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    *out_count = 0;
    memset(out, 0, sizeof(out[0]) * capacity);

    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t ret = ESP_OK;
    wifi_ap_record_t *records = NULL;
    int64_t scan_started_us = 0;
    int64_t scan_duration_ms = 0;
    uint16_t ap_count = 0;
    uint16_t fetch_count = 0;
    wifi_mode_t restore_mode = WIFI_MODE_NULL;
    bool restore_after_scan = false;
    if (!s_driver_started) {
        esp_err_t mode_ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (mode_ret == ESP_OK) {
            mode_ret = esp_wifi_start();
        }
        if (mode_ret != ESP_OK) {
            ret = mode_ret;
            goto finish;
        }
        s_driver_started = true;
    } else {
        wifi_mode_t mode = WIFI_MODE_NULL;
        esp_err_t mode_ret = esp_wifi_get_mode(&mode);
        if (mode_ret == ESP_OK && mode == WIFI_MODE_AP) {
            mode_ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
            restore_mode = WIFI_MODE_AP;
            restore_after_scan = mode_ret == ESP_OK;
        }
        if (mode_ret != ESP_OK) {
            ret = mode_ret;
            goto finish;
        }
    }

    wifi_scan_config_t scan_config = {
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time.active.min = WIFI_ACTIVE_SCAN_MIN_DEFAULT_TIME,
        .scan_time.active.max = WIFI_ACTIVE_SCAN_MAX_DEFAULT_TIME,
        /*
         * Bluetooth coexistence requires the driver default scan timing.
         * Return to the SoftAP home channel between scanned channels so AP
         * clients continue receiving beacons while BLE is active.
         */
        .home_chan_dwell_time = WIFI_MANAGER_SCAN_HOME_DWELL_MS,
        .coex_background_scan = true,
    };
    scan_started_us = esp_timer_get_time();
    ret = esp_wifi_scan_start(&scan_config, true);
    scan_duration_ms = (esp_timer_get_time() - scan_started_us) / 1000;
    if (ret != ESP_OK) {
        goto finish;
    }

    ret = esp_wifi_scan_get_ap_num(&ap_count);
    if (ret != ESP_OK) {
        goto finish;
    }

    fetch_count = ap_count;
    if (fetch_count > WIFI_MANAGER_SCAN_MAX_APS * 2U) {
        fetch_count = WIFI_MANAGER_SCAN_MAX_APS * 2U;
    }
    size_t record_capacity = fetch_count > 0 ? fetch_count : 1U;
    records = calloc(record_capacity, sizeof(*records));
    if (records == NULL) {
        ret = ESP_ERR_NO_MEM;
        goto finish;
    }
    ret = esp_wifi_scan_get_ap_records(&fetch_count, records);
    if (ret != ESP_OK) {
        goto finish;
    }

    char saved_ssid[33];
    snprintf(saved_ssid, sizeof(saved_ssid), "%s", s_sta_ssid);
    size_t written = 0;
    for (uint16_t i = 0; i < fetch_count && written < capacity; i++) {
        if (records[i].ssid[0] == '\0') {
            continue;
        }
        bool duplicate = false;
        for (size_t j = 0; j < written; j++) {
            if (strcmp(out[j].ssid, (const char *)records[i].ssid) == 0) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            continue;
        }
        snprintf(out[written].ssid, sizeof(out[written].ssid), "%s", records[i].ssid);
        out[written].rssi = records[i].rssi;
        out[written].authmode = records[i].authmode;
        out[written].saved = saved_ssid[0] != '\0' && strcmp(out[written].ssid, saved_ssid) == 0;
        written++;
    }

    *out_count = written;

finish:
    if (scan_started_us > 0) {
        if (ret == ESP_OK) {
            ESP_LOGI(TAG, "WiFi scan finished: duration=%lldms found=%u returned=%u",
                     (long long)scan_duration_ms,
                     (unsigned)ap_count,
                     (unsigned)*out_count);
        } else {
            ESP_LOGW(TAG, "WiFi scan failed: %s duration=%lldms found=%u",
                     esp_err_to_name(ret),
                     (long long)scan_duration_ms,
                     (unsigned)ap_count);
        }
    }
    free(records);
    if (restore_after_scan) {
        esp_err_t restore_ret = esp_wifi_set_mode(restore_mode);
        if (restore_ret != ESP_OK) {
            ESP_LOGW(TAG, "WiFi scan mode restore failed: %s",
                     esp_err_to_name(restore_ret));
        }
    }
    xSemaphoreGive(s_mode_mutex);
    return ret;
}

static system_net_mode_t normalize_sta_target(system_net_mode_t target_mode)
{
    return target_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA;
}

esp_err_t wifi_manager_connect_sta_for_mode(const char *ssid, const char *password,
                                            bool save_on_success,
                                            system_net_mode_t target_mode)
{
    if (ssid == NULL || ssid[0] == '\0' || strlen(ssid) > 32) {
        return ESP_ERR_INVALID_ARG;
    }
    if (password == NULL) {
        password = "";
    }
    if (strlen(password) > 64) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    target_mode = normalize_sta_target(target_mode);
    s_connect_target_mode = target_mode;
    s_save_sta_on_connect = save_on_success;
    if (save_on_success) {
        snprintf(s_restore_sta_ssid, sizeof(s_restore_sta_ssid), "%s", s_sta_ssid);
        snprintf(s_restore_sta_pass, sizeof(s_restore_sta_pass), "%s", s_sta_pass);
        s_restore_sta_on_fail = true;
        snprintf(s_pending_save_ssid, sizeof(s_pending_save_ssid), "%s", ssid);
        snprintf(s_pending_save_pass, sizeof(s_pending_save_pass), "%s", password);
    } else {
        s_restore_sta_on_fail = false;
        s_pending_save_ssid[0] = '\0';
        s_pending_save_pass[0] = '\0';
        s_restore_sta_ssid[0] = '\0';
        s_restore_sta_pass[0] = '\0';
    }
    snprintf(s_sta_ssid, sizeof(s_sta_ssid), "%s", ssid);
    snprintf(s_sta_pass, sizeof(s_sta_pass), "%s", password);

    esp_err_t ret = target_mode == SYSTEM_NET_STA ?
                    start_sta_locked() : start_apsta_connect_locked();
    if (ret != ESP_OK) {
        restore_pending_sta_config_locked();
        report_message("STA FAIL");
        report_status("sta_fail");
    }

    xSemaphoreGive(s_mode_mutex);
    return ret;
}

esp_err_t wifi_manager_connect_sta(const char *ssid, const char *password,
                                   bool save_on_success)
{
    return wifi_manager_connect_sta_for_mode(ssid, password, save_on_success,
                                             SYSTEM_NET_APSTA);
}

typedef struct {
    char ssid[33];
    char password[65];
    bool save_on_success;
    uint32_t delay_ms;
    system_net_mode_t target_mode;
} wifi_manager_connect_task_arg_t;

static void wifi_manager_connect_task(void *arg)
{
    wifi_manager_connect_task_arg_t *task_arg = (wifi_manager_connect_task_arg_t *)arg;
    if (task_arg == NULL) {
        vTaskDelete(NULL);
        return;
    }

    if (task_arg->delay_ms > 0) {
        vTaskDelay(pdMS_TO_TICKS(task_arg->delay_ms));
    }
    esp_err_t ret = wifi_manager_connect_sta_for_mode(task_arg->ssid,
                                                      task_arg->password,
                                                      task_arg->save_on_success,
                                                      task_arg->target_mode);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Scheduled STA connect failed: %s", esp_err_to_name(ret));
    }
    free(task_arg);
    vTaskDelete(NULL);
}

esp_err_t wifi_manager_schedule_connect_sta_for_mode(const char *ssid,
                                                     const char *password,
                                                     bool save_on_success,
                                                     uint32_t delay_ms,
                                                     system_net_mode_t target_mode)
{
    if (ssid == NULL || ssid[0] == '\0' || strlen(ssid) > 32) {
        return ESP_ERR_INVALID_ARG;
    }
    if (password == NULL) {
        password = "";
    }
    if (strlen(password) > 64) {
        return ESP_ERR_INVALID_ARG;
    }

    wifi_manager_connect_task_arg_t *arg = calloc(1, sizeof(*arg));
    if (arg == NULL) {
        return ESP_ERR_NO_MEM;
    }
    snprintf(arg->ssid, sizeof(arg->ssid), "%s", ssid);
    snprintf(arg->password, sizeof(arg->password), "%s", password);
    arg->save_on_success = save_on_success;
    arg->delay_ms = delay_ms;
    arg->target_mode = normalize_sta_target(target_mode);

    if (xTaskCreate(wifi_manager_connect_task, "wifi_sta_conn", 4096,
                    arg, 4, NULL) != pdPASS) {
        free(arg);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t wifi_manager_schedule_connect_sta(const char *ssid, const char *password,
                                            bool save_on_success,
                                            uint32_t delay_ms)
{
    return wifi_manager_schedule_connect_sta_for_mode(ssid, password,
                                                     save_on_success,
                                                     delay_ms,
                                                     SYSTEM_NET_APSTA);
}

esp_err_t wifi_manager_quick_connect_for_mode(const char *ssid,
                                              system_net_mode_t target_mode)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    char saved_ssid[33];
    char saved_pass[65];
    bool use_saved = wifi_manager_get_saved_sta_config(saved_ssid, sizeof(saved_ssid),
                                                       saved_pass, sizeof(saved_pass)) &&
                     strcmp(saved_ssid, ssid) == 0;
    return wifi_manager_connect_sta_for_mode(ssid,
                                             use_saved ? saved_pass : WIFI_MANAGER_QUICK_PASSWORD,
                                             !use_saved,
                                             target_mode);
}

esp_err_t wifi_manager_quick_connect(const char *ssid)
{
    return wifi_manager_quick_connect_for_mode(ssid, SYSTEM_NET_APSTA);
}

esp_err_t wifi_manager_begin_web_setup(system_net_mode_t target_mode)
{
    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    s_connect_target_mode = normalize_sta_target(target_mode);
    esp_err_t ret = start_apsta_locked();
    if (ret == ESP_OK) {
        report_message(s_connect_target_mode == SYSTEM_NET_STA ?
                       "STA WEB SETUP" : "APSTA WEB SETUP");
    }
    xSemaphoreGive(s_mode_mutex);
    return ret;
}

esp_err_t wifi_manager_request_net_mode(system_net_mode_t mode)
{
    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t ret = ESP_OK;
    switch (mode) {
    case SYSTEM_NET_STA:
        ret = start_sta_locked();
        break;
    case SYSTEM_NET_APSTA:
        s_connect_target_mode = SYSTEM_NET_APSTA;
        ret = start_apsta_locked();
        break;
    case SYSTEM_NET_AP:
    default:
        ret = start_ap_locked();
        break;
    }
    if (ret != ESP_OK && mode == SYSTEM_NET_STA) {
        ESP_LOGW(TAG, "STA switch failed: %s", esp_err_to_name(ret));
        report_message(ret == ESP_ERR_INVALID_STATE ? "STA NEED CFG" : "STA FAIL");
        report_status(ret == ESP_ERR_INVALID_STATE ? "sta_need_cfg" : "sta_fail");
    }

    xSemaphoreGive(s_mode_mutex);
    return ret;
}

static void switch_task(void *arg)
{
    system_net_mode_t mode = (system_net_mode_t)(uintptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(250));
    esp_err_t ret = wifi_manager_request_net_mode(mode);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "WiFi mode switch to %s failed: %s",
                 system_menu_net_name(mode), esp_err_to_name(ret));
    }
    vTaskDelete(NULL);
}

void wifi_manager_schedule_net_mode(system_net_mode_t mode)
{
    if (xTaskCreate(switch_task, "wifi_mode_sw", 3072, (void *)(uintptr_t)mode,
                    4, NULL) != pdPASS) {
        ESP_LOGW(TAG, "Failed to schedule WiFi mode switch");
    }
}

static void sta_fallback_timer_cb(void *arg)
{
    (void)arg;
    bool should_scan = false;
    if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
        should_scan = (s_net_mode == SYSTEM_NET_STA || s_net_mode == SYSTEM_NET_APSTA) &&
                      s_sta_connecting && !s_sta_connected &&
                      s_sta_ssid[0] != '\0';
        if (should_scan) {
            s_sta_connecting = false;
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
            report_wifi_state_locked();
            schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
        }
        unlock_mode();
    }
    if (should_scan) {
        report_message("STA AUTO SCAN");
        report_status("sta_scan_wait");
        esp_err_t ret = esp_wifi_disconnect();
        if (ret != ESP_OK && ret != ESP_ERR_WIFI_NOT_CONNECT) {
            ESP_LOGW(TAG, "STA disconnect before auto scan failed: %s",
                     esp_err_to_name(ret));
        }
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    (void)arg;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STACONNECTED) {
        wifi_event_ap_staconnected_t *event =
            (wifi_event_ap_staconnected_t *)event_data;
        bool stop_in_flight_scan = note_ap_client_connected();
        if (lock_mode(0) == pdTRUE) {
            stop_auto_scan_locked();
            unlock_mode();
        }
        if (stop_in_flight_scan) {
            (void)esp_wifi_scan_stop();
        }
        ESP_LOGI(TAG, "SoftAP client connected, aid=%d clients=%u; auto scan paused",
                 event ? event->aid : -1, (unsigned)ap_client_count());
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STADISCONNECTED) {
        wifi_event_ap_stadisconnected_t *event =
            (wifi_event_ap_stadisconnected_t *)event_data;
        bool resume_auto_scan = note_ap_client_disconnected();
        if (resume_auto_scan) {
            if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
                schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
                unlock_mode();
            } else if (s_auto_scan_timer != NULL) {
                (void)esp_timer_stop(s_auto_scan_timer);
                (void)esp_timer_start_once(s_auto_scan_timer,
                                           WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS * 1000ULL);
            }
        }
        ESP_LOGI(TAG, "SoftAP client disconnected, aid=%d clients=%u; auto scan %s",
                 event ? event->aid : -1, (unsigned)ap_client_count(),
                 resume_auto_scan ? "resumed" : "paused");
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)event_data;
        ESP_LOGW(TAG, "STA disconnected, reason=%d", event ? event->reason : -1);
        bool should_retry = false;
        if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
            should_retry = (s_net_mode == SYSTEM_NET_STA || s_net_mode == SYSTEM_NET_APSTA) &&
                           s_sta_ssid[0] != '\0';
            s_sta_connecting = false;
            s_sta_connected = false;
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
            if (should_retry) {
                schedule_auto_scan_locked(WIFI_MANAGER_AUTO_SCAN_IMMEDIATE_MS);
            }
            report_wifi_state_locked();
            unlock_mode();
        }
        if (should_retry) {
            report_message("STA AUTO SCAN");
            report_status("sta_lost");
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        system_net_mode_t target_mode = SYSTEM_NET_APSTA;
        if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
            s_sta_connecting = false;
            s_sta_connected = true;
            (void)esp_timer_stop(s_sta_fallback_timer);
            s_auto_scan_failures = 0;
            stop_auto_scan_locked();
            snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&event->ip_info.ip));
            target_mode = s_connect_target_mode;
            s_net_mode = target_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA;
            bool should_save = s_save_sta_on_connect && s_pending_save_ssid[0] != '\0';
            char save_ssid[33];
            char save_pass[65];
            snprintf(save_ssid, sizeof(save_ssid), "%s", s_pending_save_ssid);
            snprintf(save_pass, sizeof(save_pass), "%s", s_pending_save_pass);
            clear_pending_save_locked();
            report_wifi_state_locked();
            unlock_mode();
            if (should_save) {
                esp_err_t save_ret = wifi_manager_save_sta_config(save_ssid, save_pass);
                if (save_ret != ESP_OK) {
                    ESP_LOGW(TAG, "Failed to persist STA config: %s",
                             esp_err_to_name(save_ret));
                }
            }
        }
        if (target_mode == SYSTEM_NET_STA) {
            esp_err_t mode_ret = esp_wifi_set_mode(WIFI_MODE_STA);
            if (mode_ret != ESP_OK) {
                ESP_LOGW(TAG, "Failed to finalize true STA mode: %s",
                         esp_err_to_name(mode_ret));
            }
        }
        ESP_LOGI(TAG, "STA got IP: %s", s_sta_ip);
        report_net_mode(target_mode == SYSTEM_NET_STA ? SYSTEM_NET_STA : SYSTEM_NET_APSTA);
        report_message(target_mode == SYSTEM_NET_STA ? "STA CONNECTED" : "APSTA CONNECTED");
        report_wifi_label(s_sta_ip);
        report_status(target_mode == SYSTEM_NET_STA ? "sta_on" : "apsta_on");
    }
}

void wifi_manager_get_status(wifi_manager_status_t *out)
{
    if (out == NULL) {
        return;
    }

    if (lock_mode(pdMS_TO_TICKS(20)) == pdTRUE) {
        make_status_locked(out);
        unlock_mode();
        return;
    }

    out->mode = s_net_mode;
    snprintf(out->ap_ssid, sizeof(out->ap_ssid), "%s", s_ap_ssid);
    snprintf(out->ap_ip, sizeof(out->ap_ip), "%s", WIFI_MANAGER_AP_IP);
    snprintf(out->sta_ssid, sizeof(out->sta_ssid), "%s", s_sta_ssid);
    snprintf(out->sta_ip, sizeof(out->sta_ip), "%s", s_sta_ip);
    out->sta_configured = wifi_manager_has_sta_config();
    out->sta_connecting = s_sta_connecting;
    out->sta_connected = s_sta_connected;
}

esp_err_t wifi_manager_init(const wifi_manager_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    s_ap_netif = esp_netif_create_default_wifi_ap();
    s_sta_netif = esp_netif_create_default_wifi_sta();
    (void)s_sta_netif;

    esp_err_t ret = configure_ap_netif_no_gateway();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to configure AP DHCP gateway/DNS: %s",
                 esp_err_to_name(ret));
    }

    s_mode_mutex = xSemaphoreCreateMutex();
    if (s_mode_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ret = esp_wifi_init(&cfg);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_country_code(WIFI_MANAGER_COUNTRY_CODE, true);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                              &wifi_event_handler, NULL, NULL);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_AP_STACONNECTED,
                                              &wifi_event_handler, NULL, NULL);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_AP_STADISCONNECTED,
                                              &wifi_event_handler, NULL, NULL);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                              &wifi_event_handler, NULL, NULL);
    if (ret != ESP_OK) {
        return ret;
    }

    const esp_timer_create_args_t fallback_args = {
        .callback = sta_fallback_timer_cb,
        .name = "sta_fallback",
    };
    ret = esp_timer_create(&fallback_args, &s_sta_fallback_timer);
    if (ret != ESP_OK) {
        return ret;
    }
    const esp_timer_create_args_t auto_scan_args = {
        .callback = auto_scan_timer_cb,
        .name = "sta_auto_scan",
    };
    ret = esp_timer_create(&auto_scan_args, &s_auto_scan_timer);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = load_sta_config();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load STA config: %s", esp_err_to_name(ret));
    }

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "ESP32-S3_AP_%02X%02X", mac[4], mac[5]);

    ret = wifi_manager_request_net_mode(SYSTEM_NET_APSTA);
    if (ret != ESP_OK) {
        return ret;
    }

    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "WiFi Mode Started: %s", system_menu_net_name(s_net_mode));
    ESP_LOGI(TAG, "SSID     : %s", s_ap_ssid);
    ESP_LOGI(TAG, "Web      : http://192.168.4.1");
    ESP_LOGI(TAG, "WebSocket: ws://192.168.4.1/ws");
    ESP_LOGI(TAG, "========================================");
    return ESP_OK;
}
