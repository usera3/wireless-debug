#include "cloud_ws_uplink.h"
#include "cloud_ws_downlink_reassembly.h"
#include "cloud_ws_compression_state.h"
#include "cloud_ws_lease.h"
#include "cloud_ws_socket.h"
#include "cloud_waveform_codec.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_transport.h"
#include "esp_transport_tcp.h"
#include "esp_transport_ws.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#define CLOUD_WS_UPLINK_MAX_FRAME 512U
#define CLOUD_WS_UPLINK_QUEUE_DEPTH 128U
#define CLOUD_WS_UPLINK_URI_MAX_LEN 192U
#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 5000
#define CLOUD_WS_UPLINK_WS_BUFFER_SIZE 2048U

typedef struct {
    size_t len;
    uint32_t source_frames;
    uint8_t data[CLOUD_WS_UPLINK_MAX_FRAME];
} cloud_ws_uplink_frame_t;

static const char *TAG = "cloud_ws_uplink";
static cloud_ws_uplink_config_t s_config;
static esp_websocket_client_handle_t s_client;
static QueueHandle_t s_queue;
static TaskHandle_t s_sender_task;
static uint8_t *s_raw_aggregate;
static uint8_t *s_wire_aggregate;
static void *s_compressor_workspace;
static size_t s_compressor_workspace_size;
static cloud_waveform_encoder_t s_waveform_encoder;
static bool s_compression_capable;
static esp_transport_handle_t s_tcp_transport;
static esp_transport_handle_t s_ws_transport;
static bool s_initialized;
static bool s_started;
static bool s_wifi_ready;
static bool s_active;
static cloud_ws_lease_gate_t s_lease_gate;
static bool s_queue_in_psram;
static volatile bool s_connected;
static char s_uri[CLOUD_WS_UPLINK_URI_MAX_LEN];
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_stats_lock = portMUX_INITIALIZER_UNLOCKED;
static cloud_ws_uplink_stats_t s_stats;
static cloud_ws_downlink_reassembly_t s_downlink_reassembly;
static cloud_ws_compression_state_t s_compression_state;

static void stats_increment(uint32_t *counter, uint32_t amount)
{
    portENTER_CRITICAL(&s_stats_lock);
    *counter += amount;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_compression(const cloud_waveform_encode_result_t *result,
                                   uint32_t elapsed_us)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.compression_calls++;
    s_stats.compression_total_us += elapsed_us;
    if (elapsed_us > s_stats.compression_max_us) {
        s_stats.compression_max_us = elapsed_us;
    }
    if (result == NULL) {
        s_stats.compression_failures++;
    } else {
        if (result->codec == CLOUD_WAVEFORM_CODEC_ZLIB) {
            s_stats.compressed_frames++;
        } else {
            s_stats.raw_envelope_frames++;
        }
        if (result->compression_failed) {
            s_stats.compression_failures++;
        }
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_sent_bytes(size_t raw_len, size_t wire_len)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.raw_bytes += raw_len;
    s_stats.wire_bytes += wire_len;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_send(uint32_t elapsed_us)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.send_calls++;
    s_stats.send_total_us += elapsed_us;
    if (elapsed_us > s_stats.send_max_us) {
        s_stats.send_max_us = elapsed_us;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void downlink_reset(void)
{
    cloud_ws_downlink_reassembly_reset(&s_downlink_reassembly);
}

static void handle_downlink_data(const esp_websocket_event_data_t *event)
{
    if (event == NULL ||
        (event->op_code != CLOUD_WS_OPCODE_BINARY &&
         event->op_code != CLOUD_WS_OPCODE_CONTINUATION)) {
        return;
    }
    if (event->data_len < 0 || event->payload_len < 0 || event->payload_offset < 0) {
        downlink_reset();
        stats_increment(&s_stats.downlink_failures, 1);
        return;
    }

    const uint8_t *frame = NULL;
    size_t frame_len = 0;
    cloud_ws_downlink_result_t result = cloud_ws_downlink_reassembly_push(
        &s_downlink_reassembly,
        event->op_code,
        event->fin,
        (size_t)event->payload_len,
        (size_t)event->payload_offset,
        (const uint8_t *)event->data_ptr,
        (size_t)event->data_len,
        &frame,
        &frame_len);
    if (result == CLOUD_WS_DOWNLINK_REJECTED) {
        stats_increment(&s_stats.downlink_failures, 1);
        return;
    }
    if (result != CLOUD_WS_DOWNLINK_COMPLETE) {
        return;
    }
    bool capability_reply = false;
    portENTER_CRITICAL(&s_state_lock);
    capability_reply = cloud_ws_compression_accept_reply(
        &s_compression_state, frame, frame_len);
    portEXIT_CRITICAL(&s_state_lock);
    if (capability_reply) {
        xTaskNotifyGive(s_sender_task);
        ESP_LOGI(TAG, "waveform compression negotiated");
        return;
    }
    if (s_config.on_downlink == NULL ||
        s_config.on_downlink(frame, frame_len, s_config.downlink_ctx) != ESP_OK) {
        stats_increment(&s_stats.downlink_failures, 1);
        return;
    }
    stats_increment(&s_stats.downlink_frames, 1);
    stats_increment(&s_stats.downlink_bytes, (uint32_t)frame_len);
}

static bool fallback_frame(const uint8_t *data, size_t len, uint32_t source_frames)
{
    if (data == NULL || len == 0 || s_config.fallback == NULL) {
        return false;
    }

    bool complete = true;
    size_t offset = 0;
    while (offset < len) {
        size_t chunk_len = len - offset;
        if (chunk_len > CLOUD_WS_UPLINK_MAX_FRAME) {
            chunk_len = CLOUD_WS_UPLINK_MAX_FRAME;
        }
        if (!s_config.fallback(data + offset, chunk_len, s_config.fallback_ctx)) {
            complete = false;
        }
        offset += chunk_len;
    }
    if (complete) {
        stats_increment(&s_stats.queued_fallback_frames, source_frames);
    }
    return complete;
}

static void sender_task(void *arg)
{
    (void)arg;
    cloud_ws_uplink_frame_t chunk;
    cloud_ws_uplink_frame_t next;
    while (true) {
        if (uxQueueMessagesWaiting(s_queue) == 0) {
            (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        } else {
            (void)ulTaskNotifyTake(pdTRUE, 0);
        }

        bool active = false;
        bool should_run = false;
        bool compression_active = false;
        bool offer_pending = false;
        portENTER_CRITICAL(&s_state_lock);
        active = s_active;
        should_run = s_initialized && s_config.enabled && s_client != NULL &&
                     s_wifi_ready;
        compression_active = s_compression_state.active;
        offer_pending = cloud_ws_compression_take_offer(&s_compression_state);
        portEXIT_CRITICAL(&s_state_lock);

        if (should_run && !s_started) {
            if (esp_websocket_client_start(s_client) == ESP_OK) {
                s_started = true;
            } else {
                ESP_LOGW(TAG, "binary uplink start failed; retrying");
                vTaskDelay(pdMS_TO_TICKS(1000));
                xTaskNotifyGive(s_sender_task);
            }
        } else if (!should_run && s_started) {
            portENTER_CRITICAL(&s_state_lock);
            s_connected = false;
            cloud_ws_compression_on_disconnected(&s_compression_state);
            portEXIT_CRITICAL(&s_state_lock);
            esp_err_t err = esp_websocket_client_stop(s_client);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "binary uplink stop failed: %s", esp_err_to_name(err));
            }
            s_started = false;
        }

        if (offer_pending && s_connected && s_client != NULL) {
            int offered = esp_websocket_client_send_bin(
                s_client,
                CLOUD_WS_CAPABILITY,
                CLOUD_WS_CAPABILITY_LEN,
                pdMS_TO_TICKS(CLOUD_WS_UPLINK_SEND_TIMEOUT_MS));
            if (offered != CLOUD_WS_CAPABILITY_LEN) {
                portENTER_CRITICAL(&s_state_lock);
                cloud_ws_compression_offer_failed(&s_compression_state);
                portEXIT_CRITICAL(&s_state_lock);
                ESP_LOGW(TAG, "waveform capability offer failed: sent=%d", offered);
            }
        }

        if (!active) {
            uint32_t dropped = 0;
            while (xQueueReceive(s_queue, &chunk, 0) == pdTRUE) {
                dropped += chunk.source_frames;
            }
            if (dropped > 0) {
                stats_increment(&s_stats.stop_dropped_frames, dropped);
            }
            continue;
        }

        if (xQueueReceive(s_queue, &chunk, 0) == pdTRUE) {
            size_t raw_len = chunk.len;
            uint32_t source_frames = chunk.source_frames;
            memcpy(s_raw_aggregate, chunk.data, chunk.len);
            while (xQueuePeek(s_queue, &next, 0) == pdTRUE &&
                   raw_len + next.len <= CLOUD_WAVEFORM_MAX_RAW_SIZE) {
                if (xQueueReceive(s_queue, &next, 0) != pdTRUE) {
                    break;
                }
                memcpy(s_raw_aggregate + raw_len, next.data, next.len);
                raw_len += next.len;
                source_frames += next.source_frames;
            }
            if (!s_connected || s_client == NULL) {
                if (!fallback_frame(s_raw_aggregate, raw_len, source_frames)) {
                    stats_increment(&s_stats.overload_dropped_frames, source_frames);
                }
                continue;
            }

            const uint8_t *send_data = s_raw_aggregate;
            size_t send_len = raw_len;
            if (compression_active && s_wire_aggregate != NULL) {
                cloud_waveform_encode_result_t encode_result = {0};
                int64_t compression_started_us = esp_timer_get_time();
                bool encoded = cloud_waveform_encode(
                        &s_waveform_encoder,
                        s_raw_aggregate,
                        raw_len,
                        s_wire_aggregate,
                        CLOUD_WAVEFORM_MAX_WIRE_SIZE,
                        &send_len,
                        &encode_result);
                int64_t compression_elapsed_us =
                    esp_timer_get_time() - compression_started_us;
                uint32_t elapsed_us = compression_elapsed_us <= 0
                                          ? 0
                                          : (uint32_t)compression_elapsed_us;
                stats_note_compression(encoded ? &encode_result : NULL, elapsed_us);
                if (!encoded) {
                    stats_increment(&s_stats.send_failures, 1);
                    if (!fallback_frame(s_raw_aggregate, raw_len, source_frames)) {
                        stats_increment(&s_stats.overload_dropped_frames, source_frames);
                    }
                    continue;
                }
                send_data = s_wire_aggregate;
            }
            int64_t send_started_us = esp_timer_get_time();
            int sent = esp_websocket_client_send_bin(
                s_client,
                (const char *)send_data,
                (int)send_len,
                pdMS_TO_TICKS(CLOUD_WS_UPLINK_SEND_TIMEOUT_MS));
            int64_t send_elapsed_us = esp_timer_get_time() - send_started_us;
            stats_note_send(send_elapsed_us <= 0 ? 0 : (uint32_t)send_elapsed_us);
            if (sent != (int)send_len) {
                stats_increment(&s_stats.send_failures, 1);
                if (!fallback_frame(s_raw_aggregate, raw_len, source_frames)) {
                    stats_increment(&s_stats.overload_dropped_frames, source_frames);
                }
                ESP_LOGW(TAG, "binary send failed: sent=%d len=%u", sent, (unsigned)send_len);
            } else {
                stats_increment(&s_stats.sent_frames, source_frames);
                stats_increment(&s_stats.sent_bytes, (uint32_t)raw_len);
                stats_note_sent_bytes(raw_len, send_len);
            }
        }
    }
}

static void websocket_event_handler(void *handler_args,
                                    esp_event_base_t base,
                                    int32_t event_id,
                                    void *event_data)
{
    (void)handler_args;
    (void)base;
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.last_event_id = event_id;
    portEXIT_CRITICAL(&s_stats_lock);
    if (event_id == WEBSOCKET_EVENT_CONNECTED) {
        stats_increment(&s_stats.connect_events, 1);
        downlink_reset();
        int socket_fd = esp_transport_get_socket(s_tcp_transport);
        if (!cloud_ws_socket_enable_nodelay(socket_fd)) {
            ESP_LOGW(TAG, "failed to enable TCP_NODELAY: socket=%d", socket_fd);
        }
        portENTER_CRITICAL(&s_state_lock);
        cloud_ws_compression_on_connected(
            &s_compression_state, s_compression_capable);
        s_connected = true;
        portEXIT_CRITICAL(&s_state_lock);
        xTaskNotifyGive(s_sender_task);
        ESP_LOGI(TAG, "binary uplink connected: %s", s_uri);
    } else if (event_id == WEBSOCKET_EVENT_DISCONNECTED) {
        stats_increment(&s_stats.disconnect_events, 1);
        portENTER_CRITICAL(&s_state_lock);
        s_connected = false;
        cloud_ws_compression_on_disconnected(&s_compression_state);
        portEXIT_CRITICAL(&s_state_lock);
        downlink_reset();
        ESP_LOGW(TAG, "binary uplink disconnected: event=%ld", (long)event_id);
    } else if (event_id == WEBSOCKET_EVENT_CLOSED) {
        stats_increment(&s_stats.closed_events, 1);
        portENTER_CRITICAL(&s_state_lock);
        s_connected = false;
        cloud_ws_compression_on_disconnected(&s_compression_state);
        portEXIT_CRITICAL(&s_state_lock);
        downlink_reset();
        ESP_LOGW(TAG, "binary uplink closed: event=%ld", (long)event_id);
    } else if (event_id == WEBSOCKET_EVENT_ERROR) {
        stats_increment(&s_stats.error_events, 1);
        portENTER_CRITICAL(&s_state_lock);
        s_connected = false;
        cloud_ws_compression_on_disconnected(&s_compression_state);
        portEXIT_CRITICAL(&s_state_lock);
        downlink_reset();
        ESP_LOGW(TAG, "binary uplink error: event=%ld data=%p", (long)event_id, event_data);
    } else if (event_id == WEBSOCKET_EVENT_DATA && event_data != NULL) {
        handle_downlink_data((const esp_websocket_event_data_t *)event_data);
    }
}

esp_err_t cloud_ws_uplink_init(const cloud_ws_uplink_config_t *config)
{
    if (config == NULL || config->base_uri == NULL || config->device_id == NULL ||
        config->base_uri[0] == '\0' || config->device_id[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    if (!s_config.enabled) {
        s_initialized = true;
        return ESP_OK;
    }

    int written = snprintf(s_uri, sizeof(s_uri), "%s/ws/uplink/%s",
                           s_config.base_uri, s_config.device_id);
    if (written < 0 || (size_t)written >= sizeof(s_uri)) {
        return ESP_ERR_INVALID_SIZE;
    }

    s_queue = xQueueCreateWithCaps(
        CLOUD_WS_UPLINK_QUEUE_DEPTH,
        sizeof(cloud_ws_uplink_frame_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_queue_in_psram = s_queue != NULL;
    if (s_queue == NULL) {
        ESP_LOGW(TAG, "PSRAM queue allocation failed; using internal RAM");
        s_queue = xQueueCreateWithCaps(
            CLOUD_WS_UPLINK_QUEUE_DEPTH,
            sizeof(cloud_ws_uplink_frame_t),
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (s_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    s_raw_aggregate = heap_caps_calloc(
        1, CLOUD_WAVEFORM_MAX_RAW_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_raw_aggregate == NULL) {
        ESP_LOGW(TAG, "PSRAM raw aggregation allocation failed; using internal RAM");
        s_raw_aggregate = heap_caps_calloc(
            1, CLOUD_WAVEFORM_MAX_RAW_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (s_raw_aggregate == NULL) {
        vQueueDeleteWithCaps(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_wire_aggregate = heap_caps_calloc(
        1, CLOUD_WAVEFORM_MAX_WIRE_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_wire_aggregate == NULL) {
        ESP_LOGW(TAG, "PSRAM wire aggregation allocation failed; using internal RAM");
        s_wire_aggregate = heap_caps_calloc(
            1, CLOUD_WAVEFORM_MAX_WIRE_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (s_wire_aggregate == NULL) {
        ESP_LOGW(TAG, "wire aggregation allocation failed; compression disabled");
    }

    s_compressor_workspace_size = cloud_waveform_encoder_workspace_size();
    s_compressor_workspace = heap_caps_calloc(
        1, s_compressor_workspace_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_compressor_workspace == NULL) {
        ESP_LOGW(TAG, "PSRAM compressor allocation failed; using internal RAM");
        s_compressor_workspace = heap_caps_calloc(
            1, s_compressor_workspace_size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    s_compression_capable = s_wire_aggregate != NULL &&
        cloud_waveform_encoder_init(
            &s_waveform_encoder,
            s_compressor_workspace,
            s_compressor_workspace_size);
    if (!s_compression_capable) {
        ESP_LOGW(TAG, "compressor workspace unavailable; compression disabled");
    }

    s_tcp_transport = esp_transport_tcp_init();
    s_ws_transport = s_tcp_transport == NULL
                         ? NULL
                         : esp_transport_ws_init(s_tcp_transport);
    const char *path = strstr(s_uri, "/ws/uplink/");
    const esp_transport_ws_config_t transport_cfg = {
        .ws_path = path,
        .propagate_control_frames = true,
    };
    if (s_ws_transport == NULL || path == NULL ||
        esp_transport_ws_set_config(s_ws_transport, &transport_cfg) != ESP_OK) {
        ESP_LOGE(TAG, "cloud WebSocket transport initialization failed");
        if (s_ws_transport != NULL) {
            esp_transport_destroy(s_ws_transport);
            s_ws_transport = NULL;
        }
        if (s_tcp_transport != NULL) {
            esp_transport_destroy(s_tcp_transport);
            s_tcp_transport = NULL;
        }
        heap_caps_free(s_compressor_workspace);
        s_compressor_workspace = NULL;
        heap_caps_free(s_wire_aggregate);
        s_wire_aggregate = NULL;
        heap_caps_free(s_raw_aggregate);
        s_raw_aggregate = NULL;
        vQueueDeleteWithCaps(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }

    esp_websocket_client_config_t websocket_cfg = {
        .uri = s_uri,
        .disable_auto_reconnect = false,
        .enable_close_reconnect = true,
        .task_prio = 5,
        .task_stack = 4096,
        .buffer_size = CLOUD_WS_UPLINK_WS_BUFFER_SIZE,
        .network_timeout_ms = CLOUD_WS_UPLINK_SEND_TIMEOUT_MS,
        .reconnect_timeout_ms = 2000,
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 20,
        .ext_transport = s_ws_transport,
    };
    s_client = esp_websocket_client_init(&websocket_cfg);
    if (s_client == NULL) {
        esp_transport_destroy(s_ws_transport);
        s_ws_transport = NULL;
        esp_transport_destroy(s_tcp_transport);
        s_tcp_transport = NULL;
        heap_caps_free(s_compressor_workspace);
        s_compressor_workspace = NULL;
        heap_caps_free(s_wire_aggregate);
        s_wire_aggregate = NULL;
        heap_caps_free(s_raw_aggregate);
        s_raw_aggregate = NULL;
        vQueueDeleteWithCaps(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = esp_websocket_register_events(
        s_client, WEBSOCKET_EVENT_ANY, websocket_event_handler, NULL);
    if (err != ESP_OK) {
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
        esp_transport_destroy(s_ws_transport);
        s_ws_transport = NULL;
        esp_transport_destroy(s_tcp_transport);
        s_tcp_transport = NULL;
        heap_caps_free(s_compressor_workspace);
        s_compressor_workspace = NULL;
        heap_caps_free(s_wire_aggregate);
        s_wire_aggregate = NULL;
        heap_caps_free(s_raw_aggregate);
        s_raw_aggregate = NULL;
        vQueueDeleteWithCaps(s_queue);
        s_queue = NULL;
        return err;
    }

    if (xTaskCreate(sender_task, "cloud_ws_tx", 8192, NULL, 6, &s_sender_task) != pdPASS) {
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
        esp_transport_destroy(s_ws_transport);
        s_ws_transport = NULL;
        esp_transport_destroy(s_tcp_transport);
        s_tcp_transport = NULL;
        heap_caps_free(s_compressor_workspace);
        s_compressor_workspace = NULL;
        heap_caps_free(s_wire_aggregate);
        s_wire_aggregate = NULL;
        heap_caps_free(s_raw_aggregate);
        s_raw_aggregate = NULL;
        vQueueDeleteWithCaps(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_initialized = true;
    ESP_LOGI(TAG, "binary uplink configured: %s", s_uri);
    return ESP_OK;
}

void cloud_ws_uplink_notify_wifi_state(const wifi_manager_status_t *status)
{
    if (!s_initialized || !s_config.enabled || s_client == NULL || status == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_state_lock);
    s_wifi_ready = status->mode != SYSTEM_NET_AP && status->sta_connected;
    portEXIT_CRITICAL(&s_state_lock);
    xTaskNotifyGive(s_sender_task);
}

void cloud_ws_uplink_set_active(bool active, uint32_t lease_generation)
{
    if (!s_initialized || !s_config.enabled || s_client == NULL) {
        return;
    }

    bool applied = false;
    portENTER_CRITICAL(&s_state_lock);
    applied = cloud_ws_lease_gate_apply(&s_lease_gate, lease_generation, active);
    if (applied) {
        s_active = active;
    }
    portEXIT_CRITICAL(&s_state_lock);
    if (applied) {
        xTaskNotifyGive(s_sender_task);
    }
}

bool cloud_ws_uplink_send(const uint8_t *data, size_t len)
{
    if (s_queue == NULL || data == NULL || len == 0 ||
        len > CLOUD_WS_UPLINK_MAX_FRAME) {
        return false;
    }

    cloud_ws_uplink_frame_t frame = {.len = len, .source_frames = 1};
    cloud_ws_uplink_frame_t dropped;
    memcpy(frame.data, data, len);
    if (xQueueSend(s_queue, &frame, 0) != pdTRUE) {
        stats_increment(&s_stats.queue_full, 1);
        if (xQueueReceive(s_queue, &dropped, 0) != pdTRUE) {
            return false;
        }
        stats_increment(&s_stats.overload_dropped_frames, dropped.source_frames);
        if (xQueueSend(s_queue, &frame, 0) != pdTRUE) {
            return false;
        }
    }
    stats_increment(&s_stats.queued_frames, 1);
    xTaskNotifyGive(s_sender_task);
    return true;
}

bool cloud_ws_uplink_is_connected(void)
{
    return s_connected;
}

void cloud_ws_uplink_note_fallback(void)
{
    stats_increment(&s_stats.fallback_frames, 1);
}

void cloud_ws_uplink_note_fallback_failure(void)
{
    stats_increment(&s_stats.fallback_failures, 1);
}

void cloud_ws_uplink_get_stats(cloud_ws_uplink_stats_t *out)
{
    if (out == NULL) {
        return;
    }
    uint32_t sender_stack_min_free = s_sender_task == NULL
                                         ? 0
                                         : (uint32_t)uxTaskGetStackHighWaterMark(s_sender_task);
    portENTER_CRITICAL(&s_stats_lock);
    *out = s_stats;
    out->connected = s_connected;
    out->queue_in_psram = s_queue_in_psram;
    out->sender_stack_min_free = sender_stack_min_free;
    out->queue_pending_frames = s_queue == NULL ? 0 : (uint32_t)uxQueueMessagesWaiting(s_queue);
    portEXIT_CRITICAL(&s_stats_lock);
    portENTER_CRITICAL(&s_state_lock);
    out->compression_capable = s_compression_capable;
    out->compression_active = s_compression_state.active;
    portEXIT_CRITICAL(&s_state_lock);
}
