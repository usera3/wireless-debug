#include "web_api.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "comm_stats.h"
#include "display_lvgl.h"
#include "display_port.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "http_utils.h"
#include "motor_diag.h"
#include "uart_transport.h"

static web_api_context_t s_ctx;

typedef enum {
    WEB_WIFI_SCAN_IDLE,
    WEB_WIFI_SCAN_SCANNING,
    WEB_WIFI_SCAN_DONE,
    WEB_WIFI_SCAN_FAIL,
} web_wifi_scan_state_t;

static SemaphoreHandle_t s_wifi_scan_mutex;
static web_wifi_scan_state_t s_wifi_scan_state = WEB_WIFI_SCAN_IDLE;
static wifi_manager_scan_ap_t s_wifi_scan_aps[WIFI_MANAGER_SCAN_MAX_APS];
static size_t s_wifi_scan_count;
static esp_err_t s_wifi_scan_error = ESP_OK;
static int64_t s_wifi_scan_started_us;
static int64_t s_wifi_scan_finished_us;

static int64_t scan_elapsed_ms(void)
{
    if (s_wifi_scan_started_us <= 0) {
        return 0;
    }
    int64_t end_us = s_wifi_scan_finished_us > 0 ? s_wifi_scan_finished_us : esp_timer_get_time();
    return (end_us - s_wifi_scan_started_us) / 1000;
}

static int64_t scan_duration_ms(void)
{
    if (s_wifi_scan_started_us <= 0 || s_wifi_scan_finished_us <= 0) {
        return 0;
    }
    return (s_wifi_scan_finished_us - s_wifi_scan_started_us) / 1000;
}

static const web_api_context_t *api_ctx(void)
{
    return &s_ctx;
}

static bool parse_json_string_field(const char *body, const char *field, char *out, size_t out_size)
{
    if (body == NULL || field == NULL || out == NULL || out_size == 0) {
        return false;
    }

    char needle[40];
    snprintf(needle, sizeof(needle), "\"%s\"", field);
    const char *p = strstr(body, needle);
    if (p == NULL) {
        return false;
    }
    p = strchr(p + strlen(needle), ':');
    if (p == NULL) {
        return false;
    }
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        p++;
    }
    if (*p != '"') {
        return false;
    }
    p++;

    size_t n = 0;
    while (*p != '\0' && *p != '"' && n + 1 < out_size) {
        if (*p == '\\' && p[1] != '\0') {
            p++;
        }
        out[n++] = *p++;
    }
    out[n] = '\0';
    return *p == '"';
}

static bool parse_json_uint_field(const char *body, const char *field, uint32_t *out)
{
    if (body == NULL || field == NULL || out == NULL) {
        return false;
    }

    char needle[40];
    snprintf(needle, sizeof(needle), "\"%s\"", field);
    const char *p = strstr(body, needle);
    if (p == NULL) {
        return false;
    }
    p = strchr(p + strlen(needle), ':');
    if (p == NULL) {
        return false;
    }
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        p++;
    }
    if (*p < '0' || *p > '9') {
        return false;
    }
    *out = (uint32_t)strtoul(p, NULL, 10);
    return true;
}

static const char *find_json_value(const char *body, const char *field)
{
    if (body == NULL || field == NULL) {
        return NULL;
    }

    char needle[40];
    snprintf(needle, sizeof(needle), "\"%s\"", field);
    const char *p = strstr(body, needle);
    if (p == NULL) {
        return NULL;
    }
    p = strchr(p + strlen(needle), ':');
    if (p == NULL) {
        return NULL;
    }
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        p++;
    }
    return p;
}

static bool parse_u16_text(const char *text, uint16_t *out)
{
    if (text == NULL || out == NULL) {
        return false;
    }

    while (*text == ' ' || *text == '\t' || *text == '"' || *text == '\'') {
        text++;
    }
    char *end = NULL;
    unsigned long value = strtoul(text, &end, 0);
    if (end == text || value > 0xFFFFUL) {
        return false;
    }
    *out = (uint16_t)value;
    return true;
}

static bool parse_json_u16_field(const char *body, const char *field, uint16_t *out)
{
    char text[24] = {0};
    uint32_t value = 0;

    if (parse_json_string_field(body, field, text, sizeof(text))) {
        return parse_u16_text(text, out);
    }
    if (parse_json_uint_field(body, field, &value) && value <= 0xFFFFU) {
        *out = (uint16_t)value;
        return true;
    }
    return false;
}

static bool parse_json_number_field(const char *body, const char *field, double *out)
{
    const char *p = find_json_value(body, field);
    if (p == NULL || out == NULL) {
        return false;
    }
    if (*p == '"') {
        p++;
    }
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        char *hex_end = NULL;
        unsigned long raw = strtoul(p, &hex_end, 0);
        if (hex_end != p) {
            *out = (double)raw;
            return true;
        }
    }
    char *end = NULL;
    double value = strtod(p, &end);
    if (end == p) {
        return false;
    }
    *out = value;
    return true;
}

static bool parse_json_bool_field(const char *body, const char *field, bool *out)
{
    const char *p = find_json_value(body, field);
    if (p == NULL || out == NULL) {
        return false;
    }
    if (strncmp(p, "true", 4) == 0 || strncmp(p, "1", 1) == 0) {
        *out = true;
        return true;
    }
    if (strncmp(p, "false", 5) == 0 || strncmp(p, "0", 1) == 0) {
        *out = false;
        return true;
    }
    return false;
}

static size_t json_escape_string(const char *src, char *dst, size_t dst_size)
{
    size_t n = 0;

    if (dst == NULL || dst_size == 0) {
        return 0;
    }
    if (src == NULL) {
        src = "";
    }

    while (*src != '\0' && n + 1 < dst_size) {
        char c = *src++;
        const char *esc = NULL;

        switch (c) {
        case '\\':
            esc = "\\\\";
            break;
        case '"':
            esc = "\\\"";
            break;
        case '\n':
            esc = "\\n";
            break;
        case '\r':
            esc = "\\r";
            break;
        case '\t':
            esc = "\\t";
            break;
        default:
            break;
        }

        if (esc != NULL) {
            while (*esc != '\0' && n + 1 < dst_size) {
                dst[n++] = *esc++;
            }
        } else if ((unsigned char)c >= 0x20U) {
            dst[n++] = c;
        }
    }
    dst[n] = '\0';
    return n;
}

static bool str_ieq(const char *a, const char *b)
{
    if (a == NULL || b == NULL) {
        return false;
    }

    while (*a != '\0' && *b != '\0') {
        char ca = *a++;
        char cb = *b++;
        if (ca >= 'A' && ca <= 'Z') {
            ca = (char)(ca - 'A' + 'a');
        }
        if (cb >= 'A' && cb <= 'Z') {
            cb = (char)(cb - 'A' + 'a');
        }
        if (ca != cb) {
            return false;
        }
    }
    return *a == '\0' && *b == '\0';
}

static bool parse_key_body(const char *body, char *key, size_t key_size)
{
    if (body == NULL || key == NULL || key_size == 0) {
        return false;
    }

    const char *p = strstr(body, "\"key\"");
    if (p != NULL) {
        p = strchr(p, ':');
        if (p == NULL) {
            return false;
        }
        p++;
    } else {
        p = body;
    }

    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' ||
           *p == '"' || *p == '\'') {
        p++;
    }

    size_t n = 0;
    while (*p != '\0' && *p != '"' && *p != '\'' && *p != ',' &&
           *p != '}' && *p != '&' && *p != ' ' && *p != '\t' &&
           n + 1 < key_size) {
        char c = *p++;
        if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
        }
        key[n++] = c;
    }
    key[n] = '\0';
    return n > 0;
}

static const char *menu_action_name(system_menu_action_t action)
{
    switch (action) {
    case SYSTEM_ACTION_NET_AP:
        return "net_ap";
    case SYSTEM_ACTION_NET_STA:
        return "net_sta";
    case SYSTEM_ACTION_NET_STA_QUICK:
        return "net_sta_quick";
    case SYSTEM_ACTION_NET_STA_WEB_SETUP:
        return "net_sta_web_setup";
    case SYSTEM_ACTION_NET_STA_QUICK_CONNECT:
        return "net_sta_quick_connect";
    case SYSTEM_ACTION_NET_STA_CLEAR:
        return "net_sta_clear";
    case SYSTEM_ACTION_COMM_AUTO:
        return "comm_auto";
    case SYSTEM_ACTION_COMM_WIFI:
        return "comm_wifi";
    case SYSTEM_ACTION_COMM_BLE:
        return "comm_ble";
    case SYSTEM_ACTION_UART_BAUD_115200:
        return "uart_baud_115200";
    case SYSTEM_ACTION_UART_BAUD_921600:
        return "uart_baud_921600";
    case SYSTEM_ACTION_UART_BAUD_2000000:
        return "uart_baud_2000000";
    case SYSTEM_ACTION_UART_BAUD_3000000:
        return "uart_baud_3000000";
    case SYSTEM_ACTION_BLE_START:
        return "ble_start";
    case SYSTEM_ACTION_HEAP_INFO:
        return "heap_info";
    case SYSTEM_ACTION_STATS_RESET:
        return "stats_reset";
    case SYSTEM_ACTION_DISPLAY_INFO:
        return "display_info";
    case SYSTEM_ACTION_NONE:
    default:
        return "none";
    }
}

static esp_err_t apply_action(system_menu_action_t action, system_action_source_t source)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->apply_menu_action != NULL) {
        return ctx->apply_menu_action(action, source, ctx->ctx);
    }
    return ESP_ERR_INVALID_STATE;
}

static esp_err_t set_uart_baud(uint32_t baud)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->set_uart_baud == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->set_uart_baud(baud, ctx->ctx);
}

static uint32_t get_uart_baud(void)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->get_uart_baud == NULL) {
        return UART_TRANSPORT_DEFAULT_BAUD;
    }
    return ctx->get_uart_baud(ctx->ctx);
}

static void get_wifi_status(wifi_manager_status_t *out)
{
    const web_api_context_t *ctx = api_ctx();
    if (out == NULL) {
        return;
    }

    if (ctx->get_wifi_status != NULL) {
        ctx->get_wifi_status(out, ctx->ctx);
        return;
    }

    memset(out, 0, sizeof(*out));
    out->mode = SYSTEM_NET_AP;
    snprintf(out->sta_ip, sizeof(out->sta_ip), "-");
}

static esp_err_t save_wifi_sta_config(const char *ssid, const char *password)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->save_wifi_sta_config == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->save_wifi_sta_config(ssid, password, ctx->ctx);
}

static esp_err_t wifi_scan_aps(wifi_manager_scan_ap_t *out, size_t capacity,
                               size_t *out_count)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->wifi_scan == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->wifi_scan(out, capacity, out_count, ctx->ctx);
}

static esp_err_t wifi_connect_sta(const char *ssid, const char *password,
                                  bool save_on_success)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->wifi_connect_sta == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->wifi_connect_sta(ssid, password, save_on_success, ctx->ctx);
}

static bool wifi_client_connected(void)
{
    const web_api_context_t *ctx = api_ctx();
    return ctx->wifi_client_connected != NULL && ctx->wifi_client_connected(ctx->ctx);
}

static bool ble_is_started(void)
{
    const web_api_context_t *ctx = api_ctx();
    return ctx->ble_is_started != NULL && ctx->ble_is_started(ctx->ctx);
}

static bool ble_has_subscribers(void)
{
    const web_api_context_t *ctx = api_ctx();
    return ctx->ble_has_subscribers != NULL && ctx->ble_has_subscribers(ctx->ctx);
}

static size_t send_ble_frame(const uint8_t *data, size_t len)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->send_ble_frame == NULL || data == NULL || len == 0) {
        return 0;
    }
    return ctx->send_ble_frame(data, len, ctx->ctx);
}

static system_menu_action_t uart_baud_action(uint32_t baud)
{
    switch (baud) {
    case 115200:
        return SYSTEM_ACTION_UART_BAUD_115200;
    case 921600:
        return SYSTEM_ACTION_UART_BAUD_921600;
    case 2000000:
        return SYSTEM_ACTION_UART_BAUD_2000000;
    case 3000000:
        return SYSTEM_ACTION_UART_BAUD_3000000;
    default:
        return SYSTEM_ACTION_NONE;
    }
}

static esp_err_t send_uart_frame(const uint8_t *data, size_t len)
{
    const web_api_context_t *ctx = api_ctx();
    if (ctx->send_uart_frame == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return ctx->send_uart_frame(data, len, ctx->ctx);
}

static esp_err_t uart_baud_get_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    char resp[32];
    snprintf(resp, sizeof(resp), "{\"baud\":%lu}", (unsigned long)get_uart_baud());
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t uart_baud_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 64) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[65] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint32_t baud = 0;
    if (!parse_json_uint_field(body, "baud", &baud)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing baud field\"}");
        return ESP_OK;
    }

    if (baud < UART_TRANSPORT_MIN_BAUD || baud > UART_TRANSPORT_MAX_BAUD) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"baud out of range (1200~5000000)\"}");
        return ESP_OK;
    }

    esp_err_t err;
    system_menu_action_t action = uart_baud_action(baud);
    if (action != SYSTEM_ACTION_NONE) {
        err = apply_action(action, SYSTEM_ACTION_SOURCE_WEB);
    } else {
        err = set_uart_baud(baud);
    }
    if (err != ESP_OK) {
        char resp[80];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"set baud failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char resp[64];
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"baud\":%lu}", (unsigned long)baud);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t uart_baud_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, OPTIONS", "Content-Type");
}

static esp_err_t wifi_status_handler(httpd_req_t *req)
{
    wifi_manager_status_t status;
    get_wifi_status(&status);
    http_prepare_json(req);

    char resp[320];
    snprintf(resp, sizeof(resp),
             "{\"mode\":\"%s\",\"ap_ssid\":\"%s\",\"sta_ssid\":\"%s\","
             "\"sta_configured\":%s,\"sta_connecting\":%s,"
             "\"sta_connected\":%s,\"sta_ip\":\"%s\"}",
             system_menu_net_name(status.mode),
             status.ap_ssid,
             status.sta_ssid,
             status.sta_configured ? "true" : "false",
             status.sta_connecting ? "true" : "false",
             status.sta_connected ? "true" : "false",
             status.sta_ip);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t wifi_sta_config_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 256) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[257] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char ssid[33] = {0};
    char password[65] = {0};
    if (!parse_json_string_field(body, "ssid", ssid, sizeof(ssid)) || ssid[0] == '\0') {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing ssid\"}");
        return ESP_OK;
    }
    parse_json_string_field(body, "password", password, sizeof(password));

    esp_err_t err = save_wifi_sta_config(ssid, password);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp), "{\"ok\":false,\"msg\":\"save failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    system_menu_set_message("STA CFG SAVED");
    display_lvgl_set_status("sta_cfg");

    char resp[96];
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"ssid\":\"%s\"}", ssid);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t wifi_sta_delete_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    esp_err_t err = apply_action(SYSTEM_ACTION_NET_STA_CLEAR, SYSTEM_ACTION_SOURCE_WEB);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp), "{\"ok\":false,\"msg\":\"clear failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }
    return http_send_json_ok(req);
}

static esp_err_t wifi_sta_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, DELETE, OPTIONS", "Content-Type");
}

static const char *wifi_scan_state_name(web_wifi_scan_state_t state)
{
    switch (state) {
    case WEB_WIFI_SCAN_SCANNING:
        return "scanning";
    case WEB_WIFI_SCAN_DONE:
        return "done";
    case WEB_WIFI_SCAN_FAIL:
        return "fail";
    case WEB_WIFI_SCAN_IDLE:
    default:
        return "idle";
    }
}

static void wifi_scan_task(void *arg)
{
    (void)arg;
    wifi_manager_scan_ap_t aps[WIFI_MANAGER_SCAN_MAX_APS];
    size_t count = 0;

    vTaskDelay(pdMS_TO_TICKS(300));
    esp_err_t err = wifi_scan_aps(aps, WIFI_MANAGER_SCAN_MAX_APS, &count);

    if (s_wifi_scan_mutex != NULL &&
        xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        s_wifi_scan_finished_us = esp_timer_get_time();
        memset(s_wifi_scan_aps, 0, sizeof(s_wifi_scan_aps));
        if (err == ESP_OK) {
            if (count > WIFI_MANAGER_SCAN_MAX_APS) {
                count = WIFI_MANAGER_SCAN_MAX_APS;
            }
            memcpy(s_wifi_scan_aps, aps, sizeof(aps[0]) * count);
            s_wifi_scan_count = count;
            s_wifi_scan_error = ESP_OK;
            s_wifi_scan_state = WEB_WIFI_SCAN_DONE;
        } else {
            s_wifi_scan_count = 0;
            s_wifi_scan_error = err;
            s_wifi_scan_state = WEB_WIFI_SCAN_FAIL;
        }
        xSemaphoreGive(s_wifi_scan_mutex);
    }

    vTaskDelete(NULL);
}

static esp_err_t wifi_scan_start_async(bool force)
{
    bool should_start = false;

    if (s_wifi_scan_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(200)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_wifi_scan_state == WEB_WIFI_SCAN_SCANNING) {
        xSemaphoreGive(s_wifi_scan_mutex);
        return ESP_OK;
    }
    if (force || s_wifi_scan_state == WEB_WIFI_SCAN_IDLE) {
        s_wifi_scan_state = WEB_WIFI_SCAN_SCANNING;
        s_wifi_scan_count = 0;
        s_wifi_scan_error = ESP_OK;
        s_wifi_scan_started_us = esp_timer_get_time();
        s_wifi_scan_finished_us = 0;
        memset(s_wifi_scan_aps, 0, sizeof(s_wifi_scan_aps));
        should_start = true;
    }
    xSemaphoreGive(s_wifi_scan_mutex);

    if (!should_start) {
        return ESP_OK;
    }
    if (xTaskCreate(wifi_scan_task, "wifi_scan_api", 4096, NULL, 4, NULL) != pdPASS) {
        if (xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(200)) == pdTRUE) {
            s_wifi_scan_state = WEB_WIFI_SCAN_FAIL;
            s_wifi_scan_error = ESP_ERR_NO_MEM;
            s_wifi_scan_finished_us = esp_timer_get_time();
            xSemaphoreGive(s_wifi_scan_mutex);
        }
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static bool wifi_scan_refresh_requested(httpd_req_t *req)
{
    char query[64];

    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
        return false;
    }
    return strstr(query, "refresh=1") != NULL ||
           strstr(query, "refresh=true") != NULL;
}

static esp_err_t wifi_scan_handler(httpd_req_t *req)
{
    wifi_manager_scan_ap_t aps[WIFI_MANAGER_SCAN_MAX_APS] = {0};
    size_t count = 0;
    web_wifi_scan_state_t state = WEB_WIFI_SCAN_IDLE;
    esp_err_t scan_error = ESP_OK;
    int64_t elapsed_ms = 0;
    int64_t duration_ms = 0;
    bool refresh = wifi_scan_refresh_requested(req);

    http_prepare_json(req);

    if (s_wifi_scan_mutex == NULL) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"state\":\"fail\",\"msg\":\"scan not ready\"}");
        return ESP_OK;
    }

    bool start_scan = refresh;
    if (!start_scan &&
        xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        start_scan = s_wifi_scan_state == WEB_WIFI_SCAN_IDLE;
        xSemaphoreGive(s_wifi_scan_mutex);
    }

    if (start_scan) {
        esp_err_t start_err = wifi_scan_start_async(refresh);
        if (start_err != ESP_OK) {
            char resp[112];
            snprintf(resp, sizeof(resp),
                     "{\"ok\":false,\"state\":\"fail\",\"msg\":\"scan start failed:%d\"}",
                     start_err);
            httpd_resp_sendstr(req, resp);
            return ESP_OK;
        }
    }

    if (xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"state\":\"fail\",\"msg\":\"scan busy\"}");
        return ESP_OK;
    }
    state = s_wifi_scan_state;
    count = s_wifi_scan_count;
    if (count > WIFI_MANAGER_SCAN_MAX_APS) {
        count = WIFI_MANAGER_SCAN_MAX_APS;
    }
    memcpy(aps, s_wifi_scan_aps, sizeof(aps[0]) * count);
    scan_error = s_wifi_scan_error;
    elapsed_ms = scan_elapsed_ms();
    duration_ms = scan_duration_ms();
    xSemaphoreGive(s_wifi_scan_mutex);

    if (state == WEB_WIFI_SCAN_FAIL) {
        char resp[160];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"state\":\"fail\",\"msg\":\"scan failed:%d\","
                 "\"elapsed_ms\":%lld,\"duration_ms\":%lld,\"aps\":[]}",
                 scan_error,
                 (long long)elapsed_ms,
                 (long long)duration_ms);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char head[144];
    snprintf(head, sizeof(head),
             "{\"ok\":true,\"state\":\"%s\",\"elapsed_ms\":%lld,"
             "\"duration_ms\":%lld,\"aps\":[",
             wifi_scan_state_name(state),
             (long long)elapsed_ms,
             (long long)duration_ms);
    httpd_resp_sendstr_chunk(req, head);
    for (size_t i = 0; i < count; i++) {
        char ssid[80];
        char item[176];
        json_escape_string(aps[i].ssid, ssid, sizeof(ssid));
        snprintf(item, sizeof(item),
                 "%s{\"ssid\":\"%s\",\"rssi\":%d,\"auth\":%u,\"saved\":%s}",
                 i == 0 ? "" : ",",
                 ssid,
                 (int)aps[i].rssi,
                 (unsigned)aps[i].authmode,
                 aps[i].saved ? "true" : "false");
        httpd_resp_sendstr_chunk(req, item);
    }
    httpd_resp_sendstr_chunk(req, "]}");
    httpd_resp_sendstr_chunk(req, NULL);
    return ESP_OK;
}

static esp_err_t wifi_connect_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 256) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[257] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char ssid[33] = {0};
    char password[65] = {0};
    bool save_on_success = true;
    if (!parse_json_string_field(body, "ssid", ssid, sizeof(ssid)) || ssid[0] == '\0') {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing ssid\"}");
        return ESP_OK;
    }
    parse_json_string_field(body, "password", password, sizeof(password));
    (void)parse_json_bool_field(body, "save", &save_on_success);
    (void)parse_json_bool_field(body, "save_on_success", &save_on_success);

    esp_err_t err = wifi_connect_sta(ssid, password, save_on_success);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp), "{\"ok\":false,\"msg\":\"connect failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    system_menu_set_message("STA CONNECTING");
    display_port_set_status("wifi_connect");
    display_lvgl_set_status("sta_conn");
    display_lvgl_set_wifi_ssid(ssid);

    char esc_ssid[80];
    char resp[160];
    json_escape_string(ssid, esc_ssid, sizeof(esc_ssid));
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"state\":\"connecting\",\"ssid\":\"%s\",\"save\":%s}",
             esc_ssid,
             save_on_success ? "true" : "false");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t wifi_scan_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, OPTIONS", "Content-Type");
}

static esp_err_t wifi_connect_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, OPTIONS", "Content-Type");
}

static esp_err_t input_key_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 64) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[65] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char key_name[12];
    system_key_t key;
    if (!parse_key_body(body, key_name, sizeof(key_name)) ||
        !system_menu_key_from_name(key_name, &key)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"unknown key\"}");
        return ESP_OK;
    }

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
    (void)apply_action(action, SYSTEM_ACTION_SOURCE_KEY);
    display_lvgl_request_redraw();

    char resp[96];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"key\":\"%s\",\"action\":\"%s\"}",
             system_menu_key_name(key), menu_action_name(action));
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t input_key_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, OPTIONS", "Content-Type");
}

static esp_err_t input_keys_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    httpd_resp_sendstr(req,
                       "{\"ok\":true,"
                       "\"keys\":[\"next\",\"up\",\"down\",\"ok\",\"back\"],"
                       "\"note\":\"up/down are accepted aliases for next\"}");
    return ESP_OK;
}

static esp_err_t display_text_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 768) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[769] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char title[64] = {0};
    char line1[128] = {0};
    char line2[128] = {0};
    char line3[128] = {0};
    char line4[128] = {0};
    char footer[64] = {0};
    parse_json_string_field(body, "title", title, sizeof(title));
    parse_json_string_field(body, "line1", line1, sizeof(line1));
    parse_json_string_field(body, "line2", line2, sizeof(line2));
    parse_json_string_field(body, "line3", line3, sizeof(line3));
    parse_json_string_field(body, "line4", line4, sizeof(line4));
    parse_json_string_field(body, "footer", footer, sizeof(footer));

    display_lvgl_set_text_screen(title, line1, line2, line3, line4, footer);
    display_port_set_status("text_screen");
    return http_send_json_ok(req);
}

static esp_err_t display_text_clear_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    display_lvgl_clear_text_screen();
    display_port_set_status("text_screen_clear");
    return http_send_json_ok(req);
}

static esp_err_t display_scroll_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 768) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[769] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char title[32] = {0};
    char text[513] = {0};
    char footer[32] = {0};
    parse_json_string_field(body, "title", title, sizeof(title));
    parse_json_string_field(body, "footer", footer, sizeof(footer));
    if (!parse_json_string_field(body, "text", text, sizeof(text)) || text[0] == '\0') {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing text\"}");
        return ESP_OK;
    }

    display_lvgl_set_text_scroll(title, text, footer);
    display_port_set_status("text_scroll");
    return http_send_json_ok(req);
}

static esp_err_t display_text_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, DELETE, OPTIONS", "Content-Type");
}

static esp_err_t device_status_handler(httpd_req_t *req)
{
    system_menu_snapshot_t menu;
    display_port_stats_t display;
    comm_stats_snapshot_t stats;
    system_menu_get_snapshot(&menu);
    display_port_get_stats(&display);
    comm_stats_get_snapshot(&stats);
    http_prepare_json(req);

    char resp[1536];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"net\":\"%s\",\"comm\":\"%s\",\"uart_baud\":%lu,"
             "\"ble_ready\":%s,\"wifi_ws_client\":%s,"
             "\"display_backend\":\"%s\",\"display_status\":\"%s\","
             "\"menu_active\":%s,\"menu_title\":\"%s\",\"menu_message\":\"%s\","
             "\"comm_stats\":{"
             "\"uart\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,\"tx_bytes\":%llu,"
             "\"tx_failures\":%llu,\"overflows\":%llu},"
             "\"ble\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,\"tx_bytes\":%llu,"
             "\"notify_failures\":%llu,\"no_subscriber_drops\":%llu,"
             "\"dropped_bytes\":%llu,\"alloc_failures\":%llu},"
             "\"wifi\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,"
             "\"tx_queued_bytes\":%llu,\"tx_sent_bytes\":%llu,"
             "\"tx_failures\":%llu,\"no_client_drops\":%llu,"
             "\"pool_exhausted\":%llu,\"queue_full\":%llu,"
             "\"httpd_queue_failures\":%llu,\"rx_failures\":%llu},"
             "\"route\":{\"idle_drops\":%llu,\"unavailable_drops\":%llu,"
             "\"partial_drops\":%llu,\"dropped_bytes\":%llu}},"
             "\"motor_params\":{\"count\":%u,\"capacity\":%u}}",
             system_menu_net_name(menu.net_mode),
             system_menu_comm_name(menu.comm_mode),
             (unsigned long)menu.uart_baud,
             menu.ble_ready ? "true" : "false",
             wifi_client_connected() ? "true" : "false",
             display.backend,
             display.status,
             menu.active ? "true" : "false",
             menu.title,
             menu.message,
             (unsigned long long)stats.uart_rx_frames,
             (unsigned long long)stats.uart_rx_bytes,
             (unsigned long long)stats.uart_tx_bytes,
             (unsigned long long)stats.uart_tx_failures,
             (unsigned long long)stats.uart_overflows,
             (unsigned long long)stats.ble_rx_frames,
             (unsigned long long)stats.ble_rx_bytes,
             (unsigned long long)stats.ble_tx_bytes,
             (unsigned long long)stats.ble_notify_failures,
             (unsigned long long)stats.ble_no_subscriber_drops,
             (unsigned long long)stats.ble_dropped_bytes,
             (unsigned long long)stats.ble_alloc_failures,
             (unsigned long long)stats.wifi_rx_frames,
             (unsigned long long)stats.wifi_rx_bytes,
             (unsigned long long)stats.wifi_tx_queued_bytes,
             (unsigned long long)stats.wifi_tx_sent_bytes,
             (unsigned long long)stats.wifi_tx_failures,
             (unsigned long long)stats.wifi_no_client_drops,
             (unsigned long long)stats.wifi_pool_exhausted,
             (unsigned long long)stats.wifi_queue_full,
             (unsigned long long)stats.wifi_httpd_queue_failures,
             (unsigned long long)stats.wifi_rx_failures,
             (unsigned long long)stats.route_idle_drops,
             (unsigned long long)stats.route_unavailable_drops,
             (unsigned long long)stats.route_partial_drops,
             (unsigned long long)stats.route_dropped_bytes,
             (unsigned)motor_diag_param_count(),
             (unsigned)motor_diag_param_capacity());
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t comm_mode_get_handler(httpd_req_t *req)
{
    system_menu_snapshot_t menu;
    system_menu_get_snapshot(&menu);
    http_prepare_json(req);

    char resp[128];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"mode\":\"%s\",\"uart_baud\":%lu}",
             system_menu_comm_name(menu.comm_mode),
             (unsigned long)menu.uart_baud);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t comm_mode_set_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 64) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[65] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char mode[12] = {0};
    if (!parse_json_string_field(body, "mode", mode, sizeof(mode))) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing mode\"}");
        return ESP_OK;
    }

    system_menu_action_t action = SYSTEM_ACTION_NONE;
    if (strcmp(mode, "auto") == 0 || strcmp(mode, "AUTO") == 0) {
        action = SYSTEM_ACTION_COMM_AUTO;
    } else if (strcmp(mode, "wifi") == 0 || strcmp(mode, "WIFI") == 0) {
        action = SYSTEM_ACTION_COMM_WIFI;
    } else if (strcmp(mode, "ble") == 0 || strcmp(mode, "BLE") == 0) {
        action = SYSTEM_ACTION_COMM_BLE;
    } else {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"mode must be auto/wifi/ble\"}");
        return ESP_OK;
    }

    esp_err_t action_err = apply_action(action, SYSTEM_ACTION_SOURCE_WEB);
    if (action_err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"action failed:%d\"}", action_err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }
    display_lvgl_request_redraw();
    return http_send_json_ok(req);
}

static esp_err_t comm_mode_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, OPTIONS", "Content-Type");
}

static void send_comm_stats_json(httpd_req_t *req, const comm_stats_snapshot_t *stats)
{
    char resp[1024];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,"
             "\"uart\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,\"tx_bytes\":%llu,"
             "\"tx_failures\":%llu,\"overflows\":%llu},"
             "\"ble\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,\"tx_bytes\":%llu,"
             "\"notify_failures\":%llu,\"no_subscriber_drops\":%llu,"
             "\"dropped_bytes\":%llu,\"alloc_failures\":%llu},"
             "\"wifi\":{\"rx_frames\":%llu,\"rx_bytes\":%llu,"
             "\"tx_queued_bytes\":%llu,\"tx_sent_bytes\":%llu,"
             "\"tx_failures\":%llu,\"no_client_drops\":%llu,"
             "\"pool_exhausted\":%llu,\"queue_full\":%llu,"
             "\"httpd_queue_failures\":%llu,\"rx_failures\":%llu},"
             "\"route\":{\"idle_drops\":%llu,\"unavailable_drops\":%llu,"
             "\"partial_drops\":%llu,\"dropped_bytes\":%llu}}",
             (unsigned long long)stats->uart_rx_frames,
             (unsigned long long)stats->uart_rx_bytes,
             (unsigned long long)stats->uart_tx_bytes,
             (unsigned long long)stats->uart_tx_failures,
             (unsigned long long)stats->uart_overflows,
             (unsigned long long)stats->ble_rx_frames,
             (unsigned long long)stats->ble_rx_bytes,
             (unsigned long long)stats->ble_tx_bytes,
             (unsigned long long)stats->ble_notify_failures,
             (unsigned long long)stats->ble_no_subscriber_drops,
             (unsigned long long)stats->ble_dropped_bytes,
             (unsigned long long)stats->ble_alloc_failures,
             (unsigned long long)stats->wifi_rx_frames,
             (unsigned long long)stats->wifi_rx_bytes,
             (unsigned long long)stats->wifi_tx_queued_bytes,
             (unsigned long long)stats->wifi_tx_sent_bytes,
             (unsigned long long)stats->wifi_tx_failures,
             (unsigned long long)stats->wifi_no_client_drops,
             (unsigned long long)stats->wifi_pool_exhausted,
             (unsigned long long)stats->wifi_queue_full,
             (unsigned long long)stats->wifi_httpd_queue_failures,
             (unsigned long long)stats->wifi_rx_failures,
             (unsigned long long)stats->route_idle_drops,
             (unsigned long long)stats->route_unavailable_drops,
             (unsigned long long)stats->route_partial_drops,
             (unsigned long long)stats->route_dropped_bytes);
    httpd_resp_sendstr(req, resp);
}

static esp_err_t comm_stats_handler(httpd_req_t *req)
{
    comm_stats_snapshot_t stats;
    comm_stats_get_snapshot(&stats);
    http_prepare_json(req);
    send_comm_stats_json(req, &stats);
    return ESP_OK;
}

static esp_err_t comm_stats_reset_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    (void)apply_action(SYSTEM_ACTION_STATS_RESET, SYSTEM_ACTION_SOURCE_WEB);
    return http_send_json_ok(req);
}

static esp_err_t comm_stats_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, DELETE, OPTIONS", "Content-Type");
}

static int hex_value(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static esp_err_t parse_hex_bytes(const char *hex, uint8_t **out, size_t *out_len)
{
    if (hex == NULL || out == NULL || out_len == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    size_t digits = 0;
    for (const char *p = hex; *p != '\0'; p++) {
        if (hex_value(*p) >= 0) {
            digits++;
        } else if (*p != ' ' && *p != '\t' && *p != '\r' && *p != '\n' &&
                   *p != ':' && *p != '-' && *p != '_') {
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (digits == 0 || (digits & 1U) != 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t *buf = malloc(digits / 2U);
    if (buf == NULL) {
        return ESP_ERR_NO_MEM;
    }

    size_t index = 0;
    int hi = -1;
    for (const char *p = hex; *p != '\0'; p++) {
        int v = hex_value(*p);
        if (v < 0) {
            continue;
        }
        if (hi < 0) {
            hi = v;
        } else {
            buf[index++] = (uint8_t)((hi << 4) | v);
            hi = -1;
        }
    }

    *out = buf;
    *out_len = index;
    return ESP_OK;
}

static esp_err_t uart_tx_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 768) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[769] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char text[512] = {0};
    char hex[512] = {0};
    uint8_t *data = NULL;
    size_t len = 0;
    esp_err_t err = ESP_OK;

    if (parse_json_string_field(body, "hex", hex, sizeof(hex))) {
        err = parse_hex_bytes(hex, &data, &len);
        if (err != ESP_OK) {
            httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid hex\"}");
            return ESP_OK;
        }
    } else if (parse_json_string_field(body, "text", text, sizeof(text))) {
        len = strlen(text);
        if (len == 0) {
            httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"empty text\"}");
            return ESP_OK;
        }
        data = (uint8_t *)text;
    } else {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing hex or text\"}");
        return ESP_OK;
    }

    err = send_uart_frame(data, len);
    if (data != (uint8_t *)text) {
        free(data);
    }
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"uart tx failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char resp[64];
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"bytes\":%u}", (unsigned)len);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t uart_tx_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, OPTIONS", "Content-Type");
}

static esp_err_t wifi_mode_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 64) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[65] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char mode[12] = {0};
    if (!parse_json_string_field(body, "mode", mode, sizeof(mode))) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing mode\"}");
        return ESP_OK;
    }

    system_menu_action_t action;
    if (strcmp(mode, "ap") == 0 || strcmp(mode, "AP") == 0) {
        action = SYSTEM_ACTION_NET_AP;
    } else if (strcmp(mode, "sta") == 0 || strcmp(mode, "STA") == 0) {
        action = SYSTEM_ACTION_NET_STA;
    } else {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"mode must be ap/sta\"}");
        return ESP_OK;
    }

    esp_err_t err = apply_action(action, SYSTEM_ACTION_SOURCE_WEB);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp), "{\"ok\":false,\"msg\":\"wifi mode failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }
    return http_send_json_ok(req);
}

static esp_err_t wifi_mode_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, OPTIONS", "Content-Type");
}

static esp_err_t ws_status_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    char resp[64];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"client_connected\":%s}",
             wifi_client_connected() ? "true" : "false");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t ble_status_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    char resp[96];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"started\":%s,\"subscribed\":%s}",
             ble_is_started() ? "true" : "false",
             ble_has_subscribers() ? "true" : "false");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t ble_start_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    esp_err_t err = apply_action(SYSTEM_ACTION_BLE_START, SYSTEM_ACTION_SOURCE_WEB);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp), "{\"ok\":false,\"msg\":\"ble start failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }
    return http_send_json_ok(req);
}

static esp_err_t ble_tx_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 768) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[769] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char text[512] = {0};
    char hex[512] = {0};
    uint8_t *data = NULL;
    size_t len = 0;
    esp_err_t err = ESP_OK;

    if (parse_json_string_field(body, "hex", hex, sizeof(hex))) {
        err = parse_hex_bytes(hex, &data, &len);
        if (err != ESP_OK) {
            httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid hex\"}");
            return ESP_OK;
        }
    } else if (parse_json_string_field(body, "text", text, sizeof(text))) {
        len = strlen(text);
        if (len == 0) {
            httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"empty text\"}");
            return ESP_OK;
        }
        data = (uint8_t *)text;
    } else {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing hex or text\"}");
        return ESP_OK;
    }

    size_t sent = send_ble_frame(data, len);
    if (data != (uint8_t *)text) {
        free(data);
    }

    char resp[96];
    snprintf(resp, sizeof(resp),
             "{\"ok\":%s,\"bytes\":%u,\"sent\":%u,"
             "\"subscribed\":%s}",
             sent == len ? "true" : "false",
             (unsigned)len,
             (unsigned)sent,
             ble_has_subscribers() ? "true" : "false");
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t ble_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, OPTIONS", "Content-Type");
}

static esp_err_t system_health_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    char resp[320];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"uptime_ms\":%llu,"
             "\"heap\":{\"free\":%u,\"min_free\":%u,\"largest\":%u,"
             "\"internal_free\":%u,\"internal_min_free\":%u},"
             "\"restart_reason\":%d}",
             (unsigned long long)(esp_timer_get_time() / 1000ULL),
             (unsigned)esp_get_free_heap_size(),
             (unsigned)esp_get_minimum_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             esp_reset_reason());
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t device_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, DELETE, OPTIONS", "Content-Type");
}

static esp_err_t motor_diag_send_frame_response(httpd_req_t *req,
                                                const motor_diag_frame_t *frame,
                                                bool should_send,
                                                const char *extra_json)
{
    char hex[MOTOR_DIAG_MAX_FRAME_LEN * 2U + 1U];
    char resp[768];
    esp_err_t send_err = ESP_OK;

    if (frame == NULL || motor_diag_hex_encode(frame->data, frame->len,
                                               hex, sizeof(hex)) != ESP_OK) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"frame encode failed\"}");
        return ESP_OK;
    }

    if (should_send) {
        send_err = send_uart_frame(frame->data, frame->len);
        if (send_err == ESP_OK) {
            display_port_set_status("motor_diag_tx");
            display_lvgl_set_status("diag_tx");
        }
    }

    snprintf(resp, sizeof(resp),
             "{\"ok\":%s,\"sent\":%s,\"send_error\":%d,"
             "\"send_error_name\":\"%s\",\"frame\":\"%s\"%s}",
             send_err == ESP_OK ? "true" : "false",
             should_send && send_err == ESP_OK ? "true" : "false",
             send_err,
             esp_err_to_name(send_err),
             hex,
             extra_json == NULL ? "" : extra_json);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t motor_diag_capabilities_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    httpd_resp_sendstr(req,
                       "{\"ok\":true,"
                       "\"profile\":\"motor-diag-open-v1\","
                       "\"slave_default\":255,"
                       "\"protocol\":\"modbus-like-rtu-crc16\","
                       "\"functions\":{\"read_holding\":\"0x03\","
                       "\"read_input\":\"0x04\",\"write_single\":\"0x06\","
                       "\"heartbeat\":\"0x08\",\"write_multi\":\"0x10\","
                       "\"osc_start\":\"0x71\",\"osc_stop\":\"0x72\","
                       "\"osc_rate\":\"0x73\",\"osc_channel\":\"0x75\"},"
                       "\"note\":\"explicit address/type/value commands are accepted; "
                       "ParameterTable metadata can be used by clients when available\","
                       "\"http\":["
                       "{\"method\":\"GET\",\"path\":\"/api/motor/diag/capabilities\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/diag/read\","
                       "\"body\":\"{address,count?,slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/diag/write\","
                       "\"body\":\"{address,value,type:u16|i16|scaled|float32,decimals?,signed?,slave?,send?}\"}"
                       ",{\"method\":\"GET\",\"path\":\"/api/motor/osc/capabilities\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/query\","
                       "\"body\":\"{item:frame_len|max_channels|sample_rate|address,slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/channel\","
                       "\"body\":\"{channel,paramType,address,slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/start\","
                       "\"body\":\"{slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/stop\","
                       "\"body\":\"{slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/heartbeat\","
                       "\"body\":\"{slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/osc/rate\","
                       "\"body\":\"{bytesPerSec,slave?,send?}\"}"
                       ",{\"method\":\"GET\",\"path\":\"/api/motor/params\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/params\","
                       "\"body\":\"{alias,address,unit?,type?,decimals?,signed?,isFloat?,readOnly?,min?,max?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/params/read\","
                       "\"body\":\"{alias,slave?,send?}\"}"
                       ",{\"method\":\"POST\",\"path\":\"/api/motor/params/write\","
                       "\"body\":\"{alias,value,slave?,send?}\"}"
                       "]}");
    return ESP_OK;
}

static esp_err_t motor_diag_read_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 160) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[161] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t address = 0;
    if (!parse_json_u16_field(body, "address", &address)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing address\"}");
        return ESP_OK;
    }

    uint32_t count = 1;
    (void)parse_json_uint_field(body, "count", &count);
    if (count == 0 || count > 125) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"count out of range\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    (void)parse_json_u16_field(body, "slave", &slave);
    if (slave > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = motor_diag_build_read((uint8_t)slave, address,
                                          (uint16_t)count, &frame);
    if (err != ESP_OK) {
        char resp[80];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[96];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"read\",\"address\":%u,\"count\":%lu,\"slave\":%u",
             address, (unsigned long)count, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_diag_write_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 256) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[257] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t address = 0;
    if (!parse_json_u16_field(body, "address", &address)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing address\"}");
        return ESP_OK;
    }

    double value = 0.0;
    if (!parse_json_number_field(body, "value", &value)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing value\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    (void)parse_json_u16_field(body, "slave", &slave);
    if (slave > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    char type[16] = "u16";
    (void)parse_json_string_field(body, "type", type, sizeof(type));
    uint32_t decimals = 0;
    (void)parse_json_uint_field(body, "decimals", &decimals);
    if (decimals > 9) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"decimals out of range\"}");
        return ESP_OK;
    }
    bool signed_value = value < 0.0;
    (void)parse_json_bool_field(body, "signed", &signed_value);
    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    int32_t raw = 0;
    esp_err_t err = ESP_OK;
    if (str_ieq(type, "float32") || str_ieq(type, "float")) {
        err = motor_diag_build_write_float32((uint8_t)slave, address,
                                             (float)value, &frame);
    } else if (str_ieq(type, "scaled")) {
        err = motor_diag_build_write_scaled((uint8_t)slave, address, value,
                                            (uint8_t)decimals, signed_value,
                                            &raw, &frame);
    } else {
        raw = (int32_t)(value >= 0.0 ? value + 0.5 : value - 0.5);
        if (str_ieq(type, "i16") || str_ieq(type, "int16") || signed_value) {
            if (raw < -32768 || raw > 32767) {
                err = ESP_ERR_INVALID_SIZE;
            } else {
                err = motor_diag_build_write_i16((uint8_t)slave, address,
                                                 (int16_t)raw, &frame);
            }
        } else {
            if (raw < 0 || raw > 65535) {
                err = ESP_ERR_INVALID_SIZE;
            } else {
                err = motor_diag_build_write_u16((uint8_t)slave, address,
                                                 (uint16_t)raw, &frame);
            }
        }
    }

    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[160];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"write\",\"address\":%u,"
             "\"raw\":%ld,\"type\":\"%s\",\"slave\":%u",
             address, (long)raw, type, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_diag_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, OPTIONS", "Content-Type");
}

static esp_err_t read_optional_json_body(httpd_req_t *req, char *body, size_t body_size)
{
    if (body == NULL || body_size == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    body[0] = '\0';
    if (req->content_len == 0) {
        return ESP_OK;
    }
    if (req->content_len >= body_size) {
        return ESP_ERR_INVALID_SIZE;
    }
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        return ESP_FAIL;
    }
    body[ret] = '\0';
    return ESP_OK;
}

static bool parse_slave_field(const char *body, uint16_t *slave)
{
    if (slave == NULL) {
        return false;
    }
    *slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    (void)parse_json_u16_field(body, "slave", slave);
    return *slave <= 0xFFU;
}

static bool parse_osc_item_field(const char *body, uint16_t *item,
                                 char *name, size_t name_size)
{
    char text[32] = {0};

    if (item == NULL || name == NULL || name_size == 0) {
        return false;
    }

    if (parse_json_string_field(body, "item", text, sizeof(text)) ||
        parse_json_string_field(body, "query", text, sizeof(text))) {
        if (str_ieq(text, "frame_len") || str_ieq(text, "frame") ||
            str_ieq(text, "frameLength")) {
            *item = MOTOR_DIAG_OSC_QUERY_FRAME_LEN;
            snprintf(name, name_size, "frame_len");
            return true;
        }
        if (str_ieq(text, "max_channels") || str_ieq(text, "channels") ||
            str_ieq(text, "maxChannels")) {
            *item = MOTOR_DIAG_OSC_QUERY_MAX_CHANNELS;
            snprintf(name, name_size, "max_channels");
            return true;
        }
        if (str_ieq(text, "sample_rate") || str_ieq(text, "sampleRate") ||
            str_ieq(text, "rate")) {
            *item = MOTOR_DIAG_OSC_QUERY_SAMPLE_RATE;
            snprintf(name, name_size, "sample_rate");
            return true;
        }
        if (parse_u16_text(text, item)) {
            snprintf(name, name_size, "0x%04X", *item);
            return true;
        }
        return false;
    }

    if (parse_json_u16_field(body, "item", item) ||
        parse_json_u16_field(body, "address", item) ||
        parse_json_u16_field(body, "register", item)) {
        snprintf(name, name_size, "0x%04X", *item);
        return true;
    }
    return false;
}

static esp_err_t motor_osc_capabilities_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    httpd_resp_sendstr(req,
                       "{\"ok\":true,"
                       "\"profile\":\"motor-osc-fc71-v1\","
                       "\"slave_default\":255,"
                       "\"protocol\":\"custom-rtu-crc16\","
                       "\"functions\":{\"query\":\"0x04\","
                       "\"heartbeat\":\"0x08\",\"start\":\"0x71\","
                       "\"stop\":\"0x72\",\"rate\":\"0x73\","
                       "\"channel\":\"0x75\"},"
                       "\"query_items\":{\"frame_len\":0,"
                       "\"max_channels\":1,\"sample_rate\":2},"
                       "\"frame_prefix\":\"slave,function,payload...,crc_lo,crc_hi\","
                       "\"http\":["
                       "{\"method\":\"GET\",\"path\":\"/api/motor/osc/capabilities\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/query\","
                       "\"body\":\"{item|address,slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/channel\","
                       "\"body\":\"{channel,paramType,address,slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/start\","
                       "\"body\":\"{slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/stop\","
                       "\"body\":\"{slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/heartbeat\","
                       "\"body\":\"{slave?,send?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/rate\","
                       "\"body\":\"{bytesPerSec,slave?,send?}\"}"
                       "]}");
    return ESP_OK;
}

static esp_err_t motor_osc_query_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    char body[161];
    esp_err_t body_ret = read_optional_json_body(req, body, sizeof(body));
    if (body_ret == ESP_ERR_INVALID_SIZE) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }
    if (body_ret != ESP_OK) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    if (!parse_slave_field(body, &slave)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    uint16_t item = 0;
    char item_name[24] = {0};
    if (!parse_osc_item_field(body, &item, item_name, sizeof(item_name))) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing item/address\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = motor_diag_build_osc_query((uint8_t)slave, item, &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[128];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"osc_query\",\"item\":\"%s\","
             "\"address\":%u,\"slave\":%u",
             item_name, item, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_osc_channel_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    char body[193];
    esp_err_t body_ret = read_optional_json_body(req, body, sizeof(body));
    if (body_ret == ESP_ERR_INVALID_SIZE || body[0] == '\0') {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }
    if (body_ret != ESP_OK) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    if (!parse_slave_field(body, &slave)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    uint32_t channel = 0;
    if (!parse_json_uint_field(body, "channel", &channel) || channel > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"bad channel\"}");
        return ESP_OK;
    }

    uint16_t param_type = 0;
    if ((!parse_json_u16_field(body, "paramType", &param_type) &&
         !parse_json_u16_field(body, "param_type", &param_type)) ||
        param_type > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"bad paramType\"}");
        return ESP_OK;
    }

    uint16_t address = 0;
    if (!parse_json_u16_field(body, "address", &address) &&
        !parse_json_u16_field(body, "regAddr", &address)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing address\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = motor_diag_build_osc_set_channel((uint8_t)slave,
                                                     (uint8_t)channel,
                                                     (uint8_t)param_type,
                                                     address,
                                                     &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[160];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"osc_channel\",\"channel\":%lu,"
             "\"paramType\":%u,\"address\":%u,\"slave\":%u",
             (unsigned long)channel, param_type, address, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_osc_simple_response(httpd_req_t *req, const char *op,
                                           esp_err_t (*build)(uint8_t,
                                                              motor_diag_frame_t *))
{
    http_prepare_json(req);

    char body[97];
    esp_err_t body_ret = read_optional_json_body(req, body, sizeof(body));
    if (body_ret == ESP_ERR_INVALID_SIZE) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }
    if (body_ret != ESP_OK) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    if (!parse_slave_field(body, &slave)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = build((uint8_t)slave, &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[80];
    snprintf(extra, sizeof(extra), ",\"op\":\"%s\",\"slave\":%u", op, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_osc_start_handler(httpd_req_t *req)
{
    return motor_osc_simple_response(req, "osc_start",
                                     motor_diag_build_osc_start);
}

static esp_err_t motor_osc_stop_handler(httpd_req_t *req)
{
    return motor_osc_simple_response(req, "osc_stop",
                                     motor_diag_build_osc_stop);
}

static esp_err_t motor_osc_heartbeat_handler(httpd_req_t *req)
{
    return motor_osc_simple_response(req, "osc_heartbeat",
                                     motor_diag_build_osc_heartbeat);
}

static esp_err_t motor_osc_rate_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    char body[129];
    esp_err_t body_ret = read_optional_json_body(req, body, sizeof(body));
    if (body_ret == ESP_ERR_INVALID_SIZE || body[0] == '\0') {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }
    if (body_ret != ESP_OK) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    if (!parse_slave_field(body, &slave)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    uint32_t bytes_per_sec = 0;
    if (!parse_json_uint_field(body, "bytesPerSec", &bytes_per_sec) &&
        !parse_json_uint_field(body, "bytes_per_sec", &bytes_per_sec) &&
        !parse_json_uint_field(body, "rate", &bytes_per_sec) &&
        !parse_json_uint_field(body, "bps", &bytes_per_sec)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing bytesPerSec\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = motor_diag_build_osc_rate((uint8_t)slave,
                                              bytes_per_sec,
                                              &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char extra[112];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"osc_rate\",\"bytesPerSec\":%lu,\"slave\":%u",
             (unsigned long)bytes_per_sec, slave);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static bool parse_motor_param_body(const char *body, motor_diag_param_t *param)
{
    if (body == NULL || param == NULL) {
        return false;
    }

    memset(param, 0, sizeof(*param));
    if (!parse_json_string_field(body, "alias", param->alias, sizeof(param->alias)) ||
        param->alias[0] == '\0') {
        return false;
    }
    if (!parse_json_u16_field(body, "address", &param->address) &&
        !parse_json_u16_field(body, "regAddr", &param->address)) {
        return false;
    }
    (void)parse_json_string_field(body, "unit", param->unit, sizeof(param->unit));

    uint32_t decimals = 0;
    if (parse_json_uint_field(body, "decimals", &decimals)) {
        if (decimals > 9) {
            return false;
        }
        param->decimals = (uint8_t)decimals;
    }

    (void)parse_json_bool_field(body, "signed", &param->signed_value);
    (void)parse_json_bool_field(body, "signed_value", &param->signed_value);
    (void)parse_json_bool_field(body, "isFloat", &param->is_float);
    (void)parse_json_bool_field(body, "is_float", &param->is_float);
    (void)parse_json_bool_field(body, "readOnly", &param->read_only);
    (void)parse_json_bool_field(body, "read_only", &param->read_only);

    char type[16] = {0};
    if (parse_json_string_field(body, "type", type, sizeof(type))) {
        if (str_ieq(type, "float") || str_ieq(type, "float32")) {
            param->is_float = true;
        } else if (str_ieq(type, "i16") || str_ieq(type, "int16")) {
            param->signed_value = true;
        }
    }

    if (parse_json_number_field(body, "min", &param->min)) {
        param->has_min = true;
    }
    if (parse_json_number_field(body, "max", &param->max)) {
        param->has_max = true;
    }
    return true;
}

static esp_err_t motor_params_status_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    size_t capacity = motor_diag_param_capacity();
    motor_diag_param_t *params = calloc(capacity, sizeof(params[0]));
    if (params == NULL) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"no memory\"}");
        return ESP_OK;
    }
    size_t count = motor_diag_param_snapshot(params, capacity);
    char resp[256];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"count\":%u,\"capacity\":%u,\"items\":[",
             (unsigned)count,
             (unsigned)capacity);
    httpd_resp_sendstr_chunk(req, resp);
    for (size_t i = 0; i < count; i++) {
        char alias_json[MOTOR_DIAG_ALIAS_MAX * 2U];
        char unit_json[MOTOR_DIAG_UNIT_MAX * 2U];
        char item[384];
        json_escape_string(params[i].alias, alias_json, sizeof(alias_json));
        json_escape_string(params[i].unit, unit_json, sizeof(unit_json));
        snprintf(item, sizeof(item),
                 "%s{\"alias\":\"%s\",\"address\":%u,"
                 "\"address_hex\":\"0x%04X\",\"unit\":\"%s\","
                 "\"type\":\"%s\",\"decimals\":%u,"
                 "\"signed\":%s,\"is_float\":%s,\"read_only\":%s,"
                 "\"has_min\":%s,\"has_max\":%s,"
                 "\"min\":%.9g,\"max\":%.9g}",
                 i == 0 ? "" : ",",
                 alias_json,
                 params[i].address,
                 params[i].address,
                 unit_json,
                 params[i].is_float ? "float32" :
                 (params[i].signed_value ? "i16" :
                  (params[i].decimals > 0 ? "scaled" : "u16")),
                 params[i].decimals,
                 params[i].signed_value ? "true" : "false",
                 params[i].is_float ? "true" : "false",
                 params[i].read_only ? "true" : "false",
                 params[i].has_min ? "true" : "false",
                 params[i].has_max ? "true" : "false",
                 params[i].has_min ? params[i].min : 0.0,
                 params[i].has_max ? params[i].max : 0.0);
        httpd_resp_sendstr_chunk(req, item);
    }
    httpd_resp_sendstr_chunk(req, "]}");
    httpd_resp_sendstr_chunk(req, NULL);
    free(params);
    return ESP_OK;
}

static esp_err_t motor_params_clear_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    motor_diag_param_clear();
    display_port_set_status("motor_params_clear");
    display_lvgl_set_status("param_clear");
    return http_send_json_ok(req);
}

static esp_err_t motor_param_register_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 512) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[513] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    motor_diag_param_t param;
    if (!parse_motor_param_body(body, &param)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing alias/address or bad metadata\"}");
        return ESP_OK;
    }

    esp_err_t err = motor_diag_param_register(&param);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"register failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char alias[64];
    json_escape_string(param.alias, alias, sizeof(alias));
    char resp[192];
    snprintf(resp, sizeof(resp),
             "{\"ok\":true,\"alias\":\"%s\",\"address\":%u,"
             "\"count\":%u,\"capacity\":%u}",
             alias, param.address,
             (unsigned)motor_diag_param_count(),
             (unsigned)motor_diag_param_capacity());
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t motor_param_read_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 160) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[161] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char alias[MOTOR_DIAG_ALIAS_MAX] = {0};
    if (!parse_json_string_field(body, "alias", alias, sizeof(alias)) &&
        !parse_json_string_field(body, "name", alias, sizeof(alias))) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing alias\"}");
        return ESP_OK;
    }

    motor_diag_param_t param;
    if (!motor_diag_param_find(alias, &param)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"param not found\"}");
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    (void)parse_json_u16_field(body, "slave", &slave);
    if (slave > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    esp_err_t err = motor_diag_build_param_read(&param, (uint8_t)slave, &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char alias_json[MOTOR_DIAG_ALIAS_MAX * 2U];
    char unit_json[MOTOR_DIAG_UNIT_MAX * 2U];
    json_escape_string(param.alias, alias_json, sizeof(alias_json));
    json_escape_string(param.unit, unit_json, sizeof(unit_json));

    char extra[256];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"param_read\",\"alias\":\"%s\",\"address\":%u,"
             "\"count\":%u,\"slave\":%u,\"unit\":\"%s\","
             "\"type\":\"%s\",\"decimals\":%u",
             alias_json, param.address,
             param.is_float ? 2U : 1U,
             slave, unit_json,
             param.is_float ? "float32" : (param.signed_value ? "i16" : "u16"),
             param.decimals);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_param_write_handler(httpd_req_t *req)
{
    http_prepare_json(req);

    if (req->content_len == 0 || req->content_len > 256) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"invalid body\"}");
        return ESP_OK;
    }

    char body[257] = {0};
    int ret = httpd_req_recv(req, body, req->content_len);
    if (ret <= 0) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"recv error\"}");
        return ESP_OK;
    }

    char alias[MOTOR_DIAG_ALIAS_MAX] = {0};
    if (!parse_json_string_field(body, "alias", alias, sizeof(alias)) &&
        !parse_json_string_field(body, "name", alias, sizeof(alias))) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing alias\"}");
        return ESP_OK;
    }

    double value = 0.0;
    if (!parse_json_number_field(body, "value", &value)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"missing value\"}");
        return ESP_OK;
    }

    motor_diag_param_t param;
    if (!motor_diag_param_find(alias, &param)) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"param not found\"}");
        return ESP_OK;
    }
    if (param.read_only) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"param is read-only\"}");
        return ESP_OK;
    }
    if ((param.has_min && value < param.min) ||
        (param.has_max && value > param.max)) {
        char resp[160];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"value out of range\","
                 "\"min\":%.9g,\"max\":%.9g}",
                 param.has_min ? param.min : 0.0,
                 param.has_max ? param.max : 0.0);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    uint16_t slave = MOTOR_DIAG_DEFAULT_SLAVE_ID;
    (void)parse_json_u16_field(body, "slave", &slave);
    if (slave > 0xFFU) {
        httpd_resp_sendstr(req, "{\"ok\":false,\"msg\":\"slave out of range\"}");
        return ESP_OK;
    }

    bool should_send = true;
    (void)parse_json_bool_field(body, "send", &should_send);

    motor_diag_frame_t frame;
    int32_t raw = 0;
    esp_err_t err = motor_diag_build_param_write(&param, (uint8_t)slave,
                                                 value, &raw, &frame);
    if (err != ESP_OK) {
        char resp[96];
        snprintf(resp, sizeof(resp),
                 "{\"ok\":false,\"msg\":\"build failed:%d\"}", err);
        httpd_resp_sendstr(req, resp);
        return ESP_OK;
    }

    char alias_json[MOTOR_DIAG_ALIAS_MAX * 2U];
    char unit_json[MOTOR_DIAG_UNIT_MAX * 2U];
    json_escape_string(param.alias, alias_json, sizeof(alias_json));
    json_escape_string(param.unit, unit_json, sizeof(unit_json));

    char extra[320];
    snprintf(extra, sizeof(extra),
             ",\"op\":\"param_write\",\"alias\":\"%s\",\"address\":%u,"
             "\"value\":%.9g,\"raw\":%ld,\"slave\":%u,\"unit\":\"%s\","
             "\"type\":\"%s\",\"decimals\":%u",
             alias_json, param.address, value, (long)raw, slave, unit_json,
             param.is_float ? "float32" : (param.signed_value ? "i16" : "u16"),
             param.decimals);
    return motor_diag_send_frame_response(req, &frame, should_send, extra);
}

static esp_err_t motor_params_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "GET, POST, DELETE, OPTIONS", "Content-Type");
}

static esp_err_t device_capabilities_handler(httpd_req_t *req)
{
    http_prepare_json(req);
    httpd_resp_sendstr(req,
                       "{\"ok\":true,"
                       "\"profile\":\"wireless-debug-device-v1\","
                       "\"domain\":\"motor wireless diagnostics\","
                       "\"limits\":{\"display_text\":512,\"uart_baud_min\":1200,"
                       "\"uart_baud_max\":5000000},"
                       "\"actions\":[\"wifi_ap\",\"wifi_sta\",\"wifi_scan\","
                       "\"wifi_connect\",\"ble_start\","
                       "\"set_comm_mode\",\"set_uart_baud\",\"query_status\","
                       "\"uart_tx_text\",\"uart_tx_hex\",\"ble_tx_text\","
                       "\"ble_tx_hex\",\"display_text\",\"display_scroll\","
                       "\"read_comm_stats\",\"reset_comm_stats\","
                       "\"motor_diag_read\",\"motor_diag_write\","
                       "\"motor_osc_query\",\"motor_osc_channel\","
                       "\"motor_osc_start\",\"motor_osc_stop\","
                       "\"motor_osc_heartbeat\",\"motor_osc_rate\","
                       "\"motor_param_register\",\"motor_param_read\","
                       "\"motor_param_write\"],"
                       "\"guardrails\":[\"motor_diag_write_requires_explicit_address_type_value\","
                       "\"motor_param_write_checks_read_only_and_range\","
                       "\"waveform_record_requires_channel_address_mapping\"],"
                       "\"uart_commands\":[\"AT+HELP\",\"AT+WIFI?\","
                       "\"AT+WIFI=STA\",\"AT+WIFI=AP\"],"
                       "\"websocket\":{\"path\":\"/ws\",\"role\":\"uart_tunnel\"},"
                       "\"http\":["
                       "{\"method\":\"GET\",\"path\":\"/api/device/status\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/device/capabilities\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/system/health\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/comm/mode\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/comm/mode\",\"body\":\"{mode:auto|wifi|ble}\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/comm/stats\"},"
                       "{\"method\":\"DELETE\",\"path\":\"/api/comm/stats\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/input/keys\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/input/key\",\"body\":\"{key}\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/uart/baud\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/uart/baud\",\"body\":\"{baud}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/uart/tx\",\"body\":\"{hex? text?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/display/text\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/display/scroll\",\"body\":\"{title?,text,footer?}\"},"
                       "{\"method\":\"DELETE\",\"path\":\"/api/display/text\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/motor/diag/capabilities\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/diag/read\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/diag/write\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/motor/osc/capabilities\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/query\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/channel\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/start\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/stop\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/heartbeat\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/osc/rate\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/motor/params\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/params\"},"
                       "{\"method\":\"DELETE\",\"path\":\"/api/motor/params\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/params/read\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/motor/params/write\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/wifi/status\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/wifi/scan\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/wifi/connect\",\"body\":\"{ssid,password,save?}\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/wifi/sta\"},"
                       "{\"method\":\"DELETE\",\"path\":\"/api/wifi/sta\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/wifi/mode\",\"body\":\"{mode:ap|sta}\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/ws/status\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/ble/status\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/ble/start\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/ble/tx\",\"body\":\"{hex? text?}\"},"
                       "{\"method\":\"GET\",\"path\":\"/api/excel/list\"},"
                       "{\"method\":\"POST\",\"path\":\"/api/excel/upload\"},"
                       "{\"method\":\"DELETE\",\"path\":\"/api/excel/delete?name=...\"}"
                       "]}");
    return ESP_OK;
}

static esp_err_t menu_status_handler(httpd_req_t *req)
{
    system_menu_snapshot_t menu;
    system_menu_get_snapshot(&menu);
    http_prepare_json(req);

    char resp[1024];
    snprintf(resp, sizeof(resp),
             "{\"active\":%s,\"page\":%u,\"depth\":%u,\"selected\":%u,"
             "\"item_count\":%u,\"scroll_top\":%u,"
             "\"net\":\"%s\",\"comm\":\"%s\",\"uart_baud\":%lu,\"ble_ready\":%s,"
             "\"events\":%lu,\"title\":\"%s\",\"path\":\"%s\","
             "\"rows\":[\"%s\",\"%s\",\"%s\",\"%s\"],"
             "\"footer\":\"%s\",\"message\":\"%s\"}",
             menu.active ? "true" : "false",
             menu.page,
             menu.depth,
             menu.selected,
             menu.item_count,
             menu.scroll_top,
             system_menu_net_name(menu.net_mode),
             system_menu_comm_name(menu.comm_mode),
             (unsigned long)menu.uart_baud,
             menu.ble_ready ? "true" : "false",
             (unsigned long)menu.event_count,
             menu.title,
             menu.path,
             menu.rows[0],
             menu.rows[1],
             menu.rows[2],
             menu.rows[3],
             menu.footer,
             menu.message);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t display_status_handler(httpd_req_t *req)
{
    display_port_stats_t stats;
    display_port_get_stats(&stats);
    http_prepare_json(req);

    char resp[320];
    snprintf(resp, sizeof(resp),
             "{\"enabled\":%s,\"backend\":\"%s\",\"status\":\"%s\","
             "\"width\":%u,\"height\":%u,\"scl_gpio\":%d,"
             "\"sda_gpio\":%d,\"i2c_addr\":\"0x%02x\",\"flush_count\":%lu,"
             "\"status_update_count\":%lu,\"last_flush_bytes\":%lu,"
             "\"last_area\":{\"x1\":%u,\"y1\":%u,\"x2\":%u,\"y2\":%u}}",
             stats.enabled ? "true" : "false",
             stats.backend,
             stats.status,
             stats.width,
             stats.height,
             stats.scl_gpio,
             stats.sda_gpio,
             stats.i2c_addr,
             (unsigned long)stats.flush_count,
             (unsigned long)stats.status_update_count,
             (unsigned long)stats.last_flush_bytes,
             stats.last_area.x1,
             stats.last_area.y1,
             stats.last_area.x2,
             stats.last_area.y2);
    httpd_resp_sendstr(req, resp);
    return ESP_OK;
}

static esp_err_t display_framebuffer_handler(httpd_req_t *req)
{
    uint8_t buf[DISPLAY_FRAMEBUFFER_SIZE];
    size_t len = display_port_copy_framebuffer(buf, sizeof(buf));
    if (len == 0) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "display busy");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/octet-stream");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_send(req, (const char *)buf, len);
    return ESP_OK;
}

esp_err_t web_api_register_handlers(httpd_handle_t server, const web_api_context_t *ctx)
{
    if (server == NULL || ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    s_ctx = *ctx;
    if (s_wifi_scan_mutex == NULL) {
        s_wifi_scan_mutex = xSemaphoreCreateMutex();
        if (s_wifi_scan_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    if (xSemaphoreTake(s_wifi_scan_mutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        s_wifi_scan_state = WEB_WIFI_SCAN_IDLE;
        s_wifi_scan_count = 0;
        s_wifi_scan_error = ESP_OK;
        memset(s_wifi_scan_aps, 0, sizeof(s_wifi_scan_aps));
        xSemaphoreGive(s_wifi_scan_mutex);
    }
    esp_err_t first_error = ESP_OK;

#define REGISTER_API(_uri, _method, _handler) do {                 \
        const httpd_uri_t uri = {                                  \
            .uri = (_uri),                                         \
            .method = (_method),                                   \
            .handler = (_handler),                                 \
        };                                                         \
        esp_err_t err = httpd_register_uri_handler(server, &uri);   \
        if (err != ESP_OK && first_error == ESP_OK) {              \
            first_error = err;                                     \
        }                                                          \
    } while (0)

    REGISTER_API("/api/uart/baud", HTTP_GET, uart_baud_get_handler);
    REGISTER_API("/api/uart/baud", HTTP_POST, uart_baud_handler);
    REGISTER_API("/api/uart/baud", HTTP_OPTIONS, uart_baud_options_handler);
    REGISTER_API("/api/wifi/status", HTTP_GET, wifi_status_handler);
    REGISTER_API("/api/wifi/scan", HTTP_GET, wifi_scan_handler);
    REGISTER_API("/api/wifi/scan", HTTP_OPTIONS, wifi_scan_options_handler);
    REGISTER_API("/api/wifi/connect", HTTP_POST, wifi_connect_handler);
    REGISTER_API("/api/wifi/connect", HTTP_OPTIONS, wifi_connect_options_handler);
    REGISTER_API("/api/wifi/sta", HTTP_POST, wifi_sta_config_handler);
    REGISTER_API("/api/wifi/sta", HTTP_DELETE, wifi_sta_delete_handler);
    REGISTER_API("/api/wifi/sta", HTTP_OPTIONS, wifi_sta_options_handler);
    REGISTER_API("/api/input/key", HTTP_POST, input_key_handler);
    REGISTER_API("/api/input/key", HTTP_OPTIONS, input_key_options_handler);
    REGISTER_API("/api/input/keys", HTTP_GET, input_keys_handler);
    REGISTER_API("/api/input/keys", HTTP_OPTIONS, input_key_options_handler);
    REGISTER_API("/api/device/status", HTTP_GET, device_status_handler);
    REGISTER_API("/api/device/capabilities", HTTP_GET, device_capabilities_handler);
    REGISTER_API("/api/device/capabilities", HTTP_OPTIONS, device_options_handler);
    REGISTER_API("/api/system/health", HTTP_GET, system_health_handler);
    REGISTER_API("/api/comm/mode", HTTP_GET, comm_mode_get_handler);
    REGISTER_API("/api/comm/mode", HTTP_POST, comm_mode_set_handler);
    REGISTER_API("/api/comm/mode", HTTP_OPTIONS, comm_mode_options_handler);
    REGISTER_API("/api/comm/stats", HTTP_GET, comm_stats_handler);
    REGISTER_API("/api/comm/stats", HTTP_DELETE, comm_stats_reset_handler);
    REGISTER_API("/api/comm/stats", HTTP_OPTIONS, comm_stats_options_handler);
    REGISTER_API("/api/uart/tx", HTTP_POST, uart_tx_handler);
    REGISTER_API("/api/uart/tx", HTTP_OPTIONS, uart_tx_options_handler);
    REGISTER_API("/api/display/text", HTTP_POST, display_text_handler);
    REGISTER_API("/api/display/text", HTTP_DELETE, display_text_clear_handler);
    REGISTER_API("/api/display/text", HTTP_OPTIONS, display_text_options_handler);
    REGISTER_API("/api/display/scroll", HTTP_POST, display_scroll_handler);
    REGISTER_API("/api/display/scroll", HTTP_OPTIONS, display_text_options_handler);
    REGISTER_API("/api/wifi/mode", HTTP_POST, wifi_mode_handler);
    REGISTER_API("/api/wifi/mode", HTTP_OPTIONS, wifi_mode_options_handler);
    REGISTER_API("/api/ws/status", HTTP_GET, ws_status_handler);
    REGISTER_API("/api/ws/status", HTTP_OPTIONS, device_options_handler);
    REGISTER_API("/api/ble/status", HTTP_GET, ble_status_handler);
    REGISTER_API("/api/ble/start", HTTP_POST, ble_start_handler);
    REGISTER_API("/api/ble/start", HTTP_OPTIONS, ble_options_handler);
    REGISTER_API("/api/ble/tx", HTTP_POST, ble_tx_handler);
    REGISTER_API("/api/ble/tx", HTTP_OPTIONS, ble_options_handler);
    REGISTER_API("/api/motor/diag/capabilities", HTTP_GET, motor_diag_capabilities_handler);
    REGISTER_API("/api/motor/diag/capabilities", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/diag/read", HTTP_POST, motor_diag_read_handler);
    REGISTER_API("/api/motor/diag/read", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/diag/write", HTTP_POST, motor_diag_write_handler);
    REGISTER_API("/api/motor/diag/write", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/capabilities", HTTP_GET, motor_osc_capabilities_handler);
    REGISTER_API("/api/motor/osc/capabilities", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/query", HTTP_POST, motor_osc_query_handler);
    REGISTER_API("/api/motor/osc/query", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/channel", HTTP_POST, motor_osc_channel_handler);
    REGISTER_API("/api/motor/osc/channel", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/start", HTTP_POST, motor_osc_start_handler);
    REGISTER_API("/api/motor/osc/start", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/stop", HTTP_POST, motor_osc_stop_handler);
    REGISTER_API("/api/motor/osc/stop", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/heartbeat", HTTP_POST, motor_osc_heartbeat_handler);
    REGISTER_API("/api/motor/osc/heartbeat", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/osc/rate", HTTP_POST, motor_osc_rate_handler);
    REGISTER_API("/api/motor/osc/rate", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/params", HTTP_GET, motor_params_status_handler);
    REGISTER_API("/api/motor/params", HTTP_POST, motor_param_register_handler);
    REGISTER_API("/api/motor/params", HTTP_DELETE, motor_params_clear_handler);
    REGISTER_API("/api/motor/params", HTTP_OPTIONS, motor_params_options_handler);
    REGISTER_API("/api/motor/params/read", HTTP_POST, motor_param_read_handler);
    REGISTER_API("/api/motor/params/read", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/motor/params/write", HTTP_POST, motor_param_write_handler);
    REGISTER_API("/api/motor/params/write", HTTP_OPTIONS, motor_diag_options_handler);
    REGISTER_API("/api/menu/status", HTTP_GET, menu_status_handler);
    REGISTER_API("/api/display/status", HTTP_GET, display_status_handler);
    REGISTER_API("/api/display/framebuffer", HTTP_GET, display_framebuffer_handler);

#undef REGISTER_API

    return first_error;
}
