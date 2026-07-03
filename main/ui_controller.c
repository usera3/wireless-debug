#include "ui_controller.h"

#include <stdio.h>
#include <string.h>
#include "app_core.h"
#include "comm_stats.h"
#include "display_lvgl.h"
#include "display_port.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static ui_controller_config_t s_config;
static SemaphoreHandle_t s_action_mutex;

static bool wifi_has_sta_config(void)
{
    return s_config.wifi_has_sta_config != NULL &&
           s_config.wifi_has_sta_config(s_config.ctx);
}

static void wifi_get_status(wifi_manager_status_t *out)
{
    if (out == NULL) {
        return;
    }
    memset(out, 0, sizeof(*out));
    out->mode = SYSTEM_NET_AP;
    snprintf(out->sta_ip, sizeof(out->sta_ip), "-");
    if (s_config.wifi_get_status != NULL) {
        s_config.wifi_get_status(out, s_config.ctx);
    }
}

static void wifi_schedule_net_mode(system_net_mode_t mode)
{
    if (s_config.wifi_schedule_net_mode != NULL) {
        s_config.wifi_schedule_net_mode(mode, s_config.ctx);
    }
}

static esp_err_t wifi_scan(wifi_manager_scan_ap_t *out, size_t capacity,
                           size_t *out_count)
{
    if (s_config.wifi_scan == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return s_config.wifi_scan(out, capacity, out_count, s_config.ctx);
}

static esp_err_t wifi_quick_connect(const char *ssid)
{
    if (s_config.wifi_quick_connect == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return s_config.wifi_quick_connect(ssid, s_config.ctx);
}

static bool ble_is_started(void)
{
    return s_config.ble_is_started != NULL &&
           s_config.ble_is_started(s_config.ctx);
}

static esp_err_t ble_start(void)
{
    if (s_config.ble_start == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return s_config.ble_start(s_config.ctx);
}

static void log_heap(const char *label)
{
    if (s_config.log_heap != NULL) {
        s_config.log_heap(label, s_config.ctx);
    }
}

static bool ensure_ble_started(void)
{
    if (ble_is_started()) {
        return true;
    }

    system_menu_set_message("BLE STARTING");
    display_lvgl_set_status("ble_start");
    esp_err_t ble_ret = ble_start();
    if (ble_ret != ESP_OK) {
        system_menu_set_message("BLE START FAIL");
        display_port_set_status("menu_ble_fail");
        display_lvgl_set_ble_ready(0);
        display_lvgl_set_status("ble_fail");
        return false;
    }
    return true;
}

static bool action_lock(void)
{
    return s_action_mutex != NULL &&
           xSemaphoreTake(s_action_mutex, pdMS_TO_TICKS(2000)) == pdTRUE;
}

static void action_unlock(void)
{
    if (s_action_mutex != NULL) {
        xSemaphoreGive(s_action_mutex);
    }
}

static void action_feedback(system_menu_action_t action,
                            system_action_source_t source,
                            const char *status,
                            const char *detail)
{
    system_menu_show_action_result(action, status, detail, source);
    display_lvgl_request_redraw();
}

static esp_err_t apply_uart_baud_action(system_menu_action_t action,
                                        uint32_t baud,
                                        system_action_source_t source)
{
    esp_err_t err = ESP_ERR_INVALID_STATE;
    if (s_config.set_uart_baud != NULL) {
        err = s_config.set_uart_baud(baud, s_config.ctx);
    }
    if (err == ESP_OK) {
        char detail[16];
        snprintf(detail, sizeof(detail), "%lu", (unsigned long)baud);
        action_feedback(action, source, "OK", detail);
    } else {
        action_feedback(action, source, "FAIL", "baud set");
    }
    return err;
}

static esp_err_t apply_sta_quick_scan(system_action_source_t source)
{
    wifi_manager_scan_ap_t scan_aps[WIFI_MANAGER_SCAN_MAX_APS];
    size_t scan_count = 0;

    system_menu_set_message("SCAN WIFI");
    display_port_set_status("wifi_scan");
    display_lvgl_set_status("wifi_scan");

    esp_err_t err = wifi_scan(scan_aps, WIFI_MANAGER_SCAN_MAX_APS, &scan_count);
    if (err != ESP_OK) {
        action_feedback(SYSTEM_ACTION_NET_STA_QUICK, source, "FAIL", "scan wifi");
        return err;
    }

    if (scan_count == 0) {
        system_menu_set_wifi_scan_results(NULL, 0);
        action_feedback(SYSTEM_ACTION_NET_STA_QUICK, source, "FAIL", "No WiFi");
        return ESP_ERR_NOT_FOUND;
    }

    system_menu_wifi_ap_t menu_aps[SYSTEM_MENU_WIFI_MAX_APS];
    uint8_t menu_count = (uint8_t)scan_count;
    if (menu_count > SYSTEM_MENU_WIFI_MAX_APS) {
        menu_count = SYSTEM_MENU_WIFI_MAX_APS;
    }
    memset(menu_aps, 0, sizeof(menu_aps));
    for (uint8_t i = 0; i < menu_count; i++) {
        snprintf(menu_aps[i].ssid, sizeof(menu_aps[i].ssid), "%s", scan_aps[i].ssid);
        menu_aps[i].rssi = scan_aps[i].rssi;
        menu_aps[i].saved = scan_aps[i].saved;
    }

    system_menu_set_wifi_scan_results(menu_aps, menu_count);
    display_port_set_status("wifi_scan_ok");
    display_lvgl_set_status("scan_ok");
    display_lvgl_request_redraw();
    return ESP_OK;
}

static esp_err_t apply_sta_quick_connect(system_action_source_t source)
{
    char ssid[33];
    if (!system_menu_get_selected_wifi_ssid(ssid, sizeof(ssid))) {
        action_feedback(SYSTEM_ACTION_NET_STA_QUICK_CONNECT, source, "FAIL", "No SSID");
        return ESP_ERR_INVALID_STATE;
    }

    system_menu_set_net_mode(SYSTEM_NET_STA);
    system_menu_set_message("STA CONNECTING");
    display_port_set_status("quick_sta_conn");
    display_lvgl_set_status("sta_conn");
    display_lvgl_set_wifi_ssid(ssid);

    esp_err_t err = wifi_quick_connect(ssid);
    if (err == ESP_OK) {
        action_feedback(SYSTEM_ACTION_NET_STA_QUICK_CONNECT, source, "WORKING", ssid);
    } else {
        system_menu_set_net_mode(SYSTEM_NET_AP);
        action_feedback(SYSTEM_ACTION_NET_STA_QUICK_CONNECT, source, "FAIL", "connect STA");
    }
    return err;
}

static esp_err_t apply_sta_web_setup(system_action_source_t source)
{
    (void)source;
    wifi_manager_status_t status;
    wifi_get_status(&status);

    char ap_line[64];
    snprintf(ap_line, sizeof(ap_line), "AP:%s",
             status.ap_ssid[0] != '\0' ? status.ap_ssid : "ESP32-S3_AP");

    system_menu_set_message("WEB SETUP");
    display_port_set_status("wifi_web_setup");
    display_lvgl_set_status("web_setup");
    display_lvgl_set_text_screen("WEB SETUP",
                                 ap_line,
                                 "PASS:12345678",
                                 "IP:192.168.4.1",
                                 "/wifi.html",
                                 "S5L BACK");
    display_lvgl_request_redraw();
    return ESP_OK;
}

esp_err_t ui_controller_init(const ui_controller_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_config = *config;
    if (s_action_mutex == NULL) {
        s_action_mutex = xSemaphoreCreateMutex();
        if (s_action_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    return ESP_OK;
}

esp_err_t ui_controller_apply_menu_action(system_menu_action_t action,
                                          system_action_source_t source)
{
    esp_err_t err = ESP_OK;

    if (action == SYSTEM_ACTION_NONE) {
        return ESP_OK;
    }
    if (!action_lock()) {
        action_feedback(action, source, "FAIL", "busy");
        return ESP_ERR_TIMEOUT;
    }

    switch (action) {
    case SYSTEM_ACTION_NET_AP:
        system_menu_set_net_mode(SYSTEM_NET_AP);
        system_menu_set_message("AP SWITCHING");
        display_port_set_status("menu_ap");
        display_lvgl_set_status("ap_switch");
        wifi_schedule_net_mode(SYSTEM_NET_AP);
        action_feedback(action, source, "WORKING", "AP mode");
        break;
    case SYSTEM_ACTION_NET_STA:
        if (!wifi_has_sta_config()) {
            system_menu_set_net_mode(SYSTEM_NET_AP);
            system_menu_set_message("STA NEED CFG");
            display_port_set_status("menu_sta_pending");
            display_lvgl_set_status("sta_need_cfg");
            action_feedback(action, source, "FAIL", "No STA cfg");
            err = ESP_ERR_INVALID_STATE;
            break;
        }
        system_menu_set_net_mode(SYSTEM_NET_STA);
        system_menu_set_message("STA SWITCHING");
        display_port_set_status("menu_sta");
        display_lvgl_set_status("sta_switch");
        wifi_schedule_net_mode(SYSTEM_NET_STA);
        action_feedback(action, source, "WORKING", "STA mode");
        break;
    case SYSTEM_ACTION_NET_STA_QUICK:
        err = apply_sta_quick_scan(source);
        break;
    case SYSTEM_ACTION_NET_STA_WEB_SETUP:
        err = apply_sta_web_setup(source);
        break;
    case SYSTEM_ACTION_NET_STA_QUICK_CONNECT:
        err = apply_sta_quick_connect(source);
        break;
    case SYSTEM_ACTION_NET_STA_CLEAR:
        if (s_config.wifi_clear_sta_config != NULL) {
            err = s_config.wifi_clear_sta_config(s_config.ctx);
        } else {
            err = ESP_ERR_INVALID_STATE;
        }
        if (err == ESP_OK) {
            system_menu_set_net_mode(SYSTEM_NET_AP);
            system_menu_set_message("STA CFG CLEAR");
            display_port_set_status("menu_sta_clear");
            display_lvgl_set_status("sta_clear");
            wifi_schedule_net_mode(SYSTEM_NET_AP);
            action_feedback(action, source, "OK", "STA cleared");
        } else {
            action_feedback(action, source, "FAIL", "clear STA");
        }
        break;
    case SYSTEM_ACTION_COMM_AUTO:
        app_core_set_comm_mode(APP_COMM_AUTO);
        system_menu_set_comm_mode(SYSTEM_COMM_AUTO);
        display_port_set_status("menu_comm_auto");
        display_lvgl_set_mode("AUTO");
        display_lvgl_set_status("menu_auto");
        action_feedback(action, source, "OK", "AUTO");
        break;
    case SYSTEM_ACTION_COMM_WIFI:
        app_core_set_comm_mode(APP_COMM_WIFI);
        system_menu_set_comm_mode(SYSTEM_COMM_WIFI);
        display_port_set_status("menu_comm_wifi");
        display_lvgl_set_mode("WIFI");
        display_lvgl_set_status("menu_wifi");
        action_feedback(action, source, "OK", "WIFI");
        break;
    case SYSTEM_ACTION_COMM_BLE:
        if (!ensure_ble_started()) {
            action_feedback(action, source, "FAIL", "BLE start");
            err = ESP_FAIL;
            break;
        }
        app_core_set_comm_mode(APP_COMM_BLE);
        system_menu_set_comm_mode(SYSTEM_COMM_BLE);
        display_port_set_status("menu_comm_ble");
        display_lvgl_set_mode("BLE");
        display_lvgl_set_status("menu_ble");
        action_feedback(action, source, "OK", "BLE");
        break;
    case SYSTEM_ACTION_UART_BAUD_115200:
        err = apply_uart_baud_action(action, 115200, source);
        break;
    case SYSTEM_ACTION_UART_BAUD_921600:
        err = apply_uart_baud_action(action, 921600, source);
        break;
    case SYSTEM_ACTION_UART_BAUD_2000000:
        err = apply_uart_baud_action(action, 2000000, source);
        break;
    case SYSTEM_ACTION_UART_BAUD_3000000:
        err = apply_uart_baud_action(action, 3000000, source);
        break;
    case SYSTEM_ACTION_BLE_START:
        if (ensure_ble_started()) {
            system_menu_set_message("BLE READY");
            display_lvgl_set_ble_ready(1);
            display_lvgl_set_status("ble_on");
            action_feedback(action, source, "OK", "BLE ready");
        } else {
            action_feedback(action, source, "FAIL", "BLE start");
            err = ESP_FAIL;
        }
        break;
    case SYSTEM_ACTION_HEAP_INFO: {
        char msg[32];
        snprintf(msg, sizeof(msg), "I%uK T%uK",
                 (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024),
                 (unsigned)(esp_get_free_heap_size() / 1024));
        system_menu_set_message(msg);
        display_lvgl_set_status("heap_info");
        log_heap("menu");
        action_feedback(action, source, "OK", msg);
        break;
    }
    case SYSTEM_ACTION_STATS_RESET:
        comm_stats_reset();
        system_menu_set_message("STATS CLEAR");
        display_lvgl_set_status("stats_clear");
        action_feedback(action, source, "OK", "Stats clear");
        break;
    case SYSTEM_ACTION_DISPLAY_INFO: {
        display_port_stats_t stats;
        char msg[SYSTEM_MENU_TEXT_LEN];
        display_port_get_stats(&stats);
        snprintf(msg, sizeof(msg), "%.24s %d/%d",
                 stats.status, stats.scl_gpio, stats.sda_gpio);
        system_menu_set_message(msg);
        display_lvgl_set_status("display_info");
        action_feedback(action, source, "OK", msg);
        break;
    }
    case SYSTEM_ACTION_NONE:
    default:
        break;
    }

    action_unlock();
    return err;
}
