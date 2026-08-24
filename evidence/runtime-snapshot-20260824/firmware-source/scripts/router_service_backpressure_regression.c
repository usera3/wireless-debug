#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "router_service.h"

static size_t s_send_calls;
static size_t s_send_result;
static size_t s_mode_changes;
static router_mode_t s_last_mode;
static size_t s_idle_drop_bytes;
static size_t s_unavailable_drop_bytes;
static size_t s_partial_drop_bytes;
static size_t s_info_logs;
static size_t s_warning_logs;

void host_test_log_info(void)
{
    s_info_logs++;
}

void host_test_log_warning(void)
{
    s_warning_logs++;
}

void comm_stats_route_idle_drop(size_t bytes)
{
    s_idle_drop_bytes += bytes;
}

void comm_stats_route_unavailable_drop(size_t bytes)
{
    s_unavailable_drop_bytes += bytes;
}

void comm_stats_route_partial_drop(size_t bytes)
{
    s_partial_drop_bytes += bytes;
}

static size_t send_frame(const uint8_t *data, size_t len)
{
    assert(data != NULL);
    assert(len > 0);
    s_send_calls++;
    return s_send_result;
}

static void set_mode(router_mode_t mode, void *ctx)
{
    assert(ctx == NULL);
    s_mode_changes++;
    s_last_mode = mode;
}

static void reset_observations(void)
{
    s_send_calls = 0;
    s_send_result = 0;
    s_mode_changes = 0;
    s_last_mode = ROUTER_MODE_IDLE;
    s_idle_drop_bytes = 0;
    s_unavailable_drop_bytes = 0;
    s_partial_drop_bytes = 0;
    s_info_logs = 0;
    s_warning_logs = 0;
}

static router_context_t wifi_context(router_mode_t mode, bool available)
{
    return (router_context_t) {
        .current_mode = mode,
        .ble_available = false,
        .wifi_available = available,
        .send_ble = send_frame,
        .send_wifi = send_frame,
        .set_mode = set_mode,
        .set_mode_ctx = NULL,
    };
}

static void test_unavailable_explicit_route_never_calls_transport(void)
{
    const uint8_t data[] = {1, 2, 3, 4};
    router_context_t ctx = wifi_context(ROUTER_MODE_WIFI, false);

    reset_observations();
    s_send_result = sizeof(data);
    router_dispatch_uart_frame(&ctx, data, sizeof(data));

    assert(s_send_calls == 0);
    assert(s_unavailable_drop_bytes == sizeof(data));
    assert(s_partial_drop_bytes == 0);
    assert(s_warning_logs == 0);
}

static void test_backpressure_records_counter_without_synchronous_log(void)
{
    const uint8_t data[] = {5, 6, 7, 8, 9};
    router_context_t ctx = wifi_context(ROUTER_MODE_WIFI, true);

    reset_observations();
    s_send_result = 0;
    router_dispatch_uart_frame(&ctx, data, sizeof(data));

    assert(s_send_calls == 1);
    assert(s_partial_drop_bytes == sizeof(data));
    assert(s_warning_logs == 0);
}

static void test_idle_drop_records_counter_without_synchronous_log(void)
{
    const uint8_t data[] = {10, 11, 12};
    router_context_t ctx = wifi_context(ROUTER_MODE_IDLE, false);

    reset_observations();
    router_dispatch_uart_frame(&ctx, data, sizeof(data));

    assert(s_send_calls == 0);
    assert(s_idle_drop_bytes == sizeof(data));
    assert(s_warning_logs == 0);
}

static void test_available_auto_route_switches_and_sends(void)
{
    const uint8_t data[] = {13, 14};
    router_context_t ctx = wifi_context(ROUTER_MODE_IDLE, true);

    reset_observations();
    s_send_result = sizeof(data);
    router_dispatch_uart_frame(&ctx, data, sizeof(data));

    assert(s_send_calls == 1);
    assert(s_mode_changes == 1);
    assert(s_last_mode == ROUTER_MODE_WIFI);
    assert(s_info_logs == 1);
    assert(s_warning_logs == 0);
}

int main(void)
{
    test_unavailable_explicit_route_never_calls_transport();
    test_backpressure_records_counter_without_synchronous_log();
    test_idle_drop_records_counter_without_synchronous_log();
    test_available_auto_route_switches_and_sends();
    return 0;
}
