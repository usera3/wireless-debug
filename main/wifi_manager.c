#include "wifi_manager.h"

#include <stdint.h>
#include <stdio.h>
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

static const char *TAG = "wifi_manager";

static wifi_manager_config_t s_config;
static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;
static SemaphoreHandle_t s_mode_mutex;
static esp_timer_handle_t s_sta_fallback_timer;
static system_net_mode_t s_net_mode = SYSTEM_NET_AP;
static bool s_driver_started;
static bool s_sta_connecting;
static bool s_sta_connected;
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
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
            unlock_mode();
        } else {
            s_sta_ssid[0] = '\0';
            s_sta_pass[0] = '\0';
            s_sta_connected = false;
            s_sta_connecting = false;
            clear_pending_save_locked();
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
        }
    }
    return ret;
}

static void set_ap_state_locked(void)
{
    restore_pending_sta_config_locked();
    s_net_mode = SYSTEM_NET_AP;
    s_sta_connecting = false;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
}

static esp_err_t start_ap_locked(void)
{
    esp_timer_stop(s_sta_fallback_timer);
    set_ap_state_locked();

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_AP);
    if (ret != ESP_OK) {
        return ret;
    }

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
    ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
    if (ret != ESP_OK) {
        return ret;
    }
    if (!s_driver_started) {
        ret = esp_wifi_start();
        if (ret != ESP_OK) {
            return ret;
        }
        s_driver_started = true;
    }

    report_net_mode(SYSTEM_NET_AP);
    report_message("AP MODE READY");
    report_wifi_label(s_ap_ssid);
    report_status("ap_on");
    ESP_LOGI(TAG, "WiFi AP active: SSID=%s Web=http://192.168.4.1", s_ap_ssid);
    return ESP_OK;
}

static esp_err_t start_sta_locked(void)
{
    if (!wifi_manager_has_sta_config()) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_timer_stop(s_sta_fallback_timer);
    s_net_mode = SYSTEM_NET_STA;
    s_sta_connecting = true;
    s_sta_connected = false;
    snprintf(s_sta_ip, sizeof(s_sta_ip), "-");

    wifi_config_t sta_config = {0};
    strlcpy((char *)sta_config.sta.ssid, s_sta_ssid, sizeof(sta_config.sta.ssid));
    strlcpy((char *)sta_config.sta.password, s_sta_pass, sizeof(sta_config.sta.password));
    sta_config.sta.threshold.authmode = s_sta_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    sta_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;

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

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_config(WIFI_IF_STA, &sta_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
    if (ret != ESP_OK) {
        return ret;
    }
    if (!s_driver_started) {
        ret = esp_wifi_start();
        if (ret != ESP_OK) {
            return ret;
        }
        s_driver_started = true;
    }
    ret = esp_wifi_connect();
    if (ret != ESP_OK) {
        return ret;
    }

    esp_timer_start_once(s_sta_fallback_timer, WIFI_MANAGER_STA_CONNECT_TIMEOUT_MS * 1000ULL);
    report_net_mode(SYSTEM_NET_STA);
    report_message("STA CONNECTING");
    report_wifi_label(s_sta_ssid);
    report_status("sta_conn");
    ESP_LOGI(TAG, "WiFi APSTA active: AP=%s STA=%s", s_ap_ssid, s_sta_ssid);
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

    if (!s_driver_started) {
        esp_err_t mode_ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (mode_ret == ESP_OK) {
            mode_ret = esp_wifi_start();
        }
        if (mode_ret != ESP_OK) {
            xSemaphoreGive(s_mode_mutex);
            return mode_ret;
        }
        s_driver_started = true;
    } else {
        wifi_mode_t mode = WIFI_MODE_NULL;
        esp_err_t mode_ret = esp_wifi_get_mode(&mode);
        if (mode_ret == ESP_OK && mode == WIFI_MODE_AP) {
            mode_ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
        }
        if (mode_ret != ESP_OK) {
            xSemaphoreGive(s_mode_mutex);
            return mode_ret;
        }
    }

    wifi_scan_config_t scan_config = {
        .show_hidden = false,
    };
    esp_err_t ret = esp_wifi_scan_start(&scan_config, true);
    if (ret != ESP_OK) {
        xSemaphoreGive(s_mode_mutex);
        return ret;
    }

    uint16_t ap_count = 0;
    ret = esp_wifi_scan_get_ap_num(&ap_count);
    if (ret != ESP_OK) {
        xSemaphoreGive(s_mode_mutex);
        return ret;
    }

    uint16_t fetch_count = ap_count;
    if (fetch_count > WIFI_MANAGER_SCAN_MAX_APS * 2U) {
        fetch_count = WIFI_MANAGER_SCAN_MAX_APS * 2U;
    }
    wifi_ap_record_t records[WIFI_MANAGER_SCAN_MAX_APS * 2U];
    memset(records, 0, sizeof(records));
    ret = esp_wifi_scan_get_ap_records(&fetch_count, records);
    if (ret != ESP_OK) {
        xSemaphoreGive(s_mode_mutex);
        return ret;
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
    xSemaphoreGive(s_mode_mutex);
    return ESP_OK;
}

esp_err_t wifi_manager_connect_sta(const char *ssid, const char *password,
                                   bool save_on_success)
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

    esp_err_t ret = start_sta_locked();
    if (ret != ESP_OK) {
        restore_pending_sta_config_locked();
        (void)start_ap_locked();
        report_message("STA FAIL AP");
        report_status("sta_fail");
    }

    xSemaphoreGive(s_mode_mutex);
    return ret;
}

esp_err_t wifi_manager_quick_connect(const char *ssid)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    char saved_ssid[33];
    char saved_pass[65];
    bool use_saved = wifi_manager_get_saved_sta_config(saved_ssid, sizeof(saved_ssid),
                                                       saved_pass, sizeof(saved_pass)) &&
                     strcmp(saved_ssid, ssid) == 0;
    return wifi_manager_connect_sta(ssid,
                                    use_saved ? saved_pass : WIFI_MANAGER_QUICK_PASSWORD,
                                    !use_saved);
}

esp_err_t wifi_manager_request_net_mode(system_net_mode_t mode)
{
    if (s_mode_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mode_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t ret = (mode == SYSTEM_NET_STA) ? start_sta_locked() : start_ap_locked();
    if (ret != ESP_OK && mode == SYSTEM_NET_STA) {
        ESP_LOGW(TAG, "STA switch failed (%s), returning to AP", esp_err_to_name(ret));
        (void)start_ap_locked();
        report_message(ret == ESP_ERR_INVALID_STATE ? "STA NEED CFG" : "STA FAIL AP");
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
    ESP_LOGW(TAG, "STA connect timeout, falling back to AP");
    wifi_manager_schedule_net_mode(SYSTEM_NET_AP);
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    (void)arg;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)event_data;
        ESP_LOGW(TAG, "STA disconnected, reason=%d", event ? event->reason : -1);
        if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
            bool should_fallback = (s_net_mode == SYSTEM_NET_STA) &&
                                   (s_sta_connecting || s_sta_connected);
            s_sta_connecting = false;
            s_sta_connected = false;
            restore_pending_sta_config_locked();
            snprintf(s_sta_ip, sizeof(s_sta_ip), "-");
            unlock_mode();
            if (should_fallback) {
                report_message("STA LOST AP");
                report_status("sta_lost");
                wifi_manager_schedule_net_mode(SYSTEM_NET_AP);
            }
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        if (lock_mode(pdMS_TO_TICKS(50)) == pdTRUE) {
            s_sta_connecting = false;
            s_sta_connected = true;
            esp_timer_stop(s_sta_fallback_timer);
            snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&event->ip_info.ip));
            bool should_save = s_save_sta_on_connect && s_pending_save_ssid[0] != '\0';
            char save_ssid[33];
            char save_pass[65];
            snprintf(save_ssid, sizeof(save_ssid), "%s", s_pending_save_ssid);
            snprintf(save_pass, sizeof(save_pass), "%s", s_pending_save_pass);
            clear_pending_save_locked();
            unlock_mode();
            if (should_save) {
                esp_err_t save_ret = wifi_manager_save_sta_config(save_ssid, save_pass);
                if (save_ret != ESP_OK) {
                    ESP_LOGW(TAG, "Failed to persist STA config: %s",
                             esp_err_to_name(save_ret));
                }
            }
        }
        ESP_LOGI(TAG, "STA got IP: %s", s_sta_ip);
        report_net_mode(SYSTEM_NET_STA);
        report_message("STA CONNECTED");
        report_wifi_label(s_sta_ip);
        report_status("sta_on");
    }
}

void wifi_manager_get_status(wifi_manager_status_t *out)
{
    if (out == NULL) {
        return;
    }

    if (lock_mode(pdMS_TO_TICKS(20)) == pdTRUE) {
        out->mode = s_net_mode;
        snprintf(out->ap_ssid, sizeof(out->ap_ssid), "%s", s_ap_ssid);
        snprintf(out->sta_ssid, sizeof(out->sta_ssid), "%s", s_sta_ssid);
        snprintf(out->sta_ip, sizeof(out->sta_ip), "%s", s_sta_ip);
        out->sta_configured = wifi_manager_has_sta_config();
        out->sta_connecting = s_sta_connecting;
        out->sta_connected = s_sta_connected;
        unlock_mode();
        return;
    }

    out->mode = s_net_mode;
    snprintf(out->ap_ssid, sizeof(out->ap_ssid), "%s", s_ap_ssid);
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
    ret = esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
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

    ret = load_sta_config();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load STA config: %s", esp_err_to_name(ret));
    }

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "ESP32-S3_AP_%02X%02X", mac[4], mac[5]);

#if WIFI_MANAGER_START_STA_ON_BOOT
    ret = wifi_manager_request_net_mode(wifi_manager_has_sta_config() ? SYSTEM_NET_STA : SYSTEM_NET_AP);
#else
    ret = wifi_manager_request_net_mode(SYSTEM_NET_AP);
#endif
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
