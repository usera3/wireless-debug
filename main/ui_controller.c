#include "ui_controller.h"

#include <stdio.h>
#include "app_core.h"
#include "display_lvgl.h"
#include "display_port.h"
#include "esp_heap_caps.h"
#include "esp_system.h"

static ui_controller_config_t s_config;

static bool wifi_has_sta_config(void)
{
    return s_config.wifi_has_sta_config != NULL &&
           s_config.wifi_has_sta_config(s_config.ctx);
}

static void wifi_schedule_net_mode(system_net_mode_t mode)
{
    if (s_config.wifi_schedule_net_mode != NULL) {
        s_config.wifi_schedule_net_mode(mode, s_config.ctx);
    }
}

static void wifi_clear_sta_config(void)
{
    if (s_config.wifi_clear_sta_config != NULL) {
        (void)s_config.wifi_clear_sta_config(s_config.ctx);
    }
}

static void set_uart_baud(uint32_t baud)
{
    if (s_config.set_uart_baud != NULL) {
        (void)s_config.set_uart_baud(baud, s_config.ctx);
    }
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

esp_err_t ui_controller_init(const ui_controller_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_config = *config;
    return ESP_OK;
}

void ui_controller_apply_menu_action(system_menu_action_t action)
{
    switch (action) {
    case SYSTEM_ACTION_NET_AP:
        system_menu_set_net_mode(SYSTEM_NET_AP);
        system_menu_set_message("AP SWITCHING");
        display_port_set_status("menu_ap");
        display_lvgl_set_status("ap_switch");
        wifi_schedule_net_mode(SYSTEM_NET_AP);
        break;
    case SYSTEM_ACTION_NET_STA:
        if (!wifi_has_sta_config()) {
            system_menu_set_net_mode(SYSTEM_NET_AP);
            system_menu_set_message("STA NEED CFG");
            display_port_set_status("menu_sta_pending");
            display_lvgl_set_status("sta_need_cfg");
            break;
        }
        system_menu_set_net_mode(SYSTEM_NET_STA);
        system_menu_set_message("STA SWITCHING");
        display_port_set_status("menu_sta");
        display_lvgl_set_status("sta_switch");
        wifi_schedule_net_mode(SYSTEM_NET_STA);
        break;
    case SYSTEM_ACTION_NET_STA_CLEAR:
        wifi_clear_sta_config();
        system_menu_set_net_mode(SYSTEM_NET_AP);
        system_menu_set_message("STA CFG CLEAR");
        display_port_set_status("menu_sta_clear");
        display_lvgl_set_status("sta_clear");
        wifi_schedule_net_mode(SYSTEM_NET_AP);
        break;
    case SYSTEM_ACTION_COMM_AUTO:
        app_core_set_comm_mode(APP_COMM_AUTO);
        display_port_set_status("menu_comm_auto");
        display_lvgl_set_mode("AUTO");
        display_lvgl_set_status("menu_auto");
        break;
    case SYSTEM_ACTION_COMM_WIFI:
        app_core_set_comm_mode(APP_COMM_WIFI);
        display_port_set_status("menu_comm_wifi");
        display_lvgl_set_mode("WIFI");
        display_lvgl_set_status("menu_wifi");
        break;
    case SYSTEM_ACTION_COMM_BLE:
        if (!ensure_ble_started()) {
            break;
        }
        app_core_set_comm_mode(APP_COMM_BLE);
        display_port_set_status("menu_comm_ble");
        display_lvgl_set_mode("BLE");
        display_lvgl_set_status("menu_ble");
        break;
    case SYSTEM_ACTION_UART_BAUD_115200:
        set_uart_baud(115200);
        break;
    case SYSTEM_ACTION_UART_BAUD_921600:
        set_uart_baud(921600);
        break;
    case SYSTEM_ACTION_UART_BAUD_2000000:
        set_uart_baud(2000000);
        break;
    case SYSTEM_ACTION_UART_BAUD_3000000:
        set_uart_baud(3000000);
        break;
    case SYSTEM_ACTION_BLE_START:
        if (ensure_ble_started()) {
            system_menu_set_message("BLE READY");
            display_lvgl_set_ble_ready(1);
            display_lvgl_set_status("ble_on");
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
        break;
    }
    case SYSTEM_ACTION_NONE:
    default:
        break;
    }
}
