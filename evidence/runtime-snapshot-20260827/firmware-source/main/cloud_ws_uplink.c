#include "cloud_ws_uplink.h"
#include "cloud_ws_downlink_reassembly.h"
#include "cloud_ws_batch_policy.h"
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
#define CLOUD_WS_UPLINK_QUEUE_DEPTH 512U
#define CLOUD_WS_UPLINK_URI_MAX_LEN 192U
#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 5000
#define CLOUD_WS_UPLINK_WS_BUFFER_SIZE 2048U
#define CLOUD_WS_UPLINK_SENDER_TASK_PRIORITY 9
#define CLOUD_WS_UPLINK_CLIENT_TASK_PRIORITY 10

typedef struct {
    size_t len;
    uint32_t source_frames;
    int64_t enqueued_us;
    uint8_t data[CLOUD_WS_UPLINK_MAX_FRAME];
} cloud_ws_uplink_frame_t;

static const char *TAG = "cloud_ws_uplink";
static cloud_ws_uplink_config_t s_config;
static esp_websocket_client_handle_t s_client;
static QueueHandle_t s_queue;
static TaskHandle_t s_sender_task;
static uint8_t *s_raw_aggregate;
static uint8_t *s_wire_aggregate;
static cloud_ws_uplink_frame_t *s_sender_chunk;
static cloud_ws_uplink_frame_t *s_sender_next;
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
static uint64_t s_queue_dequeued_bytes;
static cloud_ws_downlink_reassembly_t s_downlink_reassembly;
static cloud_ws_compression_state_t s_compression_state;

static void stats_increment(uint32_t *counter, uint32_t amount)
{
    portENTER_CRITICAL(&s_stats_lock);
    *counter += amount;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_queue_enqueue(size_t len)
{
    uint32_t pending_frames = (uint32_t)uxQueueMessagesWaiting(s_queue);
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.queued_frames++;
    s_stats.queued_bytes += len;
    s_stats.queue_pending_bytes = s_stats.queued_bytes >= s_queue_dequeued_bytes
                                      ? s_stats.queued_bytes - s_queue_dequeued_bytes
                                      : 0;
    if (pending_frames > s_stats.queue_high_water_frames) {
        s_stats.queue_high_water_frames = pending_frames;
    }
    if (s_stats.queue_pending_bytes > s_stats.queue_high_water_bytes) {
        s_stats.queue_high_water_bytes = s_stats.queue_pending_bytes;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_queue_dequeue(size_t len)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_queue_dequeued_bytes += len;
    s_stats.queue_pending_bytes = s_stats.queued_bytes >= s_queue_dequeued_bytes
                                      ? s_stats.queued_bytes - s_queue_dequeued_bytes
                                      : 0;
    portEXIT_CRITICAL(&s_stats_lock);
}

static uint32_t elapsed_us_clamped(int64_t started_us, int64_t finished_us)
{
    int64_t elapsed_us = finished_us - started_us;
    if (elapsed_us <= 0) {
        return 0;
    }
    return elapsed_us > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed_us;
}

static void stats_note_queue_dequeue_age(int64_t enqueued_us,
                                         int64_t dequeued_us)
{
    if (enqueued_us <= 0) {
        return;
    }
    uint32_t age_us = elapsed_us_clamped(enqueued_us, dequeued_us);
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.queue_dequeue_age_samples++;
    s_stats.queue_dequeue_age_total_us += age_us;
    if (age_us > s_stats.queue_dequeue_age_max_us) {
        s_stats.queue_dequeue_age_max_us = age_us;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_queue_stage_age(uint32_t *max_age_us,
                                       int64_t enqueued_us,
                                       int64_t stage_us)
{
    if (max_age_us == NULL || enqueued_us <= 0) {
        return;
    }
    uint32_t age_us = elapsed_us_clamped(enqueued_us, stage_us);
    portENTER_CRITICAL(&s_stats_lock);
    if (age_us > *max_age_us) {
        *max_age_us = age_us;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_duration_max(uint32_t *max_elapsed_us,
                                    int64_t started_us,
                                    int64_t finished_us)
{
    if (max_elapsed_us == NULL) {
        return;
    }
    uint32_t elapsed_us = elapsed_us_clamped(started_us, finished_us);
    portENTER_CRITICAL(&s_stats_lock);
    if (elapsed_us > *max_elapsed_us) {
        *max_elapsed_us = elapsed_us;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_overload_drop(uint32_t source_frames, size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.overload_dropped_frames += source_frames;
    s_stats.overload_dropped_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_rejected(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.rejected_frames++;
    s_stats.rejected_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_fallback_queued(uint32_t source_frames, size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.queued_fallback_frames += source_frames;
    s_stats.queued_fallback_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void stats_note_stop_drop(uint32_t source_frames, size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.stop_dropped_frames += source_frames;
    s_stats.stop_dropped_bytes += bytes;
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

static void stats_note_sent(uint32_t source_frames, size_t raw_len, size_t wire_len)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.sent_frames += source_frames;
    s_stats.sent_bytes += raw_len;
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
        stats_note_fallback_queued(source_frames, len);
    }
    return complete;
}

static void sender_task(void *arg)
{
    (void)arg;
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
            size_t dropped_bytes = 0;
            while (xQueueReceive(s_queue, s_sender_chunk, 0) == pdTRUE) {
                stats_note_queue_dequeue(s_sender_chunk->len);
                dropped += s_sender_chunk->source_frames;
                dropped_bytes += s_sender_chunk->len;
            }
            if (dropped > 0) {
                stats_note_stop_drop(dropped, dropped_bytes);
            }
            continue;
        }

        if (xQueueReceive(s_queue, s_sender_chunk, 0) == pdTRUE) {
            int64_t batch_started_us = esp_timer_get_time();
            stats_note_queue_dequeue(s_sender_chunk->len);
            stats_note_queue_dequeue_age(s_sender_chunk->enqueued_us,
                                         batch_started_us);
            size_t raw_len = s_sender_chunk->len;
            uint32_t source_frames = s_sender_chunk->source_frames;
            int64_t oldest_enqueued_us = s_sender_chunk->enqueued_us;
            memcpy(s_raw_aggregate, s_sender_chunk->data, s_sender_chunk->len);
            while (raw_len < CLOUD_WAVEFORM_MAX_RAW_SIZE) {
                int64_t elapsed = esp_timer_get_time() - batch_started_us;
                uint32_t elapsed_us = elapsed <= 0
                                          ? 0
                                          : elapsed > UINT32_MAX
                                                ? UINT32_MAX
                                                : (uint32_t)elapsed;
                uint32_t wait_us = cloud_ws_batch_wait_us(raw_len, elapsed_us);
                if (wait_us == 0) {
                    break;
                }
                TickType_t wait_ticks = pdMS_TO_TICKS((wait_us + 999U) / 1000U);
                if (wait_ticks == 0) {
                    wait_ticks = 1;
                }
                if (xQueuePeek(s_queue, s_sender_next, wait_ticks) != pdTRUE ||
                    raw_len + s_sender_next->len > CLOUD_WAVEFORM_MAX_RAW_SIZE) {
                    break;
                }
                if (xQueueReceive(s_queue, s_sender_next, 0) != pdTRUE) {
                    break;
                }
                int64_t dequeued_us = esp_timer_get_time();
                stats_note_queue_dequeue(s_sender_next->len);
                stats_note_queue_dequeue_age(s_sender_next->enqueued_us,
                                             dequeued_us);
                if (s_sender_next->enqueued_us > 0 &&
                    (oldest_enqueued_us <= 0 ||
                     s_sender_next->enqueued_us < oldest_enqueued_us)) {
                    oldest_enqueued_us = s_sender_next->enqueued_us;
                }
                memcpy(s_raw_aggregate + raw_len,
                       s_sender_next->data, s_sender_next->len);
                raw_len += s_sender_next->len;
                source_frames += s_sender_next->source_frames;
            }
            int64_t batch_ready_us = esp_timer_get_time();
            stats_note_duration_max(&s_stats.batch_wait_max_us,
                                    batch_started_us, batch_ready_us);
            stats_note_queue_stage_age(
                &s_stats.queue_batch_ready_age_max_us,
                oldest_enqueued_us, batch_ready_us);
            if (!s_connected || s_client == NULL) {
                if (!fallback_frame(s_raw_aggregate, raw_len, source_frames)) {
                    stats_note_overload_drop(source_frames, raw_len);
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
                        stats_note_overload_drop(source_frames, raw_len);
                    }
                    continue;
                }
                send_data = s_wire_aggregate;
            }
            int64_t send_started_us = esp_timer_get_time();
            stats_note_queue_stage_age(&s_stats.queue_send_start_age_max_us,
                                       oldest_enqueued_us, send_started_us);
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
                    stats_note_overload_drop(source_frames, raw_len);
                }
                ESP_LOGW(TAG, "binary send failed: sent=%d len=%u", sent, (unsigned)send_len);
            } else {
                stats_note_sent(source_frames, raw_len, send_len);
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
        .task_prio = CLOUD_WS_UPLINK_CLIENT_TASK_PRIORITY,
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

    s_sender_chunk = heap_caps_calloc(
        1, sizeof(*s_sender_chunk), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_sender_next = heap_caps_calloc(
        1, sizeof(*s_sender_next), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_sender_chunk == NULL || s_sender_next == NULL) {
        heap_caps_free(s_sender_chunk);
        heap_caps_free(s_sender_next);
        s_sender_chunk = heap_caps_calloc(
            1, sizeof(*s_sender_chunk), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        s_sender_next = heap_caps_calloc(
            1, sizeof(*s_sender_next), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (s_sender_chunk == NULL || s_sender_next == NULL) {
        heap_caps_free(s_sender_chunk);
        heap_caps_free(s_sender_next);
        s_sender_chunk = NULL;
        s_sender_next = NULL;
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

    if (xTaskCreate(sender_task, "cloud_ws_tx", 8192, NULL,
                    CLOUD_WS_UPLINK_SENDER_TASK_PRIORITY, &s_sender_task) != pdPASS) {
        heap_caps_free(s_sender_chunk);
        s_sender_chunk = NULL;
        heap_caps_free(s_sender_next);
        s_sender_next = NULL;
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

    cloud_ws_uplink_frame_t frame = {
        .len = len,
        .source_frames = 1,
        .enqueued_us = esp_timer_get_time(),
    };
    cloud_ws_uplink_frame_t dropped;
    memcpy(frame.data, data, len);
    if (xQueueSend(s_queue, &frame, 0) != pdTRUE) {
        stats_increment(&s_stats.queue_full, 1);
        if (xQueueReceive(s_queue, &dropped, 0) == pdTRUE) {
            stats_note_queue_dequeue(dropped.len);
            stats_note_queue_stage_age(&s_stats.queue_drop_age_max_us,
                                       dropped.enqueued_us,
                                       frame.enqueued_us);
            stats_note_overload_drop(dropped.source_frames, dropped.len);
        }
        if (xQueueSend(s_queue, &frame, 0) != pdTRUE) {
            stats_note_rejected(len);
            return false;
        }
    }
    stats_note_queue_enqueue(len);
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

    esp_websocket_client_tx_diagnostics_t tx_diagnostics = {0};
    if (s_client != NULL &&
        esp_websocket_client_get_tx_diagnostics(
            s_client, &tx_diagnostics) == ESP_OK) {
        out->ws_data_lock_wait_max_us =
            tx_diagnostics.data_lock_wait_max_us;
        out->ws_data_lock_timeouts = tx_diagnostics.data_lock_timeouts;
        out->ws_transport_send_max_us =
            tx_diagnostics.transport_send_max_us;
        out->ws_ping_lock_wait_max_us =
            tx_diagnostics.ping_lock_wait_max_us;
        out->ws_ping_lock_timeouts = tx_diagnostics.ping_lock_timeouts;
        out->ws_ping_send_max_us = tx_diagnostics.ping_send_max_us;
    }
}
