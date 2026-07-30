#include "wifi_transport.h"

#include <string.h>
#include <stdlib.h>
#include "comm_stats.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

#define WIFI_TRANSPORT_FRAME_MAX_LEN 512
#define WIFI_TRANSPORT_FRAME_POOL_SIZE 96
#define WIFI_TRANSPORT_SEND_QUEUE_LEN WIFI_TRANSPORT_FRAME_POOL_SIZE
#define WIFI_TRANSPORT_SEND_QUEUE_ITEM_SIZE sizeof(wifi_frame_t *)
#define WIFI_TRANSPORT_COALESCE_WAIT_MS 2

static const char *TAG = "wifi_transport";

typedef struct {
    httpd_handle_t hd;
    int fd;
    uint8_t data[WIFI_TRANSPORT_FRAME_MAX_LEN];
    size_t len;
} wifi_frame_t;

static wifi_transport_config_t s_config;
static httpd_handle_t s_server;
static int s_ws_client_fd = -1;
static QueueHandle_t s_send_queue;
static QueueHandle_t s_free_frame_queue;
static wifi_frame_t *s_frame_pool;

static void ws_client_clear_if_current(httpd_handle_t hd, int fd)
{
    if (s_server == hd && s_ws_client_fd == fd) {
        s_ws_client_fd = -1;
        s_server = NULL;
    }
}

static bool ws_client_is_active(void)
{
    if (s_server == NULL || s_ws_client_fd < 0) {
        return false;
    }

    if (httpd_ws_get_fd_info(s_server, s_ws_client_fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
        ws_client_clear_if_current(s_server, s_ws_client_fd);
        return false;
    }
    return true;
}

static wifi_frame_t *frame_acquire(void)
{
    wifi_frame_t *slot = NULL;
    if (s_free_frame_queue == NULL ||
        xQueueReceive(s_free_frame_queue, &slot, 0) != pdTRUE) {
        return NULL;
    }
    return slot;
}

static void frame_release(wifi_frame_t *frame)
{
    if (frame == NULL || s_free_frame_queue == NULL) {
        return;
    }
    if (xQueueSend(s_free_frame_queue, &frame, 0) != pdTRUE) {
        ESP_LOGE(TAG, "Free frame queue accounting error");
    }
}

static bool wifi_frame_merge(wifi_frame_t *target, wifi_frame_t *source)
{
    if (target == NULL || source == NULL || target->hd != source->hd ||
        target->fd != source->fd ||
        target->len + source->len > WIFI_TRANSPORT_FRAME_MAX_LEN) {
        return false;
    }

    memcpy(target->data + target->len, source->data, source->len);
    target->len += source->len;
    frame_release(source);
    return true;
}

static void ws_async_send(void *arg)
{
    wifi_frame_t *frame = (wifi_frame_t *)arg;
    if (frame == NULL) {
        return;
    }

    if (frame->len > 0) {
        httpd_ws_frame_t ws_pkt = {
            .payload = frame->data,
            .len = frame->len,
            .type = HTTPD_WS_TYPE_BINARY,
        };

        esp_err_t err = httpd_ws_send_frame_async(frame->hd, frame->fd, &ws_pkt);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "WS send failed (err=%d), frame dropped", err);
            comm_stats_wifi_tx_failure();
            ws_client_clear_if_current(frame->hd, frame->fd);
        } else {
            comm_stats_wifi_tx_sent(frame->len);
        }
    }
    frame_release(frame);
}

static void wifi_send_task(void *pvParameters)
{
    (void)pvParameters;
    ESP_LOGI(TAG, "WiFi Send Task Started");
    wifi_frame_t *frame = NULL;

    for (;;) {
        if (xQueueReceive(s_send_queue, &frame, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        if (frame == NULL) {
            continue;
        }

        if (frame->hd == NULL || frame->fd < 0) {
            frame_release(frame);
            continue;
        }

        while (frame->len < WIFI_TRANSPORT_FRAME_MAX_LEN) {
            wifi_frame_t *next = NULL;
            if (xQueuePeek(s_send_queue, &next,
                           pdMS_TO_TICKS(WIFI_TRANSPORT_COALESCE_WAIT_MS)) != pdTRUE ||
                next == NULL ||
                next->hd != frame->hd || next->fd != frame->fd ||
                frame->len + next->len > WIFI_TRANSPORT_FRAME_MAX_LEN) {
                break;
            }
            if (xQueueReceive(s_send_queue, &next, 0) != pdTRUE) {
                break;
            }
            if (!wifi_frame_merge(frame, next)) {
                frame_release(next);
                break;
            }
        }

        esp_err_t err = httpd_queue_work(frame->hd, ws_async_send, frame);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed (%d), releasing frame", err);
            comm_stats_wifi_httpd_queue_failure();
            comm_stats_wifi_tx_failure();
            frame_release(frame);
        }
    }
}

static esp_err_t ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        ESP_LOGI(TAG, "WebSocket Handshake done! Client connected.");
        s_ws_client_fd = httpd_req_to_sockfd(req);
        s_server = req->handle;
        return ESP_OK;
    }

    httpd_ws_frame_t ws_pkt;
    memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
    ws_pkt.type = HTTPD_WS_TYPE_BINARY;

    esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "httpd_ws_recv_frame (get len) failed: %d", ret);
        comm_stats_wifi_rx_failure();
        return ret;
    }

    if (ws_pkt.len == 0) {
        return ESP_OK;
    }

    uint8_t *buf = malloc(ws_pkt.len);
    if (buf == NULL) {
        ESP_LOGE(TAG, "Failed to malloc WS RX buffer");
        comm_stats_wifi_rx_failure();
        return ESP_ERR_NO_MEM;
    }
    ws_pkt.payload = buf;

    ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "httpd_ws_recv_frame (read data) failed: %d", ret);
        comm_stats_wifi_rx_failure();
        free(buf);
        return ret;
    }

    comm_stats_wifi_rx_frame(ws_pkt.len);
    if (s_config.on_rx != NULL) {
        s_config.on_rx(buf, ws_pkt.len, s_config.ctx);
    }

    free(buf);
    return ESP_OK;
}

esp_err_t wifi_transport_init(const wifi_transport_config_t *config)
{
    if (config == NULL || config->on_rx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    s_ws_client_fd = -1;
    s_server = NULL;
    if (s_frame_pool == NULL) {
        s_frame_pool = heap_caps_calloc(
            WIFI_TRANSPORT_FRAME_POOL_SIZE,
            sizeof(wifi_frame_t),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_frame_pool == NULL) {
            ESP_LOGW(TAG, "PSRAM frame pool allocation failed; using internal RAM");
            s_frame_pool = heap_caps_calloc(
                WIFI_TRANSPORT_FRAME_POOL_SIZE,
                sizeof(wifi_frame_t),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        }
        if (s_frame_pool == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (s_free_frame_queue == NULL) {
        s_free_frame_queue = xQueueCreateWithCaps(
            WIFI_TRANSPORT_FRAME_POOL_SIZE,
            sizeof(wifi_frame_t *),
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (s_free_frame_queue == NULL) {
            heap_caps_free(s_frame_pool);
            s_frame_pool = NULL;
            return ESP_ERR_NO_MEM;
        }
        for (size_t i = 0; i < WIFI_TRANSPORT_FRAME_POOL_SIZE; i++) {
            wifi_frame_t *frame = &s_frame_pool[i];
            if (xQueueSend(s_free_frame_queue, &frame, 0) != pdTRUE) {
                vQueueDeleteWithCaps(s_free_frame_queue);
                s_free_frame_queue = NULL;
                heap_caps_free(s_frame_pool);
                s_frame_pool = NULL;
                return ESP_FAIL;
            }
        }
    }

    if (s_send_queue == NULL) {
        s_send_queue = xQueueCreateWithCaps(
            WIFI_TRANSPORT_SEND_QUEUE_LEN,
            WIFI_TRANSPORT_SEND_QUEUE_ITEM_SIZE,
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_send_queue == NULL) {
            ESP_LOGW(TAG, "PSRAM send queue allocation failed; using internal RAM");
            s_send_queue = xQueueCreateWithCaps(
                WIFI_TRANSPORT_SEND_QUEUE_LEN,
                WIFI_TRANSPORT_SEND_QUEUE_ITEM_SIZE,
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        }
        if (s_send_queue == NULL) {
            return ESP_ERR_NO_MEM;
        }

        if (xTaskCreate(wifi_send_task, "wifi_send", 4096, NULL, 7, NULL) != pdPASS) {
            vQueueDeleteWithCaps(s_send_queue);
            s_send_queue = NULL;
            return ESP_ERR_NO_MEM;
        }
    }

    return ESP_OK;
}

esp_err_t wifi_transport_register_ws(httpd_handle_t server)
{
    if (server == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    const httpd_uri_t ws = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
    };
    return httpd_register_uri_handler(server, &ws);
}

bool wifi_transport_client_connected(void)
{
    return ws_client_is_active();
}

size_t wifi_transport_send(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0 ||
        !ws_client_is_active() || s_send_queue == NULL) {
        if (data != NULL && len > 0) {
            comm_stats_wifi_no_client_drop(len);
        }
        return 0;
    }

    httpd_handle_t server = s_server;
    int client_fd = s_ws_client_fd;
    size_t queued = 0;

    while (queued < len) {
        wifi_frame_t *frame = frame_acquire();
        if (frame == NULL) {
            comm_stats_wifi_pool_exhausted();
            break;
        }

        frame->hd = server;
        frame->fd = client_fd;
        frame->len = MIN(len - queued, WIFI_TRANSPORT_FRAME_MAX_LEN);
        memcpy(frame->data, data + queued, frame->len);

        if (xQueueSend(s_send_queue, &frame, 0) != pdTRUE) {
            comm_stats_wifi_queue_full();
            frame_release(frame);
            break;
        }

        queued += frame->len;
        comm_stats_wifi_tx_queued(frame->len);
    }

    return queued;
}
