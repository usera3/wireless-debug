#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../main/cloud_ws_downlink_reassembly.h"

static void expect_complete(cloud_ws_downlink_reassembly_t *state,
                            uint8_t opcode,
                            bool fin,
                            size_t payload_len,
                            size_t payload_offset,
                            const uint8_t *data,
                            size_t data_len,
                            const uint8_t *expected,
                            size_t expected_len)
{
    const uint8_t *result_data = NULL;
    size_t result_len = 0;
    cloud_ws_downlink_result_t result = cloud_ws_downlink_reassembly_push(
        state,
        opcode,
        fin,
        payload_len,
        payload_offset,
        data,
        data_len,
        &result_data,
        &result_len);
    assert(result == CLOUD_WS_DOWNLINK_COMPLETE);
    assert(result_len == expected_len);
    assert(memcmp(result_data, expected, expected_len) == 0);
}

static void test_complete_frame(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    const uint8_t frame[] = {0xff, 0x03, 0x00, 0x01, 0x00, 0x01, 0xd1, 0xd4};
    expect_complete(&state, 0x2, true, sizeof(frame), 0,
                    frame, sizeof(frame), frame, sizeof(frame));
}

static void test_client_buffer_chunks(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    const uint8_t frame[] = {0xff, 0x04, 0x00, 0x02, 0x00, 0x02, 0xc5, 0xd5};
    const uint8_t *out = NULL;
    size_t out_len = 0;
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, true, sizeof(frame), 0,
               frame, 3, &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    expect_complete(&state, 0x2, true, sizeof(frame), 3,
                    frame + 3, sizeof(frame) - 3, frame, sizeof(frame));
}

static void test_websocket_continuation_frames(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    const uint8_t frame[] = {0xff, 0x73, 0x00, 0x00, 0x20, 0xd4};
    const uint8_t *out = NULL;
    size_t out_len = 0;
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, false, 2, 0,
               frame, 2, &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x0, true, 4, 0,
               frame + 2, 2, &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    expect_complete(&state, 0x0, true, 4, 2,
                    frame + 4, 2, frame, sizeof(frame));
}

static void test_empty_final_continuation_completes_message(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    const uint8_t frame[] = {0xff, 0x08, 0x00, 0x00, 0x00, 0x00, 0xf5, 0xd5};
    const uint8_t *out = NULL;
    size_t out_len = 0;
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, false, sizeof(frame), 0,
               frame, sizeof(frame), &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    expect_complete(&state, 0x0, true, 0, 0,
                    NULL, 0, frame, sizeof(frame));
}

static void test_invalid_sequences_reset_state(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    const uint8_t bytes[] = {1, 2, 3, 4};
    const uint8_t *out = NULL;
    size_t out_len = 0;
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x0, true, 2, 0,
               bytes, 2, &out, &out_len) == CLOUD_WS_DOWNLINK_REJECTED);
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, true, 4, 0,
               bytes, 2, &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, true, 4, 3,
               bytes + 2, 2, &out, &out_len) == CLOUD_WS_DOWNLINK_REJECTED);
    expect_complete(&state, 0x2, true, sizeof(bytes), 0,
                    bytes, sizeof(bytes), bytes, sizeof(bytes));
}

static void test_oversized_message_is_rejected(void)
{
    cloud_ws_downlink_reassembly_t state = {0};
    uint8_t first[300] = {0};
    uint8_t second[213] = {0};
    const uint8_t *out = NULL;
    size_t out_len = 0;
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x2, false, sizeof(first), 0,
               first, sizeof(first), &out, &out_len) == CLOUD_WS_DOWNLINK_INCOMPLETE);
    assert(cloud_ws_downlink_reassembly_push(
               &state, 0x0, true, sizeof(second), 0,
               second, sizeof(second), &out, &out_len) == CLOUD_WS_DOWNLINK_REJECTED);
}

int main(void)
{
    test_complete_frame();
    test_client_buffer_chunks();
    test_websocket_continuation_frames();
    test_empty_final_continuation_completes_message();
    test_invalid_sequences_reset_state();
    test_oversized_message_is_rejected();
    puts("cloud websocket downlink reassembly regression passed");
    return 0;
}
