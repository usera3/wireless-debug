#ifndef CLOUD_WS_COMPRESSION_STATE_H
#define CLOUD_WS_COMPRESSION_STATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>


#define CLOUD_WS_CAPABILITY "WDC1"
#define CLOUD_WS_CAPABILITY_LEN 4U

typedef struct {
    bool connected;
    bool capable;
    bool offer_pending;
    bool offer_sent;
    bool active;
} cloud_ws_compression_state_t;

static inline void cloud_ws_compression_on_connected(
    cloud_ws_compression_state_t *state, bool capable)
{
    if (state == NULL) {
        return;
    }
    *state = (cloud_ws_compression_state_t){
        .connected = true,
        .capable = capable,
        .offer_pending = capable,
    };
}

static inline void cloud_ws_compression_on_disconnected(
    cloud_ws_compression_state_t *state)
{
    if (state != NULL) {
        memset(state, 0, sizeof(*state));
    }
}

static inline bool cloud_ws_compression_take_offer(
    cloud_ws_compression_state_t *state)
{
    if (state == NULL || !state->connected || !state->capable ||
        !state->offer_pending || state->offer_sent || state->active) {
        return false;
    }
    state->offer_pending = false;
    state->offer_sent = true;
    return true;
}

static inline void cloud_ws_compression_offer_failed(
    cloud_ws_compression_state_t *state)
{
    if (state != NULL) {
        state->offer_pending = false;
        state->offer_sent = false;
        state->active = false;
    }
}

static inline bool cloud_ws_compression_accept_reply(
    cloud_ws_compression_state_t *state,
    const uint8_t *data,
    size_t len)
{
    if (state == NULL || data == NULL || !state->connected || !state->capable ||
        !state->offer_sent || state->active || len != CLOUD_WS_CAPABILITY_LEN ||
        memcmp(data, CLOUD_WS_CAPABILITY, CLOUD_WS_CAPABILITY_LEN) != 0) {
        return false;
    }
    state->active = true;
    return true;
}

#endif /* CLOUD_WS_COMPRESSION_STATE_H */
