#ifndef CLOUD_WS_UPLINK_H
#define CLOUD_WS_UPLINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "wifi_manager.h"

#define CLOUD_WS_UPLINK_SCHEMA_VERSION 7U

typedef bool (*cloud_ws_uplink_fallback_fn_t)(const uint8_t *data, size_t len, void *ctx);
typedef esp_err_t (*cloud_ws_uplink_downlink_fn_t)(const uint8_t *data, size_t len, void *ctx);

typedef struct {
    const char *base_uri;
    const char *device_id;
    bool enabled;
    cloud_ws_uplink_fallback_fn_t fallback;
    void *fallback_ctx;
    cloud_ws_uplink_downlink_fn_t on_downlink;
    void *downlink_ctx;
} cloud_ws_uplink_config_t;

typedef struct {
    bool connected;
    bool queue_in_psram;
    bool compression_capable;
    bool compression_active;
    uint32_t sender_stack_min_free;
    uint32_t queue_pending_frames;
    uint64_t queue_pending_bytes;
    uint32_t queue_high_water_frames;
    uint64_t queue_high_water_bytes;
    uint32_t queue_dequeue_age_samples;
    uint64_t queue_dequeue_age_total_us;
    uint32_t queue_dequeue_age_max_us;
    uint32_t queue_batch_ready_age_max_us;
    uint32_t queue_send_start_age_max_us;
    uint32_t queue_drop_age_max_us;
    uint32_t batch_wait_max_us;
    uint32_t queued_frames;
    uint64_t queued_bytes;
    uint32_t sent_frames;
    uint64_t sent_bytes;
    uint32_t queue_full;
    uint32_t overload_dropped_frames;
    uint64_t overload_dropped_bytes;
    uint32_t rejected_frames;
    uint64_t rejected_bytes;
    uint32_t send_failures;
    uint32_t fallback_frames;
    uint32_t queued_fallback_frames;
    uint64_t queued_fallback_bytes;
    uint32_t fallback_failures;
    uint32_t stop_dropped_frames;
    uint64_t stop_dropped_bytes;
    uint32_t connect_events;
    uint32_t disconnect_events;
    uint32_t error_events;
    uint32_t closed_events;
    uint32_t downlink_frames;
    uint32_t downlink_bytes;
    uint32_t downlink_failures;
    uint32_t compression_calls;
    uint32_t compressed_frames;
    uint32_t raw_envelope_frames;
    uint32_t compression_failures;
    uint64_t raw_bytes;
    uint64_t wire_bytes;
    uint64_t compression_total_us;
    uint32_t compression_max_us;
    uint32_t send_calls;
    uint64_t send_total_us;
    uint32_t send_max_us;
    uint32_t ws_data_lock_wait_max_us;
    uint32_t ws_data_lock_timeouts;
    uint32_t ws_transport_send_max_us;
    uint32_t ws_ping_lock_wait_max_us;
    uint32_t ws_ping_lock_timeouts;
    uint32_t ws_ping_send_max_us;
    int32_t last_event_id;
} cloud_ws_uplink_stats_t;

esp_err_t cloud_ws_uplink_init(const cloud_ws_uplink_config_t *config);
void cloud_ws_uplink_notify_wifi_state(const wifi_manager_status_t *status);
void cloud_ws_uplink_set_active(bool active, uint32_t lease_generation);
bool cloud_ws_uplink_send(const uint8_t *data, size_t len);
bool cloud_ws_uplink_is_connected(void);
void cloud_ws_uplink_note_fallback(void);
void cloud_ws_uplink_note_fallback_failure(void);
void cloud_ws_uplink_get_stats(cloud_ws_uplink_stats_t *out);

#endif /* CLOUD_WS_UPLINK_H */
