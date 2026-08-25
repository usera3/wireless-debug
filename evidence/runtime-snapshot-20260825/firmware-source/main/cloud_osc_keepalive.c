#include "cloud_osc_keepalive.h"

#include <string.h>

#define CLOUD_OSC_FUNC_HEARTBEAT 0x08U
#define CLOUD_OSC_FUNC_START 0x71U
#define CLOUD_OSC_FUNC_STOP 0x72U

void cloud_osc_keepalive_reset(cloud_osc_keepalive_t *state)
{
    if (state != NULL) {
        memset(state, 0, sizeof(*state));
    }
}

void cloud_osc_keepalive_note_control(cloud_osc_keepalive_t *state,
                                      const uint8_t *data, size_t len,
                                      int64_t now_us,
                                      int64_t lease_duration_us,
                                      int64_t heartbeat_interval_us)
{
    if (state == NULL || data == NULL || len < 2U ||
        lease_duration_us <= 0 || heartbeat_interval_us <= 0) {
        return;
    }

    if (data[1] == CLOUD_OSC_FUNC_STOP) {
        cloud_osc_keepalive_reset(state);
        return;
    }

    if (data[1] == CLOUD_OSC_FUNC_START) {
        state->active = true;
        state->slave_id = data[0];
    } else if (data[1] != CLOUD_OSC_FUNC_HEARTBEAT || !state->active) {
        return;
    }

    state->lease_deadline_us = now_us + lease_duration_us;
    state->heartbeat_deadline_us = now_us + heartbeat_interval_us;
}

cloud_osc_keepalive_action_t cloud_osc_keepalive_poll(
    cloud_osc_keepalive_t *state, int64_t now_us,
    int64_t heartbeat_interval_us, uint8_t *slave_id)
{
    if (state == NULL || !state->active || heartbeat_interval_us <= 0) {
        return CLOUD_OSC_KEEPALIVE_NONE;
    }

    if (now_us >= state->lease_deadline_us) {
        cloud_osc_keepalive_reset(state);
        return CLOUD_OSC_KEEPALIVE_EXPIRED;
    }

    if (now_us < state->heartbeat_deadline_us) {
        return CLOUD_OSC_KEEPALIVE_NONE;
    }

    if (slave_id != NULL) {
        *slave_id = state->slave_id;
    }
    state->heartbeat_deadline_us = now_us + heartbeat_interval_us;
    return CLOUD_OSC_KEEPALIVE_SEND;
}
