#include "cloud_mqtt.h"
#include "cloud_osc_keepalive.h"
#include "cloud_ws_uplink.h"
#include "motor_diag.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"

#define CLOUD_MQTT_STATUS_INTERVAL_US (5LL * 1000LL * 1000LL)
#define CLOUD_MQTT_TOPIC_MAX_LEN 96
#define CLOUD_MQTT_TOPIC_STATUS_FMT "wireless-debug/%s/status"
#define CLOUD_MQTT_TOPIC_AVAILABILITY_FMT "wireless-debug/%s/availability"
#define CLOUD_MQTT_TOPIC_CMD_FMT "wireless-debug/%s/cmd"
#define CLOUD_MQTT_TOPIC_ACK_FMT "wireless-debug/%s/ack"
#define CLOUD_MQTT_TOPIC_INBOX_FMT "wireless-debug/%s/inbox"
#define CLOUD_MQTT_TOPIC_BUS_ACK_FMT "wireless-debug/%s/bus-ack"
#define CLOUD_MQTT_TOPIC_PUB_FMT "wireless-debug/%s/pub"
#define CLOUD_MQTT_WS_ACTIVE_US (30LL * 1000LL * 1000LL)
#define CLOUD_MQTT_WS_FRAME_MAX_LEN 512
#define CLOUD_MQTT_OSC_MAGIC_LEN 4U
#define CLOUD_MQTT_OSC_HEARTBEAT_INTERVAL_US (1LL * 1000LL * 1000LL)
#define CLOUD_MQTT_OSC_KEEPALIVE_TASK_STACK 4096U
#define CLOUD_MQTT_OSC_KEEPALIVE_TASK_PRIORITY 11U

#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

static const char *TAG = "cloud_mqtt";
static cloud_mqtt_config_t s_config;
static cloud_mqtt_runtime_t s_runtime;
static esp_mqtt_client_handle_t s_client;
static esp_timer_handle_t s_status_timer;
static bool s_initialized;
static bool s_started;
static bool s_connected;
static bool s_ws_osc_streaming;
static int64_t s_ws_active_until_us;
static uint32_t s_ws_lease_generation;
static cloud_osc_keepalive_t s_ws_keepalive;
static TaskHandle_t s_ws_keepalive_task;
static uint32_t s_ws_keepalive_sent;
static uint32_t s_ws_keepalive_failures;
static uint32_t s_ws_keepalive_expirations;
static int64_t s_ws_keepalive_last_sent_us;
static portMUX_TYPE s_ws_osc_state_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_status_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_availability_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_cmd_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_ack_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_inbox_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_bus_ack_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_pub_topic[CLOUD_MQTT_TOPIC_MAX_LEN];

static uint32_t ws_osc_next_generation_locked(void)
{
    s_ws_lease_generation++;
    if (s_ws_lease_generation == 0) {
        s_ws_lease_generation = 1;
    }
    return s_ws_lease_generation;
}

static uint32_t ws_osc_state_set(bool streaming, int64_t active_until_us)
{
    uint32_t generation = 0;
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    s_ws_osc_streaming = streaming;
    s_ws_active_until_us = active_until_us;
    generation = ws_osc_next_generation_locked();
    portEXIT_CRITICAL(&s_ws_osc_state_lock);
    return generation;
}

static void ws_osc_state_snapshot(bool *streaming, int64_t *active_until_us)
{
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    if (streaming != NULL) {
        *streaming = s_ws_osc_streaming;
    }
    if (active_until_us != NULL) {
        *active_until_us = s_ws_active_until_us;
    }
    portEXIT_CRITICAL(&s_ws_osc_state_lock);
}

static uint32_t ws_osc_state_expire(int64_t now_us)
{
    uint32_t generation = 0;
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    if (s_ws_active_until_us > 0 && now_us >= s_ws_active_until_us) {
        s_ws_osc_streaming = false;
        s_ws_active_until_us = 0;
        generation = ws_osc_next_generation_locked();
    }
    portEXIT_CRITICAL(&s_ws_osc_state_lock);
    return generation;
}

static uint32_t ws_osc_state_refresh(bool start_streaming, int64_t active_until_us)
{
    uint32_t generation = 0;
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    if (start_streaming) {
        s_ws_osc_streaming = true;
    }
    s_ws_active_until_us = active_until_us;
    generation = ws_osc_next_generation_locked();
    portEXIT_CRITICAL(&s_ws_osc_state_lock);
    return generation;
}

static bool is_osc_stop_frame(const uint8_t *data, size_t len)
{
    return data != NULL && len >= 2U && data[0] == 0xff && data[1] == 0x72;
}

static bool is_osc_start_frame(const uint8_t *data, size_t len)
{
    return data != NULL && len >= 2U && data[0] == 0xff && data[1] == 0x71;
}

static void ws_osc_keepalive_note_control(const uint8_t *data, size_t len,
                                          int64_t now_us)
{
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    cloud_osc_keepalive_note_control(&s_ws_keepalive, data, len, now_us,
                                     CLOUD_MQTT_WS_ACTIVE_US,
                                     CLOUD_MQTT_OSC_HEARTBEAT_INTERVAL_US);
    portEXIT_CRITICAL(&s_ws_osc_state_lock);
    if (s_ws_keepalive_task != NULL) {
        xTaskNotifyGive(s_ws_keepalive_task);
    }
}

static TickType_t ws_osc_keepalive_wait_ticks(int64_t now_us)
{
    bool active = false;
    int64_t deadline_us = 0;
    portENTER_CRITICAL(&s_ws_osc_state_lock);
    active = s_ws_keepalive.active;
    if (active) {
        deadline_us = MIN(s_ws_keepalive.lease_deadline_us,
                          s_ws_keepalive.heartbeat_deadline_us);
    }
    portEXIT_CRITICAL(&s_ws_osc_state_lock);

    if (!active) {
        return portMAX_DELAY;
    }
    if (deadline_us <= now_us) {
        return 0;
    }

    int64_t wait_ms = (deadline_us - now_us + 999LL) / 1000LL;
    TickType_t wait_ticks = pdMS_TO_TICKS(wait_ms);
    return wait_ticks == 0 ? 1 : wait_ticks;
}

static void ws_osc_keepalive_task(void *arg)
{
    (void)arg;
    while (true) {
        int64_t now_us = esp_timer_get_time();
        uint8_t slave_id = 0;
        cloud_osc_keepalive_action_t action;

        portENTER_CRITICAL(&s_ws_osc_state_lock);
        action = cloud_osc_keepalive_poll(
            &s_ws_keepalive, now_us,
            CLOUD_MQTT_OSC_HEARTBEAT_INTERVAL_US, &slave_id);
        if (action == CLOUD_OSC_KEEPALIVE_EXPIRED) {
            s_ws_keepalive_expirations++;
        }
        portEXIT_CRITICAL(&s_ws_osc_state_lock);

        if (action == CLOUD_OSC_KEEPALIVE_EXPIRED) {
            uint32_t lease_generation = ws_osc_state_expire(now_us);
            if (lease_generation != 0) {
                cloud_ws_uplink_set_active(false, lease_generation);
            }
            ESP_LOGW(TAG, "cloud osc control lease expired");
        } else if (action == CLOUD_OSC_KEEPALIVE_SEND) {
            motor_diag_frame_t frame;
            esp_err_t err = motor_diag_build_osc_heartbeat(slave_id, &frame);
            if (err == ESP_OK && s_runtime.send_ws_frame != NULL) {
                err = s_runtime.send_ws_frame(frame.data, frame.len, s_runtime.ctx);
            } else if (err == ESP_OK) {
                err = ESP_ERR_INVALID_STATE;
            }

            portENTER_CRITICAL(&s_ws_osc_state_lock);
            if (err == ESP_OK) {
                s_ws_keepalive_sent++;
                s_ws_keepalive_last_sent_us = now_us;
            } else {
                s_ws_keepalive_failures++;
            }
            portEXIT_CRITICAL(&s_ws_osc_state_lock);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "cloud osc local heartbeat failed: %s",
                         esp_err_to_name(err));
            }
        }

        TickType_t wait_ticks = ws_osc_keepalive_wait_ticks(esp_timer_get_time());
        (void)ulTaskNotifyTake(pdTRUE, wait_ticks);
    }
}

static int make_topic_from_format(char *out, size_t out_size, const char *fmt)
{
    return snprintf(out, out_size, fmt, s_config.device_id);
}

static const char *net_mode_json_name(system_net_mode_t mode)
{
    switch (mode) {
    case SYSTEM_NET_STA:
        return "sta";
    case SYSTEM_NET_APSTA:
        return "apsta";
    case SYSTEM_NET_AP:
    default:
        return "ap";
    }
}

static const char *comm_mode_json_name(app_comm_mode_t mode)
{
    switch (mode) {
    case APP_COMM_BLE:
        return "ble";
    case APP_COMM_WIFI:
        return "wifi";
    case APP_COMM_AUTO:
    default:
        return "auto";
    }
}

static void build_topics(void)
{
    make_topic_from_format(s_status_topic, sizeof(s_status_topic), CLOUD_MQTT_TOPIC_STATUS_FMT);
    make_topic_from_format(s_availability_topic, sizeof(s_availability_topic), CLOUD_MQTT_TOPIC_AVAILABILITY_FMT);
    make_topic_from_format(s_cmd_topic, sizeof(s_cmd_topic), CLOUD_MQTT_TOPIC_CMD_FMT);
    make_topic_from_format(s_ack_topic, sizeof(s_ack_topic), CLOUD_MQTT_TOPIC_ACK_FMT);
    make_topic_from_format(s_inbox_topic, sizeof(s_inbox_topic), CLOUD_MQTT_TOPIC_INBOX_FMT);
    make_topic_from_format(s_bus_ack_topic, sizeof(s_bus_ack_topic), CLOUD_MQTT_TOPIC_BUS_ACK_FMT);
    make_topic_from_format(s_pub_topic, sizeof(s_pub_topic), CLOUD_MQTT_TOPIC_PUB_FMT);
}

static int hex_value(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

static bool hex_decode(const char *hex, uint8_t *out, size_t out_size, size_t *out_len)
{
    if (hex == NULL || out == NULL || out_len == NULL) {
        return false;
    }
    size_t hex_len = strlen(hex);
    if ((hex_len % 2U) != 0U || hex_len / 2U > out_size) {
        return false;
    }
    for (size_t i = 0; i < hex_len; i += 2U) {
        int hi = hex_value(hex[i]);
        int lo = hex_value(hex[i + 1U]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i / 2U] = (uint8_t)((hi << 4) | lo);
    }
    *out_len = hex_len / 2U;
    return true;
}

static bool hex_encode(const uint8_t *data, size_t len, char *out, size_t out_size)
{
    static const char hex[] = "0123456789abcdef";
    if (data == NULL || out == NULL || out_size < (len * 2U + 1U)) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        out[i * 2U] = hex[(data[i] >> 4) & 0x0F];
        out[i * 2U + 1U] = hex[data[i] & 0x0F];
    }
    out[len * 2U] = '\0';
    return true;
}

static void add_heap_status(cJSON *root)
{
    cJSON *heap = cJSON_CreateObject();
    if (heap == NULL) {
        return;
    }
    cJSON_AddNumberToObject(heap, "free", esp_get_free_heap_size());
    cJSON_AddNumberToObject(heap, "min_free", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(heap, "largest", heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    cJSON_AddNumberToObject(heap, "internal_free",
                            heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    cJSON_AddNumberToObject(heap, "internal_min_free",
                            heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    cJSON_AddItemToObject(root, "heap", heap);
}

static void add_comm_stats_status(cJSON *root)
{
    if (s_runtime.get_comm_stats == NULL) {
        return;
    }

    comm_stats_snapshot_t stats;
    memset(&stats, 0, sizeof(stats));
    s_runtime.get_comm_stats(&stats, s_runtime.ctx);

    cJSON *comm = cJSON_CreateObject();
    cJSON *uart = cJSON_CreateObject();
    cJSON *ble = cJSON_CreateObject();
    cJSON *wifi = cJSON_CreateObject();
    cJSON *route = cJSON_CreateObject();
    if (comm == NULL || uart == NULL || ble == NULL || wifi == NULL || route == NULL) {
        cJSON_Delete(comm);
        cJSON_Delete(uart);
        cJSON_Delete(ble);
        cJSON_Delete(wifi);
        cJSON_Delete(route);
        return;
    }

    cJSON_AddNumberToObject(uart, "rx_frames", (double)stats.uart_rx_frames);
    cJSON_AddNumberToObject(uart, "rx_bytes", (double)stats.uart_rx_bytes);
    cJSON_AddNumberToObject(uart, "tx_bytes", (double)stats.uart_tx_bytes);
    cJSON_AddNumberToObject(uart, "tx_failures", (double)stats.uart_tx_failures);
    cJSON_AddNumberToObject(uart, "overflows", (double)stats.uart_overflows);
    cJSON_AddNumberToObject(uart, "fifo_overflows", (double)stats.uart_fifo_overflows);
    cJSON_AddNumberToObject(uart, "buffer_full_overflows",
                            (double)stats.uart_buffer_full_overflows);
    cJSON_AddNumberToObject(uart, "overflow_assemble_bytes",
                            (double)stats.uart_overflow_assemble_bytes);
    cJSON_AddNumberToObject(uart, "overflow_driver_bytes",
                            (double)stats.uart_overflow_driver_bytes);
    cJSON_AddNumberToObject(uart, "last_overflow_event",
                            (double)stats.uart_last_overflow_event);
    cJSON_AddNumberToObject(uart, "last_overflow_assemble_bytes",
                            (double)stats.uart_last_overflow_assemble_bytes);
    cJSON_AddNumberToObject(uart, "last_overflow_driver_bytes",
                            (double)stats.uart_last_overflow_driver_bytes);
    cJSON_AddNumberToObject(uart, "dispatch_calls", (double)stats.uart_dispatch_calls);
    cJSON_AddNumberToObject(uart, "dispatch_total_us", (double)stats.uart_dispatch_total_us);
    cJSON_AddNumberToObject(uart, "dispatch_max_us", (double)stats.uart_dispatch_max_us);
    cJSON_AddNumberToObject(uart, "cloud_route_calls", (double)stats.uart_cloud_route_calls);
    cJSON_AddNumberToObject(uart, "cloud_route_total_us",
                            (double)stats.uart_cloud_route_total_us);
    cJSON_AddNumberToObject(uart, "cloud_route_max_us",
                            (double)stats.uart_cloud_route_max_us);
    cJSON_AddNumberToObject(uart, "local_route_calls", (double)stats.uart_local_route_calls);
    cJSON_AddNumberToObject(uart, "local_route_total_us",
                            (double)stats.uart_local_route_total_us);
    cJSON_AddNumberToObject(uart, "local_route_max_us",
                            (double)stats.uart_local_route_max_us);

    cJSON_AddNumberToObject(ble, "rx_frames", (double)stats.ble_rx_frames);
    cJSON_AddNumberToObject(ble, "rx_bytes", (double)stats.ble_rx_bytes);
    cJSON_AddNumberToObject(ble, "tx_bytes", (double)stats.ble_tx_bytes);
    cJSON_AddNumberToObject(ble, "notify_failures", (double)stats.ble_notify_failures);
    cJSON_AddNumberToObject(ble, "no_subscriber_drops", (double)stats.ble_no_subscriber_drops);
    cJSON_AddNumberToObject(ble, "dropped_bytes", (double)stats.ble_dropped_bytes);
    cJSON_AddNumberToObject(ble, "alloc_failures", (double)stats.ble_alloc_failures);

    cJSON_AddNumberToObject(wifi, "rx_frames", (double)stats.wifi_rx_frames);
    cJSON_AddNumberToObject(wifi, "rx_bytes", (double)stats.wifi_rx_bytes);
    cJSON_AddNumberToObject(wifi, "tx_queued_bytes", (double)stats.wifi_tx_queued_bytes);
    cJSON_AddNumberToObject(wifi, "tx_sent_bytes", (double)stats.wifi_tx_sent_bytes);
    cJSON_AddNumberToObject(wifi, "tx_failures", (double)stats.wifi_tx_failures);
    cJSON_AddNumberToObject(wifi, "no_client_drops", (double)stats.wifi_no_client_drops);
    cJSON_AddNumberToObject(wifi, "pool_exhausted", (double)stats.wifi_pool_exhausted);
    cJSON_AddNumberToObject(wifi, "queue_full", (double)stats.wifi_queue_full);
    cJSON_AddNumberToObject(wifi, "httpd_queue_failures",
                            (double)stats.wifi_httpd_queue_failures);
    cJSON_AddNumberToObject(wifi, "rx_failures", (double)stats.wifi_rx_failures);

    cJSON_AddNumberToObject(route, "idle_drops", (double)stats.route_idle_drops);
    cJSON_AddNumberToObject(route, "unavailable_drops", (double)stats.route_unavailable_drops);
    cJSON_AddNumberToObject(route, "partial_drops", (double)stats.route_partial_drops);
    cJSON_AddNumberToObject(route, "dropped_bytes", (double)stats.route_dropped_bytes);

    cJSON_AddItemToObject(comm, "uart", uart);
    cJSON_AddItemToObject(comm, "ble", ble);
    cJSON_AddItemToObject(comm, "wifi", wifi);
    cJSON_AddItemToObject(comm, "route", route);
    cJSON_AddItemToObject(root, "comm_stats", comm);
}

static void add_cloud_ws_uplink_status(cJSON *root)
{
    cloud_ws_uplink_stats_t stats;
    memset(&stats, 0, sizeof(stats));
    cloud_ws_uplink_get_stats(&stats);

    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
        return;
    }
    cJSON_AddNumberToObject(obj, "schema_version", CLOUD_WS_UPLINK_SCHEMA_VERSION);
    cJSON_AddBoolToObject(obj, "connected", stats.connected);
    cJSON_AddBoolToObject(obj, "queue_in_psram", stats.queue_in_psram);
    cJSON_AddBoolToObject(obj, "compression_capable", stats.compression_capable);
    cJSON_AddBoolToObject(obj, "compression_active", stats.compression_active);
    cJSON_AddNumberToObject(obj, "sender_stack_min_free", (double)stats.sender_stack_min_free);
    cJSON_AddNumberToObject(obj, "queue_pending_frames", (double)stats.queue_pending_frames);
    cJSON_AddNumberToObject(obj, "queue_pending_bytes", (double)stats.queue_pending_bytes);
    cJSON_AddNumberToObject(obj, "queue_high_water_frames",
                            (double)stats.queue_high_water_frames);
    cJSON_AddNumberToObject(obj, "queue_high_water_bytes",
                            (double)stats.queue_high_water_bytes);
    cJSON_AddNumberToObject(obj, "queue_dequeue_age_samples",
                            (double)stats.queue_dequeue_age_samples);
    cJSON_AddNumberToObject(obj, "queue_dequeue_age_total_us",
                            (double)stats.queue_dequeue_age_total_us);
    cJSON_AddNumberToObject(obj, "queue_dequeue_age_max_us",
                            (double)stats.queue_dequeue_age_max_us);
    cJSON_AddNumberToObject(obj, "queue_batch_ready_age_max_us",
                            (double)stats.queue_batch_ready_age_max_us);
    cJSON_AddNumberToObject(obj, "queue_send_start_age_max_us",
                            (double)stats.queue_send_start_age_max_us);
    cJSON_AddNumberToObject(obj, "queue_drop_age_max_us",
                            (double)stats.queue_drop_age_max_us);
    cJSON_AddNumberToObject(obj, "batch_wait_max_us",
                            (double)stats.batch_wait_max_us);
    cJSON_AddNumberToObject(obj, "queued_frames", (double)stats.queued_frames);
    cJSON_AddNumberToObject(obj, "queued_bytes", (double)stats.queued_bytes);
    cJSON_AddNumberToObject(obj, "sent_frames", (double)stats.sent_frames);
    cJSON_AddNumberToObject(obj, "sent_bytes", (double)stats.sent_bytes);
    cJSON_AddNumberToObject(obj, "queue_full", (double)stats.queue_full);
    cJSON_AddNumberToObject(obj, "overload_dropped_frames",
                            (double)stats.overload_dropped_frames);
    cJSON_AddNumberToObject(obj, "overload_dropped_bytes",
                            (double)stats.overload_dropped_bytes);
    cJSON_AddNumberToObject(obj, "rejected_frames", (double)stats.rejected_frames);
    cJSON_AddNumberToObject(obj, "rejected_bytes", (double)stats.rejected_bytes);
    cJSON_AddNumberToObject(obj, "send_failures", (double)stats.send_failures);
    cJSON_AddNumberToObject(obj, "fallback_frames", (double)stats.fallback_frames);
    cJSON_AddNumberToObject(obj, "queued_fallback_frames", (double)stats.queued_fallback_frames);
    cJSON_AddNumberToObject(obj, "queued_fallback_bytes", (double)stats.queued_fallback_bytes);
    cJSON_AddNumberToObject(obj, "fallback_failures", (double)stats.fallback_failures);
    cJSON_AddNumberToObject(obj, "stop_dropped_frames", (double)stats.stop_dropped_frames);
    cJSON_AddNumberToObject(obj, "stop_dropped_bytes", (double)stats.stop_dropped_bytes);
    cJSON_AddNumberToObject(obj, "connect_events", (double)stats.connect_events);
    cJSON_AddNumberToObject(obj, "disconnect_events", (double)stats.disconnect_events);
    cJSON_AddNumberToObject(obj, "error_events", (double)stats.error_events);
    cJSON_AddNumberToObject(obj, "closed_events", (double)stats.closed_events);
    cJSON_AddNumberToObject(obj, "downlink_frames", (double)stats.downlink_frames);
    cJSON_AddNumberToObject(obj, "downlink_bytes", (double)stats.downlink_bytes);
    cJSON_AddNumberToObject(obj, "downlink_failures", (double)stats.downlink_failures);
    cJSON_AddNumberToObject(obj, "compression_calls", (double)stats.compression_calls);
    cJSON_AddNumberToObject(obj, "compressed_frames", (double)stats.compressed_frames);
    cJSON_AddNumberToObject(obj, "raw_envelope_frames", (double)stats.raw_envelope_frames);
    cJSON_AddNumberToObject(obj, "compression_failures", (double)stats.compression_failures);
    cJSON_AddNumberToObject(obj, "raw_bytes", (double)stats.raw_bytes);
    cJSON_AddNumberToObject(obj, "wire_bytes", (double)stats.wire_bytes);
    cJSON_AddNumberToObject(obj, "compression_total_us", (double)stats.compression_total_us);
    cJSON_AddNumberToObject(obj, "compression_max_us", (double)stats.compression_max_us);
    cJSON_AddNumberToObject(obj, "send_calls", (double)stats.send_calls);
    cJSON_AddNumberToObject(obj, "send_total_us", (double)stats.send_total_us);
    cJSON_AddNumberToObject(obj, "send_max_us", (double)stats.send_max_us);
    cJSON_AddNumberToObject(obj, "ws_data_lock_wait_max_us",
                            (double)stats.ws_data_lock_wait_max_us);
    cJSON_AddNumberToObject(obj, "ws_data_lock_timeouts",
                            (double)stats.ws_data_lock_timeouts);
    cJSON_AddNumberToObject(obj, "ws_transport_send_max_us",
                            (double)stats.ws_transport_send_max_us);
    cJSON_AddNumberToObject(obj, "ws_ping_lock_wait_max_us",
                            (double)stats.ws_ping_lock_wait_max_us);
    cJSON_AddNumberToObject(obj, "ws_ping_lock_timeouts",
                            (double)stats.ws_ping_lock_timeouts);
    cJSON_AddNumberToObject(obj, "ws_ping_send_max_us",
                            (double)stats.ws_ping_send_max_us);
    cJSON_AddNumberToObject(obj, "last_event_id", (double)stats.last_event_id);
    cJSON_AddItemToObject(root, "cloud_ws_uplink", obj);
}

static void add_cloud_osc_keepalive_status(cJSON *root)
{
    bool active;
    int64_t lease_deadline_us;
    int64_t heartbeat_deadline_us;
    int64_t last_sent_us;
    uint32_t sent;
    uint32_t failures;
    uint32_t expirations;

    portENTER_CRITICAL(&s_ws_osc_state_lock);
    active = s_ws_keepalive.active;
    lease_deadline_us = s_ws_keepalive.lease_deadline_us;
    heartbeat_deadline_us = s_ws_keepalive.heartbeat_deadline_us;
    last_sent_us = s_ws_keepalive_last_sent_us;
    sent = s_ws_keepalive_sent;
    failures = s_ws_keepalive_failures;
    expirations = s_ws_keepalive_expirations;
    portEXIT_CRITICAL(&s_ws_osc_state_lock);

    int64_t now_us = esp_timer_get_time();
    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
        return;
    }
    cJSON_AddBoolToObject(obj, "active", active);
    cJSON_AddNumberToObject(
        obj, "lease_remaining_ms",
        active && lease_deadline_us > now_us
            ? (double)((lease_deadline_us - now_us) / 1000LL)
            : 0);
    cJSON_AddNumberToObject(
        obj, "heartbeat_due_ms",
        active && heartbeat_deadline_us > now_us
            ? (double)((heartbeat_deadline_us - now_us) / 1000LL)
            : 0);
    cJSON_AddNumberToObject(obj, "sent", (double)sent);
    cJSON_AddNumberToObject(obj, "failures", (double)failures);
    cJSON_AddNumberToObject(obj, "expirations", (double)expirations);
    cJSON_AddNumberToObject(
        obj, "last_sent_age_ms",
        last_sent_us > 0 && now_us > last_sent_us
            ? (double)((now_us - last_sent_us) / 1000LL)
            : 0);
    cJSON_AddItemToObject(root, "cloud_osc_keepalive", obj);
}

static void add_display_status(cJSON *root)
{
    if (s_runtime.get_display_stats == NULL) {
        return;
    }

    display_port_stats_t display;
    memset(&display, 0, sizeof(display));
    s_runtime.get_display_stats(&display, s_runtime.ctx);

    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
        return;
    }
    cJSON_AddBoolToObject(obj, "enabled", display.enabled);
    cJSON_AddStringToObject(obj, "backend", display.backend);
    cJSON_AddStringToObject(obj, "status", display.status);
    cJSON_AddNumberToObject(obj, "width", display.width);
    cJSON_AddNumberToObject(obj, "height", display.height);
    cJSON_AddNumberToObject(obj, "flush_count", display.flush_count);
    cJSON_AddNumberToObject(obj, "status_update_count", display.status_update_count);
    cJSON_AddNumberToObject(obj, "last_flush_bytes", display.last_flush_bytes);
    if (display.last_flush_us > 0) {
        int64_t age_ms = (esp_timer_get_time() - display.last_flush_us) / 1000;
        cJSON_AddNumberToObject(obj, "last_flush_age_ms", age_ms < 0 ? 0 : age_ms);
    }
    cJSON_AddItemToObject(root, "display", obj);
}

static void add_menu_status(cJSON *root)
{
    if (s_runtime.get_menu_snapshot == NULL) {
        return;
    }

    system_menu_snapshot_t menu;
    memset(&menu, 0, sizeof(menu));
    s_runtime.get_menu_snapshot(&menu, s_runtime.ctx);

    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
        return;
    }
    cJSON_AddBoolToObject(obj, "active", menu.active);
    cJSON_AddNumberToObject(obj, "page", menu.page);
    cJSON_AddNumberToObject(obj, "depth", menu.depth);
    cJSON_AddNumberToObject(obj, "selected", menu.selected);
    cJSON_AddNumberToObject(obj, "item_count", menu.item_count);
    cJSON_AddNumberToObject(obj, "event_count", menu.event_count);
    cJSON_AddStringToObject(obj, "title", menu.title);
    cJSON_AddStringToObject(obj, "path", menu.path);
    cJSON_AddStringToObject(obj, "message", menu.message);
    cJSON_AddItemToObject(root, "menu", obj);
}

static void add_motor_params_status(cJSON *root)
{
    if (s_runtime.get_motor_param_count == NULL ||
        s_runtime.get_motor_param_capacity == NULL) {
        return;
    }

    cJSON *obj = cJSON_CreateObject();
    if (obj == NULL) {
        return;
    }
    cJSON_AddNumberToObject(obj, "count", s_runtime.get_motor_param_count(s_runtime.ctx));
    cJSON_AddNumberToObject(obj, "capacity", s_runtime.get_motor_param_capacity(s_runtime.ctx));
    cJSON_AddItemToObject(root, "motor_params", obj);
}

static void status_timer_cb(void *arg)
{
    (void)arg;
    uint32_t lease_generation = ws_osc_state_expire(esp_timer_get_time());
    if (lease_generation != 0) {
        cloud_ws_uplink_set_active(false, lease_generation);
    }
    cloud_mqtt_publish_status_now();
}

static void publish_ack(const char *command_id, const char *type, bool ok, const char *message)
{
    if (!s_connected || s_client == NULL) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "command_id", command_id != NULL ? command_id : "");
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "type", type != NULL ? type : "");
    cJSON_AddStringToObject(root, "message", message != NULL ? message : "");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        esp_mqtt_client_publish(s_client, s_ack_topic, payload, 0, 1, 0);
        cJSON_free(payload);
    }
    cJSON_Delete(root);
}

static void publish_bus_ack(const char *message_id, const char *channel, bool ok, const char *message)
{
    if (!s_connected || s_client == NULL) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "message_id", message_id != NULL ? message_id : "");
    cJSON_AddStringToObject(root, "channel", channel != NULL ? channel : "");
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "message", message != NULL ? message : "");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        esp_mqtt_client_publish(s_client, s_bus_ack_topic, payload, 0, 1, 0);
        cJSON_free(payload);
    }
    cJSON_Delete(root);
}

static bool publish_ws_frame_mqtt(const uint8_t *data, size_t len)
{
    bool osc_streaming = false;
    int64_t active_until_us = 0;
    ws_osc_state_snapshot(&osc_streaming, &active_until_us);
    if (!s_connected || s_client == NULL || data == NULL || len == 0 ||
        len > CLOUD_MQTT_WS_FRAME_MAX_LEN ||
        esp_timer_get_time() > active_until_us) {
        return false;
    }

    char payload_hex[CLOUD_MQTT_WS_FRAME_MAX_LEN * 2U + 1U];
    if (!hex_encode(data, len, payload_hex, sizeof(payload_hex))) {
        return false;
    }

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return false;
    }
    cJSON_AddStringToObject(root, "message_id", "ws-uart-rx");
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "channel", "ws");
    cJSON_AddStringToObject(root, "payload_hex", payload_hex);

    bool published = false;
    char *json = cJSON_PrintUnformatted(root);
    if (json != NULL) {
        int message_id = osc_streaming
                             ? esp_mqtt_client_enqueue(
                                   s_client, s_pub_topic, json, 0, 0, 0, true)
                             : esp_mqtt_client_publish(
                                   s_client, s_pub_topic, json, 0, 1, 0);
        published = message_id >= 0;
        cJSON_free(json);
    }
    cJSON_Delete(root);
    return published;
}

static void publish_ws_frame(const uint8_t *data, size_t len)
{
    int64_t active_until_us = 0;
    ws_osc_state_snapshot(NULL, &active_until_us);
    if (data == NULL || len == 0 ||
        esp_timer_get_time() > active_until_us) {
        return;
    }

    size_t offset = 0;
    while (offset < len) {
        size_t chunk_len = MIN(len - offset, CLOUD_MQTT_WS_FRAME_MAX_LEN);
        (void)cloud_ws_uplink_send(data + offset, chunk_len);
        offset += chunk_len;
    }
}

static bool parse_net_mode(const cJSON *args, system_net_mode_t *out)
{
    const cJSON *mode = cJSON_GetObjectItem(args, "mode");
    if (!cJSON_IsString(mode) || out == NULL) {
        return false;
    }
    if (strcmp(mode->valuestring, "ap") == 0) {
        *out = SYSTEM_NET_AP;
        return true;
    }
    if (strcmp(mode->valuestring, "sta") == 0) {
        *out = SYSTEM_NET_STA;
        return true;
    }
    if (strcmp(mode->valuestring, "apsta") == 0) {
        *out = SYSTEM_NET_APSTA;
        return true;
    }
    return false;
}

static bool parse_comm_mode(const cJSON *args, app_comm_mode_t *out)
{
    const cJSON *mode = cJSON_GetObjectItem(args, "mode");
    if (!cJSON_IsString(mode) || out == NULL) {
        return false;
    }
    if (strcmp(mode->valuestring, "auto") == 0) {
        *out = APP_COMM_AUTO;
        return true;
    }
    if (strcmp(mode->valuestring, "wifi") == 0) {
        *out = APP_COMM_WIFI;
        return true;
    }
    if (strcmp(mode->valuestring, "ble") == 0) {
        *out = APP_COMM_BLE;
        return true;
    }
    return false;
}

static void handle_set_wifi_mode(const char *command_id, const char *type, const cJSON *args)
{
    system_net_mode_t mode;
    if (!parse_net_mode(args, &mode)) {
        publish_ack(command_id, type, false, "mode must be ap/sta/apsta");
        return;
    }
    if (s_runtime.set_wifi_mode == NULL) {
        publish_ack(command_id, type, false, "wifi mode callback missing");
        return;
    }

    esp_err_t err = s_runtime.set_wifi_mode(mode, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "queued" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
}

static void handle_set_uart_baud(const char *command_id, const char *type, const cJSON *args)
{
    const cJSON *baud = cJSON_GetObjectItem(args, "baud");
    if (!cJSON_IsNumber(baud) || baud->valuedouble < 1200 || baud->valuedouble > 5000000) {
        publish_ack(command_id, type, false, "baud out of range");
        return;
    }
    if (s_runtime.set_uart_baud == NULL) {
        publish_ack(command_id, type, false, "uart callback missing");
        return;
    }

    esp_err_t err = s_runtime.set_uart_baud((uint32_t)baud->valuedouble, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "applied" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
}

static void handle_set_comm_mode(const char *command_id, const char *type, const cJSON *args)
{
    app_comm_mode_t mode;
    if (!parse_comm_mode(args, &mode)) {
        publish_ack(command_id, type, false, "mode must be auto/wifi/ble");
        return;
    }
    if (s_runtime.set_comm_mode == NULL) {
        publish_ack(command_id, type, false, "comm callback missing");
        return;
    }

    esp_err_t err = s_runtime.set_comm_mode(mode, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "applied" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
}

static void handle_ble_start(const char *command_id, const char *type)
{
    if (s_runtime.ble_start == NULL) {
        publish_ack(command_id, type, false, "ble callback missing");
        return;
    }

    esp_err_t err = s_runtime.ble_start(s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "ble started" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
}

static void handle_display_text(const char *command_id, const char *type, const cJSON *args)
{
    const cJSON *text = cJSON_GetObjectItem(args, "text");
    if (!cJSON_IsString(text) || text->valuestring[0] == '\0') {
        publish_ack(command_id, type, false, "text required");
        return;
    }
    if (s_runtime.display_text == NULL) {
        publish_ack(command_id, type, false, "display callback missing");
        return;
    }

    esp_err_t err = s_runtime.display_text(text->valuestring, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_ack(command_id, type, ok, ok ? "displayed" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }
}

static void handle_bus_ws_frame(const char *message_id, const char *channel, const cJSON *root)
{
    const cJSON *payload_hex = cJSON_GetObjectItem(root, "payload_hex");
    if (!cJSON_IsString(payload_hex) || payload_hex->valuestring[0] == '\0') {
        publish_bus_ack(message_id, channel, false, "payload_hex required");
        return;
    }
    if (s_runtime.send_ws_frame == NULL) {
        publish_bus_ack(message_id, channel, false, "send_ws_frame callback missing");
        return;
    }

    uint8_t frame[CLOUD_MQTT_WS_FRAME_MAX_LEN];
    size_t frame_len = 0;
    if (!hex_decode(payload_hex->valuestring, frame, sizeof(frame), &frame_len) || frame_len == 0) {
        publish_bus_ack(message_id, channel, false, "invalid payload_hex");
        return;
    }

    cloud_mqtt_note_realtime_control(frame, frame_len);
    esp_err_t err = s_runtime.send_ws_frame(frame, frame_len, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_bus_ack(message_id, channel, ok, ok ? "ws forwarded" : esp_err_to_name(err));
}

void cloud_mqtt_note_realtime_control(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return;
    }
    int64_t now_us = esp_timer_get_time();
    ws_osc_keepalive_note_control(data, len, now_us);
    if (is_osc_stop_frame(data, len)) {
        uint32_t lease_generation = ws_osc_state_set(false, 0);
        cloud_ws_uplink_set_active(false, lease_generation);
        return;
    }
    uint32_t lease_generation = ws_osc_state_refresh(
        is_osc_start_frame(data, len),
        now_us + CLOUD_MQTT_WS_ACTIVE_US);
    cloud_ws_uplink_set_active(true, lease_generation);
}

static void handle_command(const char *payload, int payload_len)
{
    if (payload == NULL || payload_len <= 0) {
        publish_ack("", "", false, "empty command");
        return;
    }

    char *json = calloc((size_t)payload_len + 1U, 1U);
    if (json == NULL) {
        publish_ack("", "", false, "no memory");
        return;
    }
    memcpy(json, payload, (size_t)payload_len);

    cJSON *root = cJSON_Parse(json);
    free(json);
    if (root == NULL) {
        publish_ack("", "", false, "invalid json");
        return;
    }

    const cJSON *command_id = cJSON_GetObjectItem(root, "command_id");
    const cJSON *type = cJSON_GetObjectItem(root, "type");
    const char *command_id_text = cJSON_IsString(command_id) ? command_id->valuestring : "";
    const char *type_text = cJSON_IsString(type) ? type->valuestring : "";
    const cJSON *args = cJSON_GetObjectItem(root, "args");
    if (!cJSON_IsObject(args)) {
        args = root;
    }

    if (strcmp(type_text, "query_status") == 0) {
        cloud_mqtt_publish_status_now();
        publish_ack(command_id_text, type_text, true, "status published");
    } else if (strcmp(type_text, "set_wifi_mode") == 0) {
        handle_set_wifi_mode(command_id_text, type_text, args);
    } else if (strcmp(type_text, "set_uart_baud") == 0) {
        handle_set_uart_baud(command_id_text, type_text, args);
    } else if (strcmp(type_text, "set_comm_mode") == 0) {
        handle_set_comm_mode(command_id_text, type_text, args);
    } else if (strcmp(type_text, "ble_start") == 0) {
        handle_ble_start(command_id_text, type_text);
    } else if (strcmp(type_text, "display_text") == 0) {
        handle_display_text(command_id_text, type_text, args);
    } else {
        publish_ack(command_id_text, type_text, false, "unsupported command type");
    }

    cJSON_Delete(root);
}

static void handle_bus_message(const char *payload, int payload_len)
{
    if (payload == NULL || payload_len <= 0) {
        publish_bus_ack("", "", false, "empty bus message");
        return;
    }

    char *json = calloc((size_t)payload_len + 1U, 1U);
    if (json == NULL) {
        publish_bus_ack("", "", false, "no memory");
        return;
    }
    memcpy(json, payload, (size_t)payload_len);

    cJSON *root = cJSON_Parse(json);
    free(json);
    if (root == NULL) {
        publish_bus_ack("", "", false, "invalid json");
        return;
    }

    const cJSON *message_id = cJSON_GetObjectItem(root, "message_id");
    const cJSON *channel = cJSON_GetObjectItem(root, "channel");
    const cJSON *source_type = cJSON_GetObjectItem(root, "source_type");
    const cJSON *source_id = cJSON_GetObjectItem(root, "source_id");
    const cJSON *payload_text = cJSON_GetObjectItem(root, "payload_text");
    if (!cJSON_IsString(payload_text)) {
        payload_text = cJSON_GetObjectItem(root, "payload");
    }

    const char *message_id_text = cJSON_IsString(message_id) ? message_id->valuestring : "";
    const char *channel_text = cJSON_IsString(channel) ? channel->valuestring : "";
    const char *source_type_text = cJSON_IsString(source_type) ? source_type->valuestring : "unknown";
    const char *source_id_text = cJSON_IsString(source_id) ? source_id->valuestring : "unknown";

    if (!cJSON_IsString(channel) || channel_text[0] == '\0') {
        publish_bus_ack(message_id_text, "", false, "channel required");
        cJSON_Delete(root);
        return;
    }

    if (strcmp(channel_text, "ws") == 0) {
        handle_bus_ws_frame(message_id_text, channel_text, root);
        cJSON_Delete(root);
        return;
    }

    if (strcmp(channel_text, "notify") != 0) {
        publish_bus_ack(message_id_text, channel_text, false, "unsupported channel");
        cJSON_Delete(root);
        return;
    }

    if (!cJSON_IsString(payload_text) || payload_text->valuestring[0] == '\0') {
        publish_bus_ack(message_id_text, channel_text, false, "payload_text required");
        cJSON_Delete(root);
        return;
    }

    if (s_runtime.display_text == NULL) {
        publish_bus_ack(message_id_text, channel_text, false, "display callback missing");
        cJSON_Delete(root);
        return;
    }

    ESP_LOGI(TAG, "bus notify from %s:%s", source_type_text, source_id_text);
    esp_err_t err = s_runtime.display_text(payload_text->valuestring, s_runtime.ctx);
    bool ok = err == ESP_OK;
    publish_bus_ack(message_id_text, channel_text, ok, ok ? "displayed" : esp_err_to_name(err));
    if (ok) {
        cloud_mqtt_publish_status_now();
    }

    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;

    if (event_id == MQTT_EVENT_CONNECTED) {
        s_connected = true;
        esp_mqtt_client_publish(s_client, s_availability_topic, "online", 0, 1, 1);
        esp_mqtt_client_subscribe(s_client, s_cmd_topic, 1);
        esp_mqtt_client_subscribe(s_client, s_inbox_topic, 1);
        cloud_mqtt_publish_status_now();
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        s_connected = false;
    } else if (event_id == MQTT_EVENT_DATA && event != NULL) {
        if ((int)strlen(s_cmd_topic) == event->topic_len &&
            strncmp(event->topic, s_cmd_topic, event->topic_len) == 0) {
            handle_command(event->data, event->data_len);
        } else if ((int)strlen(s_inbox_topic) == event->topic_len &&
                   strncmp(event->topic, s_inbox_topic, event->topic_len) == 0) {
            handle_bus_message(event->data, event->data_len);
        }
    }
}

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime)
{
    if (config == NULL || runtime == NULL || config->device_id == NULL ||
        config->mqtt_uri == NULL || config->device_id[0] == '\0' ||
        config->mqtt_uri[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    s_runtime = *runtime;
    build_topics();

    if (!s_config.enabled) {
        s_initialized = true;
        return ESP_OK;
    }

    const esp_timer_create_args_t timer_args = {
        .callback = status_timer_cb,
        .name = "cloud_mqtt_status",
    };
    esp_err_t err = esp_timer_create(&timer_args, &s_status_timer);
    if (err != ESP_OK) {
        return err;
    }

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = s_config.mqtt_uri,
        .session.last_will = {
            .topic = s_availability_topic,
            .msg = "offline",
            .msg_len = 7,
            .qos = 1,
            .retain = true,
        },
    };

    s_client = esp_mqtt_client_init(&mqtt_cfg);
    if (s_client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    cloud_osc_keepalive_reset(&s_ws_keepalive);
    if (xTaskCreate(ws_osc_keepalive_task, "cloud_osc_hb",
                    CLOUD_MQTT_OSC_KEEPALIVE_TASK_STACK, NULL,
                    CLOUD_MQTT_OSC_KEEPALIVE_TASK_PRIORITY,
                    &s_ws_keepalive_task) != pdPASS) {
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
        esp_timer_delete(s_status_timer);
        s_status_timer = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_initialized = true;
    ESP_LOGI(TAG, "cloud MQTT configured: id=%s uri=%s", s_config.device_id, s_config.mqtt_uri);
    return ESP_OK;
}

void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status)
{
    if (!s_initialized || !s_config.enabled || s_client == NULL || status == NULL) {
        return;
    }

    bool should_run = status->mode != SYSTEM_NET_AP && status->sta_connected;
    if (should_run && !s_started) {
        s_started = true;
        esp_mqtt_client_start(s_client);
        if (s_status_timer != NULL) {
            esp_timer_start_periodic(s_status_timer, CLOUD_MQTT_STATUS_INTERVAL_US);
        }
    } else if (!should_run && s_started) {
        if (s_connected) {
            esp_mqtt_client_publish(s_client, s_availability_topic, "offline", 0, 1, 1);
        }
        if (s_status_timer != NULL) {
            esp_timer_stop(s_status_timer);
        }
        esp_mqtt_client_stop(s_client);
        s_started = false;
        s_connected = false;
    }
}

void cloud_mqtt_publish_status_now(void)
{
    if (!s_connected || s_client == NULL || s_runtime.get_wifi_status == NULL) {
        return;
    }

    wifi_manager_status_t wifi;
    memset(&wifi, 0, sizeof(wifi));
    s_runtime.get_wifi_status(&wifi, s_runtime.ctx);

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    if (s_config.device_mac != NULL && s_config.device_mac[0] != '\0') {
        cJSON_AddStringToObject(root, "device_mac", s_config.device_mac);
    }
    cJSON_AddStringToObject(root, "fw", "wireless-debug");
    cJSON_AddNumberToObject(root, "uptime_ms", (double)(esp_timer_get_time() / 1000));
    cJSON_AddStringToObject(root, "net_mode", net_mode_json_name(wifi.mode));
    cJSON_AddBoolToObject(root, "sta_configured", wifi.sta_configured);
    cJSON_AddBoolToObject(root, "sta_connecting", wifi.sta_connecting);
    cJSON_AddBoolToObject(root, "sta_connected", wifi.sta_connected);
    cJSON_AddStringToObject(root, "ap_ip", wifi.ap_ip);
    cJSON_AddStringToObject(root, "sta_ip", wifi.sta_ip);
    cJSON_AddNumberToObject(root, "uart_baud",
                            s_runtime.get_uart_baud != NULL ? s_runtime.get_uart_baud(s_runtime.ctx) : 0);
    cJSON_AddStringToObject(root, "comm_mode",
                            s_runtime.get_comm_mode != NULL ?
                            comm_mode_json_name(s_runtime.get_comm_mode(s_runtime.ctx)) : "auto");
    cJSON_AddBoolToObject(root, "ble_ready",
                          s_runtime.ble_is_started != NULL && s_runtime.ble_is_started(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "ble_subscribed",
                          s_runtime.ble_has_subscribers != NULL && s_runtime.ble_has_subscribers(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "wifi_ws_client",
                          s_runtime.wifi_ws_client_connected != NULL &&
                          s_runtime.wifi_ws_client_connected(s_runtime.ctx));
    cJSON_AddNumberToObject(root, "restart_reason", esp_reset_reason());
    add_heap_status(root);
    add_comm_stats_status(root);
    add_cloud_ws_uplink_status(root);
    add_cloud_osc_keepalive_status(root);
    add_display_status(root);
    add_menu_status(root);
    add_motor_params_status(root);

    char *json = cJSON_PrintUnformatted(root);
    if (json != NULL) {
        esp_mqtt_client_publish(s_client, s_status_topic, json, 0, 1, 1);
        cJSON_free(json);
    }
    cJSON_Delete(root);
}

void cloud_mqtt_publish_ws_frame(const uint8_t *data, size_t len)
{
    publish_ws_frame(data, len);
}

bool cloud_mqtt_publish_ws_fallback(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (!publish_ws_frame_mqtt(data, len)) {
        cloud_ws_uplink_note_fallback_failure();
        return false;
    }
    cloud_ws_uplink_note_fallback();
    return true;
}
