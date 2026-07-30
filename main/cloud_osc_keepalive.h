#ifndef CLOUD_OSC_KEEPALIVE_H
#define CLOUD_OSC_KEEPALIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    CLOUD_OSC_KEEPALIVE_NONE = 0,
    CLOUD_OSC_KEEPALIVE_SEND,
    CLOUD_OSC_KEEPALIVE_EXPIRED,
} cloud_osc_keepalive_action_t;

typedef struct {
    bool active;
    uint8_t slave_id;
    int64_t lease_deadline_us;
    int64_t heartbeat_deadline_us;
} cloud_osc_keepalive_t;

void cloud_osc_keepalive_reset(cloud_osc_keepalive_t *state);
void cloud_osc_keepalive_note_control(cloud_osc_keepalive_t *state,
                                      const uint8_t *data, size_t len,
                                      int64_t now_us,
                                      int64_t lease_duration_us,
                                      int64_t heartbeat_interval_us);
cloud_osc_keepalive_action_t cloud_osc_keepalive_poll(
    cloud_osc_keepalive_t *state, int64_t now_us,
    int64_t heartbeat_interval_us, uint8_t *slave_id);

#endif /* CLOUD_OSC_KEEPALIVE_H */
