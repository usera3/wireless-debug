#ifndef CLOUD_WS_DOWNLINK_REASSEMBLY_H
#define CLOUD_WS_DOWNLINK_REASSEMBLY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CLOUD_WS_DOWNLINK_MAX_BYTES 512U
#define CLOUD_WS_OPCODE_CONTINUATION 0x0U
#define CLOUD_WS_OPCODE_BINARY 0x2U

typedef enum {
    CLOUD_WS_DOWNLINK_INCOMPLETE = 0,
    CLOUD_WS_DOWNLINK_COMPLETE,
    CLOUD_WS_DOWNLINK_REJECTED,
} cloud_ws_downlink_result_t;

typedef struct {
    uint8_t data[CLOUD_WS_DOWNLINK_MAX_BYTES];
    size_t message_len;
    size_t frame_len;
    size_t frame_received;
    uint8_t frame_opcode;
    bool active;
    bool awaiting_continuation;
} cloud_ws_downlink_reassembly_t;

static inline void cloud_ws_downlink_reassembly_reset(
    cloud_ws_downlink_reassembly_t *state)
{
    if (state == NULL) {
        return;
    }
    state->message_len = 0;
    state->frame_len = 0;
    state->frame_received = 0;
    state->frame_opcode = 0;
    state->active = false;
    state->awaiting_continuation = false;
}

static inline cloud_ws_downlink_result_t cloud_ws_downlink_reassembly_reject(
    cloud_ws_downlink_reassembly_t *state)
{
    cloud_ws_downlink_reassembly_reset(state);
    return CLOUD_WS_DOWNLINK_REJECTED;
}

static inline cloud_ws_downlink_result_t cloud_ws_downlink_reassembly_complete(
    cloud_ws_downlink_reassembly_t *state,
    const uint8_t **out_data,
    size_t *out_len)
{
    if (state == NULL || state->message_len == 0) {
        return cloud_ws_downlink_reassembly_reject(state);
    }
    if (out_data != NULL) {
        *out_data = state->data;
    }
    if (out_len != NULL) {
        *out_len = state->message_len;
    }
    state->active = false;
    state->awaiting_continuation = false;
    state->frame_len = 0;
    state->frame_received = 0;
    state->frame_opcode = 0;
    state->message_len = 0;
    return CLOUD_WS_DOWNLINK_COMPLETE;
}

static inline cloud_ws_downlink_result_t cloud_ws_downlink_reassembly_push(
    cloud_ws_downlink_reassembly_t *state,
    uint8_t opcode,
    bool fin,
    size_t payload_len,
    size_t payload_offset,
    const uint8_t *data,
    size_t data_len,
    const uint8_t **out_data,
    size_t *out_len)
{
    if (out_data != NULL) {
        *out_data = NULL;
    }
    if (out_len != NULL) {
        *out_len = 0;
    }
    if (state != NULL && opcode == CLOUD_WS_OPCODE_CONTINUATION && fin &&
        payload_len == 0 && payload_offset == 0 && data_len == 0 &&
        state->active && state->awaiting_continuation) {
        return cloud_ws_downlink_reassembly_complete(state, out_data, out_len);
    }
    if (state == NULL || data == NULL || data_len == 0 || payload_len == 0 ||
        payload_len > CLOUD_WS_DOWNLINK_MAX_BYTES || payload_offset > payload_len ||
        data_len > payload_len - payload_offset) {
        return cloud_ws_downlink_reassembly_reject(state);
    }

    if (payload_offset == 0) {
        if (opcode == CLOUD_WS_OPCODE_BINARY) {
            if (state->active) {
                return cloud_ws_downlink_reassembly_reject(state);
            }
            state->active = true;
            state->message_len = 0;
        } else if (opcode == CLOUD_WS_OPCODE_CONTINUATION) {
            if (!state->active || !state->awaiting_continuation) {
                return cloud_ws_downlink_reassembly_reject(state);
            }
        } else {
            return cloud_ws_downlink_reassembly_reject(state);
        }
        state->frame_len = payload_len;
        state->frame_received = 0;
        state->frame_opcode = opcode;
        state->awaiting_continuation = false;
    } else if (!state->active || opcode != state->frame_opcode ||
               payload_len != state->frame_len ||
               payload_offset != state->frame_received) {
        return cloud_ws_downlink_reassembly_reject(state);
    }

    if (payload_offset != state->frame_received ||
        state->message_len + data_len > CLOUD_WS_DOWNLINK_MAX_BYTES) {
        return cloud_ws_downlink_reassembly_reject(state);
    }

    memcpy(state->data + state->message_len, data, data_len);
    state->message_len += data_len;
    state->frame_received += data_len;
    if (state->frame_received < state->frame_len) {
        return CLOUD_WS_DOWNLINK_INCOMPLETE;
    }
    if (state->frame_received != state->frame_len) {
        return cloud_ws_downlink_reassembly_reject(state);
    }

    if (!fin) {
        state->frame_len = 0;
        state->frame_received = 0;
        state->frame_opcode = 0;
        state->awaiting_continuation = true;
        return CLOUD_WS_DOWNLINK_INCOMPLETE;
    }

    return cloud_ws_downlink_reassembly_complete(state, out_data, out_len);
}

#endif /* CLOUD_WS_DOWNLINK_REASSEMBLY_H */
