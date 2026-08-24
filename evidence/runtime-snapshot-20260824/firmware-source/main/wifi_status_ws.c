#include "wifi_status_ws.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"

typedef struct {
    httpd_handle_t server;
    int fd;
} wifi_status_ws_client_t;

static const char *TAG = "wifi_status_ws";
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static httpd_handle_t s_server;
static int s_client_fd = -1;
static wifi_manager_status_t s_latest_status;
static bool s_have_status;
static bool s_send_queued;

static const char *mode_name(system_net_mode_t mode)
{
    switch (mode) {
    case SYSTEM_NET_STA:
        return "STA";
    case SYSTEM_NET_APSTA:
        return "APSTA";
    case SYSTEM_NET_AP:
    default:
        return "AP";
    }
}

static void json_escape(const char *source, char *dest, size_t capacity)
{
    static const char hex[] = "0123456789abcdef";
    size_t out = 0;

    if (dest == NULL || capacity == 0) {
        return;
    }
    if (source == NULL) {
        dest[0] = '\0';
        return;
    }

    for (const unsigned char *p = (const unsigned char *)source;
         *p != '\0' && out + 1 < capacity; p++) {
        const char *escape = NULL;
        switch (*p) {
        case '"':
            escape = "\\\"";
            break;
        case '\\':
            escape = "\\\\";
            break;
        case '\b':
            escape = "\\b";
            break;
        case '\f':
            escape = "\\f";
            break;
        case '\n':
            escape = "\\n";
            break;
        case '\r':
            escape = "\\r";
            break;
        case '\t':
            escape = "\\t";
            break;
        default:
            break;
        }

        if (escape != NULL) {
            size_t len = strlen(escape);
            if (out + len >= capacity) {
                break;
            }
            memcpy(dest + out, escape, len);
            out += len;
        } else if (*p < 0x20U) {
            if (out + 6 >= capacity) {
                break;
            }
            dest[out++] = '\\';
            dest[out++] = 'u';
            dest[out++] = '0';
            dest[out++] = '0';
            dest[out++] = hex[*p >> 4U];
            dest[out++] = hex[*p & 0x0FU];
        } else {
            dest[out++] = (char)*p;
        }
    }
    dest[out] = '\0';
}

static void clear_client_if_current(httpd_handle_t server, int fd)
{
    portENTER_CRITICAL(&s_state_lock);
    if (s_server == server && s_client_fd == fd) {
        s_client_fd = -1;
    }
    portEXIT_CRITICAL(&s_state_lock);
}

static void client_context_free(void *ctx)
{
    wifi_status_ws_client_t *client = (wifi_status_ws_client_t *)ctx;
    if (client == NULL) {
        return;
    }
    clear_client_if_current(client->server, client->fd);
    free(client);
}

static void send_latest_work(void *arg)
{
    (void)arg;
    httpd_handle_t server;
    int fd;
    wifi_manager_status_t status;
    bool have_status;

    portENTER_CRITICAL(&s_state_lock);
    server = s_server;
    fd = s_client_fd;
    status = s_latest_status;
    have_status = s_have_status;
    s_send_queued = false;
    portEXIT_CRITICAL(&s_state_lock);

    if (!have_status || server == NULL || fd < 0 ||
        httpd_ws_get_fd_info(server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        clear_client_if_current(server, fd);
        return;
    }

    char ap_ssid[200];
    char sta_ssid[200];
    json_escape(status.ap_ssid, ap_ssid, sizeof(ap_ssid));
    json_escape(status.sta_ssid, sta_ssid, sizeof(sta_ssid));

    char payload[640];
    int payload_len = snprintf(
        payload, sizeof(payload),
        "{\"type\":\"wifi_status\",\"mode\":\"%s\","
        "\"ap_ssid\":\"%s\",\"ap_ip\":\"%s\","
        "\"sta_ssid\":\"%s\",\"sta_configured\":%s,"
        "\"sta_connecting\":%s,\"sta_connected\":%s,"
        "\"sta_ip\":\"%s\"}",
        mode_name(status.mode), ap_ssid, status.ap_ip, sta_ssid,
        status.sta_configured ? "true" : "false",
        status.sta_connecting ? "true" : "false",
        status.sta_connected ? "true" : "false", status.sta_ip);
    if (payload_len < 0 || (size_t)payload_len >= sizeof(payload)) {
        ESP_LOGW(TAG, "WiFi status snapshot exceeds payload buffer");
        return;
    }

    httpd_ws_frame_t frame = {
        .payload = (uint8_t *)payload,
        .len = (size_t)payload_len,
        .type = HTTPD_WS_TYPE_TEXT,
    };
    (void)httpd_sess_update_lru_counter(server, fd);
    esp_err_t err = httpd_ws_send_frame_async(server, fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "WiFi status WebSocket send failed: %s", esp_err_to_name(err));
        clear_client_if_current(server, fd);
    }
}

static void queue_latest(void)
{
    httpd_handle_t server = NULL;
    bool should_queue = false;

    portENTER_CRITICAL(&s_state_lock);
    if (!s_send_queued && s_server != NULL && s_client_fd >= 0 && s_have_status) {
        s_send_queued = true;
        server = s_server;
        should_queue = true;
    }
    portEXIT_CRITICAL(&s_state_lock);

    if (should_queue && httpd_queue_work(server, send_latest_work, NULL) != ESP_OK) {
        portENTER_CRITICAL(&s_state_lock);
        s_send_queued = false;
        portEXIT_CRITICAL(&s_state_lock);
    }
}

static esp_err_t status_ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        int fd = httpd_req_to_sockfd(req);
        wifi_status_ws_client_t *client = calloc(1, sizeof(*client));
        if (client == NULL) {
            return ESP_ERR_NO_MEM;
        }
        client->server = req->handle;
        client->fd = fd;
        req->sess_ctx = client;
        req->free_ctx = client_context_free;

        httpd_handle_t old_server;
        int old_fd;
        portENTER_CRITICAL(&s_state_lock);
        old_server = s_server;
        old_fd = s_client_fd;
        s_server = req->handle;
        s_client_fd = fd;
        portEXIT_CRITICAL(&s_state_lock);

        if (old_server != NULL && old_fd >= 0 &&
            (old_server != req->handle || old_fd != fd)) {
            (void)httpd_sess_trigger_close(old_server, old_fd);
        }

        wifi_manager_status_t status;
        wifi_manager_get_status(&status);
        wifi_status_ws_publish(&status);
        ESP_LOGI(TAG, "WiFi status WebSocket connected fd=%d", fd);
        return ESP_OK;
    }

    httpd_ws_frame_t frame = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        clear_client_if_current(req->handle, httpd_req_to_sockfd(req));
        return err;
    }
    if (frame.len > 64U) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (frame.len > 0U) {
        uint8_t payload[64];
        frame.payload = payload;
        err = httpd_ws_recv_frame(req, &frame, sizeof(payload));
        if (err != ESP_OK) {
            clear_client_if_current(req->handle, httpd_req_to_sockfd(req));
            return err;
        }
    }
    (void)httpd_sess_update_lru_counter(req->handle, httpd_req_to_sockfd(req));
    return ESP_OK;
}

esp_err_t wifi_status_ws_register(httpd_handle_t server)
{
    if (server == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    const httpd_uri_t status_ws = {
        .uri = "/ws/wifi-status",
        .method = HTTP_GET,
        .handler = status_ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
    };
    esp_err_t err = httpd_register_uri_handler(server, &status_ws);
    if (err == ESP_OK) {
        portENTER_CRITICAL(&s_state_lock);
        s_server = server;
        portEXIT_CRITICAL(&s_state_lock);
    }
    return err;
}

void wifi_status_ws_publish(const wifi_manager_status_t *status)
{
    if (status == NULL) {
        return;
    }
    portENTER_CRITICAL(&s_state_lock);
    s_latest_status = *status;
    s_have_status = true;
    portEXIT_CRITICAL(&s_state_lock);
    queue_latest();
}

bool wifi_status_ws_client_connected(void)
{
    httpd_handle_t server;
    int fd;
    portENTER_CRITICAL(&s_state_lock);
    server = s_server;
    fd = s_client_fd;
    portEXIT_CRITICAL(&s_state_lock);

    bool connected = server != NULL && fd >= 0 &&
                     httpd_ws_get_fd_info(server, fd) == HTTPD_WS_CLIENT_WEBSOCKET;
    if (!connected) {
        clear_client_if_current(server, fd);
    }
    return connected;
}
