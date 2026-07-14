#ifndef CLOUD_WS_UPLINK_H
#define CLOUD_WS_UPLINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "wifi_manager.h"

#define CLOUD_WS_UPLINK_SCHEMA_VERSION 4U

typedef bool (*cloud_ws_uplink_fallback_fn_t)(const uint8_t *data, size_t len, void *ctx);

typedef struct {
    const char *base_uri;
    const char *device_id;
    bool enabled;
    cloud_ws_uplink_fallback_fn_t fallback;
    void *fallback_ctx;
} cloud_ws_uplink_config_t;

typedef struct {
    bool connected;
    bool queue_in_psram;
    uint32_t sender_stack_min_free;
    uint32_t queue_pending_frames;
    uint32_t queued_frames;
    uint32_t sent_frames;
    uint32_t sent_bytes;
    uint32_t queue_full;
    uint32_t overload_dropped_frames;
    uint32_t send_failures;
    uint32_t fallback_frames;
    uint32_t queued_fallback_frames;
    uint32_t fallback_failures;
    uint32_t stop_dropped_frames;
    uint32_t connect_events;
    uint32_t disconnect_events;
    uint32_t error_events;
    uint32_t closed_events;
    int32_t last_event_id;
} cloud_ws_uplink_stats_t;

esp_err_t cloud_ws_uplink_init(const cloud_ws_uplink_config_t *config);
void cloud_ws_uplink_notify_wifi_state(const wifi_manager_status_t *status);
void cloud_ws_uplink_set_active(bool active);
bool cloud_ws_uplink_send(const uint8_t *data, size_t len);
bool cloud_ws_uplink_is_connected(void);
void cloud_ws_uplink_note_fallback(void);
void cloud_ws_uplink_note_fallback_failure(void);
void cloud_ws_uplink_get_stats(cloud_ws_uplink_stats_t *out);

#endif /* CLOUD_WS_UPLINK_H */
