/**
 * @file main.c
 * @brief ESP32-S3 UART-BLE-WiFi
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* =============================================
   功能配置宏 (0=关闭, 1=开启)
   ============================================= */
#define CONFIG_ENABLE_BLE  1   /* BLE 功能开关 */
#define CONFIG_ENABLE_WIFI 1   /* WiFi 功能开关 */
#define CONFIG_BLE_START_ON_BOOT 1   /* 优化 NimBLE 后恢复 BLE 正常开机启动 */

/* 编译时检查：确保至少启用了一个功能 */
#if (CONFIG_ENABLE_BLE == 0) && (CONFIG_ENABLE_WIFI == 0)
#error "请至少启用 BLE 或 WiFi 其中一个功能！"
#endif

#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "app_core.h"
#include "ble_transport.h"
#include "display_lvgl.h"
#include "display_port.h"
#include "health_reporter.h"
#include "input_buttons.h"
#include "router_service.h"
#include "system_menu.h"
#include "ui_controller.h"
#include "uart_transport.h"
#include "web_api.h"
#include "web_static.h"
#include "wifi_manager.h"
#include "wifi_transport.h"
#include "freertos/FreeRTOS.h"
#include "esp_heap_caps.h"
#if CONFIG_ENABLE_WIFI
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_server.h"
#endif

/* =============================================
   1. 配置参数定义
   ============================================= */
static const char *TAG = "UART_BLE_WiFi";
static void log_heap_checkpoint(const char *label);

/* =============================================
   2. 全局变量与状态管理
   ============================================= */

#if CONFIG_ENABLE_WIFI
static httpd_handle_t g_server = NULL;
#endif

static router_mode_t current_router_mode(void)
{
#if CONFIG_ENABLE_BLE && CONFIG_ENABLE_WIFI
    switch (app_core_get_comm_mode()) {
    case APP_COMM_BLE:
        return ROUTER_MODE_BLE;
    case APP_COMM_WIFI:
        return ROUTER_MODE_WIFI;
    case APP_COMM_AUTO:
    default:
        return ROUTER_MODE_IDLE;
    }
#elif CONFIG_ENABLE_BLE
    return ROUTER_MODE_BLE;
#elif CONFIG_ENABLE_WIFI
    return ROUTER_MODE_WIFI;
#else
    return ROUTER_MODE_IDLE;
#endif
}

static void set_router_mode(router_mode_t mode, void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE && CONFIG_ENABLE_WIFI
    if (mode == ROUTER_MODE_BLE) {
        app_core_set_comm_mode(APP_COMM_BLE);
    } else if (mode == ROUTER_MODE_WIFI) {
        app_core_set_comm_mode(APP_COMM_WIFI);
    } else {
        app_core_set_comm_mode(APP_COMM_AUTO);
    }
    display_port_set_status(mode == ROUTER_MODE_WIFI ? "mode_wifi_auto" : "mode_ble_auto");
    display_lvgl_set_mode(mode == ROUTER_MODE_WIFI ? "WIFI" : "BLE");
    display_lvgl_set_status("auto");
#endif
}

static bool ble_route_available(void)
{
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_has_subscribers();
#endif
    return false;
}

static bool wifi_route_available(void)
{
#if CONFIG_ENABLE_WIFI
    return wifi_transport_client_connected();
#else
    return false;
#endif
}

static void uart_send_text(const char *text)
{
    if (text != NULL && text[0] != '\0') {
        (void)uart_transport_write((const uint8_t *)text, strlen(text));
    }
}

static bool app_handle_uart_wifi_command(const uint8_t *data, size_t len)
{
    static const char status_cmd[] = "AT+WIFI?";
    static const char sta_cmd[] = "AT+WIFI=STA";
    static const char apsta_cmd[] = "AT+WIFI=APSTA";
    static const char ap_cmd[] = "AT+WIFI=AP";

    if (data == NULL || len == 0) {
        return false;
    }

    if (len == sizeof(status_cmd) - 1 &&
        memcmp(data, status_cmd, sizeof(status_cmd) - 1) == 0) {
#if CONFIG_ENABLE_WIFI
        wifi_manager_status_t status;
        wifi_manager_get_status(&status);

        char line[256];
        snprintf(line, sizeof(line),
                 "\r\nWIFI STATUS mode=%s ap=%s sta=%s cfg=%u connecting=%u connected=%u ip=%s\r\n",
                 system_menu_net_name(status.mode),
                 status.ap_ssid,
                 status.sta_ssid,
                 status.sta_configured ? 1U : 0U,
                 status.sta_connecting ? 1U : 0U,
                 status.sta_connected ? 1U : 0U,
                 status.sta_ip);
        uart_send_text(line);
#else
        uart_send_text("\r\nWIFI ERR disabled\r\n");
#endif
        return true;
    }

    if (len == sizeof(sta_cmd) - 1 &&
        memcmp(data, sta_cmd, sizeof(sta_cmd) - 1) == 0) {
#if CONFIG_ENABLE_WIFI
        wifi_manager_schedule_net_mode(SYSTEM_NET_STA);
        display_lvgl_set_status("sta_switch");
        uart_send_text("\r\nWIFI STA QUEUED\r\n");
#else
        uart_send_text("\r\nWIFI ERR disabled\r\n");
#endif
        return true;
    }

    if (len == sizeof(apsta_cmd) - 1 &&
        memcmp(data, apsta_cmd, sizeof(apsta_cmd) - 1) == 0) {
#if CONFIG_ENABLE_WIFI
        wifi_manager_schedule_net_mode(SYSTEM_NET_APSTA);
        display_lvgl_set_status("apsta_switch");
        uart_send_text("\r\nWIFI APSTA QUEUED\r\n");
#else
        uart_send_text("\r\nWIFI ERR disabled\r\n");
#endif
        return true;
    }

    if (len == sizeof(ap_cmd) - 1 &&
        memcmp(data, ap_cmd, sizeof(ap_cmd) - 1) == 0) {
#if CONFIG_ENABLE_WIFI
        wifi_manager_schedule_net_mode(SYSTEM_NET_AP);
        display_lvgl_set_status("ap_switch");
        uart_send_text("\r\nWIFI AP QUEUED\r\n");
#else
        uart_send_text("\r\nWIFI ERR disabled\r\n");
#endif
        return true;
    }

    return false;
}

static bool app_handle_uart_control_command(const uint8_t *data, size_t len)
{
    static const char help_cmd[] = "AT+HELP";

    if (data == NULL || len == 0) {
        return false;
    }

    while (len > 0 && (data[len - 1] == '\r' || data[len - 1] == '\n' ||
                       data[len - 1] == ' ' || data[len - 1] == '\t')) {
        len--;
    }

    if (app_handle_uart_wifi_command(data, len)) {
        return true;
    }

    if (len == sizeof(help_cmd) - 1 &&
        memcmp(data, help_cmd, sizeof(help_cmd) - 1) == 0) {
        uart_send_text("\r\nAT COMMANDS\r\n"
                       "AT+HELP\r\n"
                       "AT+WIFI?\r\n"
                       "AT+WIFI=STA\r\n"
                       "AT+WIFI=APSTA\r\n"
                       "AT+WIFI=AP\r\n");
        return true;
    }
    return false;
}

static void app_uart_frame_received(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (data == NULL || len == 0) {
        return;
    }

    if (app_handle_uart_control_command(data, len)) {
        return;
    }

    router_context_t router_ctx = {
        .current_mode = current_router_mode(),
        .ble_available = ble_route_available(),
        .wifi_available = wifi_route_available(),
#if CONFIG_ENABLE_BLE
        .send_ble = ble_spp_transport_send,
#endif
#if CONFIG_ENABLE_WIFI
        .send_wifi = wifi_transport_send,
#endif
        .set_mode = set_router_mode,
        .set_mode_ctx = NULL,
    };
    router_dispatch_uart_frame(&router_ctx, data, len);
}

#if CONFIG_ENABLE_BLE
static void app_ble_frame_received(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (data == NULL || len == 0) {
        return;
    }

#if CONFIG_ENABLE_WIFI
    if (app_core_get_comm_mode() != APP_COMM_BLE) {
        ESP_LOGI(TAG, "<<<<< Mode switched to BLE >>>>>");
        app_core_set_comm_mode(APP_COMM_BLE);
        display_port_set_status("mode_ble");
        display_lvgl_set_mode("BLE");
        display_lvgl_set_status("ble_rx");
        uart_transport_flush();
    }
#endif

    int bytes_written = uart_transport_write(data, len);
    if (bytes_written < 0) {
        ESP_LOGE(TAG, "Failed to write to UART");
    } else {
        ESP_LOGI(TAG, "Forwarded %d bytes to UART", bytes_written);
    }
}

static void app_ble_ready_changed(bool ready, void *ctx)
{
    (void)ctx;
    display_lvgl_set_ble_ready(ready ? 1 : 0);
}

static void app_ble_status_changed(const char *status, void *ctx)
{
    (void)ctx;
    display_lvgl_set_status(status);
}

static void app_ble_log_heap(const char *label, void *ctx)
{
    (void)ctx;
    log_heap_checkpoint(label);
}
#endif

/* =============================================
   3. WiFi/WebSocket 部分代码
   ============================================= */
#if CONFIG_ENABLE_WIFI
static void app_wifi_frame_received(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (data == NULL || len == 0) {
        return;
    }

#if CONFIG_ENABLE_BLE && CONFIG_ENABLE_WIFI
    if (app_core_get_comm_mode() != APP_COMM_WIFI) {
        ESP_LOGI(TAG, "<<<<< Mode switched to WIFI >>>>>");
        app_core_set_comm_mode(APP_COMM_WIFI);
        display_port_set_status("mode_wifi");
        display_lvgl_set_mode("WIFI");
        display_lvgl_set_status("ws_rx");
        uart_transport_flush();
    }
#endif

    int bytes_written = uart_transport_write(data, len);
    if (bytes_written < 0) {
        ESP_LOGE(TAG, "Failed to write to UART");
    }
}

static esp_err_t set_uart_baud(uint32_t baud)
{
    esp_err_t err = uart_transport_set_baud(baud);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "uart_transport_set_baud(%lu) failed: %s",
                 (unsigned long)baud, esp_err_to_name(err));
        return err;
    }

    app_core_set_uart_baud(baud);
    display_port_set_status("uart_baud_updated");
    display_lvgl_set_uart_baud(baud);
    display_lvgl_set_status("baud_ok");
    ESP_LOGI(TAG, "UART baud rate changed to %lu", (unsigned long)baud);
    return ESP_OK;
}

static uint32_t web_api_get_uart_baud(void *ctx)
{
    (void)ctx;
    return app_core_get_uart_baud();
}

static esp_err_t web_api_set_uart_baud(uint32_t baud, void *ctx)
{
    (void)ctx;
    return set_uart_baud(baud);
}

static esp_err_t web_api_send_uart_frame(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    int written = uart_transport_write(data, len);
    return written == (int)len ? ESP_OK : ESP_FAIL;
}

static esp_err_t web_api_apply_menu_action(system_menu_action_t action,
                                           system_action_source_t source,
                                           void *ctx)
{
    (void)ctx;
    return ui_controller_apply_menu_action(action, source);
}

static void web_api_get_wifi_status(wifi_manager_status_t *out, void *ctx)
{
    (void)ctx;
    wifi_manager_get_status(out);
}

static esp_err_t web_api_save_wifi_sta_config(const char *ssid, const char *password, void *ctx)
{
    (void)ctx;
    return wifi_manager_save_sta_config(ssid, password);
}

static esp_err_t web_api_clear_wifi_sta_config(void *ctx)
{
    (void)ctx;
    return wifi_manager_clear_sta_config();
}

static esp_err_t web_api_wifi_scan(wifi_manager_scan_ap_t *out, size_t capacity,
                                   size_t *out_count, void *ctx)
{
    (void)ctx;
    return wifi_manager_scan(out, capacity, out_count);
}

static esp_err_t web_api_wifi_connect_sta(const char *ssid, const char *password,
                                          bool save_on_success,
                                          system_net_mode_t target_mode,
                                          void *ctx)
{
    (void)ctx;
    return wifi_manager_schedule_connect_sta_for_mode(ssid, password,
                                                     save_on_success, 400,
                                                     target_mode);
}

static void web_api_request_wifi_net_mode(system_net_mode_t mode, void *ctx)
{
    (void)ctx;
    wifi_manager_schedule_net_mode(mode);
}

static bool web_api_wifi_client_connected(void *ctx)
{
    (void)ctx;
    return wifi_transport_client_connected();
}

static bool web_api_ble_is_started(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_is_started();
#else
    return false;
#endif
}

static bool web_api_ble_has_subscribers(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_has_subscribers();
#else
    return false;
#endif
}

static esp_err_t web_api_ble_start(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_start();
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

static size_t web_api_send_ble_frame(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_send(data, len);
#else
    (void)data;
    (void)len;
    return 0;
#endif
}

static bool ui_wifi_has_sta_config(void *ctx)
{
    (void)ctx;
    return wifi_manager_has_sta_config();
}

static void ui_wifi_get_status(wifi_manager_status_t *out, void *ctx)
{
    (void)ctx;
    wifi_manager_get_status(out);
}

static void ui_wifi_schedule_net_mode(system_net_mode_t mode, void *ctx)
{
    (void)ctx;
    wifi_manager_schedule_net_mode(mode);
}

static esp_err_t ui_wifi_clear_sta_config(void *ctx)
{
    (void)ctx;
    return wifi_manager_clear_sta_config();
}

static esp_err_t ui_wifi_scan(wifi_manager_scan_ap_t *out, size_t capacity,
                              size_t *out_count, void *ctx)
{
    (void)ctx;
    return wifi_manager_scan(out, capacity, out_count);
}

static esp_err_t ui_wifi_quick_connect_for_mode(const char *ssid,
                                                system_net_mode_t target_mode,
                                                void *ctx)
{
    (void)ctx;
    return wifi_manager_quick_connect_for_mode(ssid, target_mode);
}

static esp_err_t ui_wifi_begin_web_setup(system_net_mode_t target_mode, void *ctx)
{
    (void)ctx;
    return wifi_manager_begin_web_setup(target_mode);
}

static esp_err_t ui_set_uart_baud(uint32_t baud, void *ctx)
{
    (void)ctx;
    return set_uart_baud(baud);
}

static bool ui_ble_is_started(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_is_started();
#else
    return false;
#endif
}

static esp_err_t ui_ble_start(void *ctx)
{
    (void)ctx;
#if CONFIG_ENABLE_BLE
    return ble_spp_transport_start();
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

static void ui_log_heap(const char *label, void *ctx)
{
    (void)ctx;
    log_heap_checkpoint(label);
}

static void app_button_key_received(system_key_t key, void *ctx)
{
    (void)ctx;
    system_menu_snapshot_t menu_before;
    system_menu_get_snapshot(&menu_before);

    bool cleared_text = display_lvgl_clear_text_screen();
    system_menu_action_t action = SYSTEM_ACTION_NONE;
    if (cleared_text && !menu_before.active && key == SYSTEM_KEY_NEXT) {
        (void)system_menu_handle_key(SYSTEM_KEY_OK);
    } else {
        action = system_menu_handle_key(key);
    }
    if (cleared_text) {
        display_port_set_status("key_menu");
    }
    (void)ui_controller_apply_menu_action(action, SYSTEM_ACTION_SOURCE_KEY);
    display_lvgl_request_redraw();
}

/**
 * @brief 启动 HTTP 及 WebSocket 服务器
 */
static void start_webserver(void)
{
  wifi_transport_config_t wifi_transport_config = {
      .on_rx = app_wifi_frame_received,
      .ctx = NULL,
  };
  esp_err_t wifi_transport_ret = wifi_transport_init(&wifi_transport_config);
  if (wifi_transport_ret != ESP_OK) {
    ESP_LOGE(TAG, "Failed to init WiFi transport: %s",
             esp_err_to_name(wifi_transport_ret));
    return;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.uri_match_fn = httpd_uri_match_wildcard;
  config.max_uri_handlers = 96;
  /* 增大 httpd 任务栈，防止 handler 中调用链较深时栈溢出
   * 默认 4096，文件传输 + SPIFFS 调用链建议至少 6144 */
  config.stack_size = 6144;
  /* 开启 LRU 连接回收：当连接数达上限时自动关闭最久未活动的连接，
   * 防止旧的僵尸连接占满槽位导致新客户端无法连入 */
  config.lru_purge_enable = true;
  config.send_wait_timeout = 5;

  config.max_open_sockets = 7;

  ESP_LOGI(TAG, "Starting Web server on port: %d", config.server_port);

  if (httpd_start(&g_server, &config) == ESP_OK) {
    web_api_context_t api_ctx = {
        .get_uart_baud = web_api_get_uart_baud,
        .set_uart_baud = web_api_set_uart_baud,
        .send_uart_frame = web_api_send_uart_frame,
        .apply_menu_action = web_api_apply_menu_action,
        .get_wifi_status = web_api_get_wifi_status,
        .save_wifi_sta_config = web_api_save_wifi_sta_config,
        .clear_wifi_sta_config = web_api_clear_wifi_sta_config,
        .wifi_scan = web_api_wifi_scan,
        .wifi_connect_sta = web_api_wifi_connect_sta,
        .request_wifi_net_mode = web_api_request_wifi_net_mode,
        .wifi_client_connected = web_api_wifi_client_connected,
        .ble_is_started = web_api_ble_is_started,
        .ble_has_subscribers = web_api_ble_has_subscribers,
        .ble_start = web_api_ble_start,
        .send_ble_frame = web_api_send_ble_frame,
        .ctx = NULL,
    };
    esp_err_t api_ret = web_api_register_handlers(g_server, &api_ctx);
    if (api_ret != ESP_OK) {
        ESP_LOGW(TAG, "Some API handlers failed to register: %s",
                 esp_err_to_name(api_ret));
    }
    esp_err_t ws_ret = wifi_transport_register_ws(g_server);
    if (ws_ret != ESP_OK) {
        ESP_LOGW(TAG, "WebSocket handler failed to register: %s",
                 esp_err_to_name(ws_ret));
    }
    esp_err_t static_ret = web_static_register_handlers(g_server);
    if (static_ret != ESP_OK) {
        ESP_LOGW(TAG, "Some static/file handlers failed to register: %s",
                 esp_err_to_name(static_ret));
    }
    ESP_LOGI(TAG, "Web & WebSocket server started! Visit: http://192.168.4.1");
  } else {
    ESP_LOGE(TAG, "Error starting server!");
  }
}

static void wifi_manager_net_mode_changed(system_net_mode_t mode, void *ctx)
{
    (void)ctx;
    system_menu_set_net_mode(mode);
}

static void wifi_manager_message_changed(const char *message, void *ctx)
{
    (void)ctx;
    system_menu_set_message(message);
}

static void wifi_manager_label_changed(const char *label, void *ctx)
{
    (void)ctx;
    display_lvgl_set_wifi_ssid(label);
}

static void wifi_manager_state_changed(const wifi_manager_status_t *status, void *ctx)
{
    (void)ctx;
    if (status == NULL) {
        return;
    }
    display_lvgl_set_wifi_state(status->mode,
                                status->ap_ip,
                                status->sta_ip,
                                status->sta_connecting,
                                status->sta_connected);
}

static void wifi_manager_status_changed(const char *status, void *ctx)
{
    (void)ctx;
    display_lvgl_set_status(status);
}

#endif /* CONFIG_ENABLE_WIFI */

static void log_heap_checkpoint(const char *label)
{
    ESP_LOGI(TAG,
             "%s heap: internal_free=%u internal_min=%u total_free=%u largest=%u",
             label,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

/* =============================================
   6. 主函数 app_main
   ============================================= */

/**
 * @brief 应用程序入口
 */
void app_main(void)
{
    /* ---------------------------------------------------------
     * 1. 初始化 NVS (用于存储 PHY 校准数据和蓝牙绑定信息)
     * --------------------------------------------------------- */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    ESP_ERROR_CHECK(app_core_init(UART_TRANSPORT_DEFAULT_BAUD, APP_COMM_AUTO));
    #if CONFIG_ENABLE_BLE
    ble_transport_config_t ble_config = {
        .on_rx = app_ble_frame_received,
        .on_ready = app_ble_ready_changed,
        .on_status = app_ble_status_changed,
        .log_heap = app_ble_log_heap,
        .ctx = NULL,
    };
    ESP_ERROR_CHECK(ble_spp_transport_init(&ble_config));
    #endif

    ui_controller_config_t ui_config = {
        .wifi_has_sta_config = ui_wifi_has_sta_config,
        .wifi_get_status = ui_wifi_get_status,
        .wifi_schedule_net_mode = ui_wifi_schedule_net_mode,
        .wifi_clear_sta_config = ui_wifi_clear_sta_config,
        .wifi_scan = ui_wifi_scan,
        .wifi_quick_connect_for_mode = ui_wifi_quick_connect_for_mode,
        .wifi_begin_web_setup = ui_wifi_begin_web_setup,
        .set_uart_baud = ui_set_uart_baud,
        .ble_is_started = ui_ble_is_started,
        .ble_start = ui_ble_start,
        .log_heap = ui_log_heap,
        .ctx = NULL,
    };
    ESP_ERROR_CHECK(ui_controller_init(&ui_config));

    /* ---------------------------------------------------------
     * 2. 初始化网络协议栈 (仅在启用 WiFi 时需要)
     * --------------------------------------------------------- */
    #if CONFIG_ENABLE_WIFI
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    #endif

    /* ---------------------------------------------------------
     * 3. 初始化 UART
     * --------------------------------------------------------- */
    ESP_ERROR_CHECK(uart_transport_start(app_uart_frame_received, NULL));

    /* ---------------------------------------------------------
     * 4. 初始化显示端口
     * --------------------------------------------------------- */
    ret = display_port_init();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Display port init failed: %s", esp_err_to_name(ret));
    }
    ret = display_lvgl_start();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "LVGL display init failed: %s", esp_err_to_name(ret));
    } else {
        display_lvgl_set_uart_baud(app_core_get_uart_baud());
        display_lvgl_set_status("lvgl_on");
    }

    input_buttons_config_t button_config = {
        .s4_gpio = INPUT_BUTTON_S4_GPIO,
        .s5_gpio = INPUT_BUTTON_S5_GPIO,
        .on_key = app_button_key_received,
        .ctx = NULL,
    };
    ret = input_buttons_start(&button_config);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Button input init failed: %s", esp_err_to_name(ret));
    }

    /* ---------------------------------------------------------
     * 6. 初始化 WiFi (条件编译)
     * --------------------------------------------------------- */
    #if CONFIG_ENABLE_WIFI
    web_static_init();
    wifi_manager_config_t wifi_manager_config = {
        .on_net_mode = wifi_manager_net_mode_changed,
        .on_message = wifi_manager_message_changed,
        .on_wifi_label = wifi_manager_label_changed,
        .on_wifi_state = wifi_manager_state_changed,
        .on_status = wifi_manager_status_changed,
        .ctx = NULL,
    };
    ESP_ERROR_CHECK(wifi_manager_init(&wifi_manager_config));
    start_webserver();
    #endif

    /* ---------------------------------------------------------
     * 7. 初始化 NimBLE BLE 协议栈 (条件编译)
     * --------------------------------------------------------- */
    #if CONFIG_ENABLE_BLE && CONFIG_BLE_START_ON_BOOT
    ret = ble_spp_transport_start();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "BLE startup failed: %s", esp_err_to_name(ret));
        system_menu_set_message("BLE START FAIL");
    }
    #elif CONFIG_ENABLE_BLE
    ESP_LOGI(TAG, "BLE startup deferred; use menu-controlled startup later");
    display_lvgl_set_ble_ready(0);
    #endif

    ESP_ERROR_CHECK(health_reporter_start());

    /* ---------------------------------------------------------
     * 打印启动配置信息
     * --------------------------------------------------------- */
    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "Firmware build config:");
    #if CONFIG_ENABLE_BLE
    ESP_LOGI(TAG, "  [x] BLE Enabled");
    #else
    ESP_LOGI(TAG, "  [ ] BLE Disabled");
    #endif
    
    #if CONFIG_ENABLE_WIFI
    ESP_LOGI(TAG, "  [x] WiFi Enabled");
    #else
    ESP_LOGI(TAG, "  [ ] WiFi Disabled");
    #endif
    ESP_LOGI(TAG, "========================================");
}
