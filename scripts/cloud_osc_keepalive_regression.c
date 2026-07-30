#include <assert.h>
#include <stdint.h>

#include "cloud_osc_keepalive.h"

#define SECOND_US 1000000LL
#define LEASE_US (30LL * SECOND_US)
#define HEARTBEAT_US SECOND_US

static cloud_osc_keepalive_action_t poll_at(cloud_osc_keepalive_t *state,
                                             int64_t now_us,
                                             uint8_t *slave_id)
{
    return cloud_osc_keepalive_poll(state, now_us, HEARTBEAT_US, slave_id);
}

int main(void)
{
    const uint8_t start[] = {0xff, 0x71};
    const uint8_t heartbeat[] = {0xff, 0x08};
    const uint8_t stop[] = {0xff, 0x72};
    cloud_osc_keepalive_t state;
    uint8_t slave_id = 0;

    cloud_osc_keepalive_reset(&state);
    cloud_osc_keepalive_note_control(&state, heartbeat, sizeof(heartbeat),
                                     0, LEASE_US, HEARTBEAT_US);
    assert(!state.active);

    cloud_osc_keepalive_note_control(&state, start, sizeof(start),
                                     0, LEASE_US, HEARTBEAT_US);
    assert(state.active);
    assert(state.slave_id == 0xff);
    assert(state.lease_deadline_us == 30 * SECOND_US);
    assert(state.heartbeat_deadline_us == SECOND_US);
    assert(poll_at(&state, SECOND_US - 1, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_NONE);

    assert(poll_at(&state, SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_SEND);
    assert(slave_id == 0xff);
    assert(poll_at(&state, 2 * SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_SEND);
    assert(poll_at(&state, 3 * SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_SEND);

    cloud_osc_keepalive_note_control(&state, heartbeat, sizeof(heartbeat),
                                     3500000, LEASE_US, HEARTBEAT_US);
    assert(state.lease_deadline_us == 33500000);
    assert(state.heartbeat_deadline_us == 4500000);
    assert(poll_at(&state, 4499999, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_NONE);
    assert(poll_at(&state, 4500000, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_SEND);

    cloud_osc_keepalive_note_control(&state, stop, sizeof(stop),
                                     5 * SECOND_US, LEASE_US, HEARTBEAT_US);
    assert(!state.active);
    assert(poll_at(&state, 6 * SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_NONE);

    cloud_osc_keepalive_note_control(&state, start, sizeof(start),
                                     10 * SECOND_US, LEASE_US, HEARTBEAT_US);
    assert(poll_at(&state, 40 * SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_EXPIRED);
    assert(!state.active);
    assert(poll_at(&state, 41 * SECOND_US, &slave_id) ==
           CLOUD_OSC_KEEPALIVE_NONE);

    cloud_osc_keepalive_note_control(&state, NULL, 0, 50 * SECOND_US,
                                     LEASE_US, HEARTBEAT_US);
    assert(!state.active);
    return 0;
}
