#include <assert.h>
#include <stdint.h>

#include "cloud_ws_compression_state.h"


static void test_complete_reply_activates_once(void)
{
    cloud_ws_compression_state_t state = {0};
    cloud_ws_compression_on_connected(&state, true);
    assert(state.connected);
    assert(state.capable);
    assert(cloud_ws_compression_take_offer(&state));
    assert(!cloud_ws_compression_take_offer(&state));
    assert(!cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC", 3));
    assert(!cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC2", 4));
    assert(cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC1", 4));
    assert(state.active);
    assert(!cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC1", 4));

    cloud_ws_compression_on_disconnected(&state);
    assert(!state.connected);
    assert(!state.capable);
    assert(!state.offer_pending);
    assert(!state.offer_sent);
    assert(!state.active);
}

static void test_failed_offer_does_not_retry_or_activate(void)
{
    cloud_ws_compression_state_t state = {0};
    cloud_ws_compression_on_connected(&state, true);
    assert(cloud_ws_compression_take_offer(&state));
    cloud_ws_compression_offer_failed(&state);
    assert(!state.offer_pending);
    assert(!state.offer_sent);
    assert(!cloud_ws_compression_take_offer(&state));
    assert(!cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC1", 4));
}

static void test_incapable_connection_stays_legacy(void)
{
    cloud_ws_compression_state_t state = {0};
    cloud_ws_compression_on_connected(&state, false);
    assert(state.connected);
    assert(!state.capable);
    assert(!cloud_ws_compression_take_offer(&state));
    assert(!cloud_ws_compression_accept_reply(
        &state, (const uint8_t *)"WDC1", 4));
}

int main(void)
{
    test_complete_reply_activates_once();
    test_failed_offer_does_not_retry_or_activate();
    test_incapable_connection_stays_legacy();
    return 0;
}
