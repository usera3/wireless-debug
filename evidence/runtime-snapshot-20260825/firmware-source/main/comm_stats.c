#include "comm_stats.h"

#include <string.h>
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static comm_stats_snapshot_t s_stats;
static portMUX_TYPE s_stats_lock = portMUX_INITIALIZER_UNLOCKED;

static void add_u64(uint64_t *field, uint64_t value)
{
    portENTER_CRITICAL(&s_stats_lock);
    *field += value;
    portEXIT_CRITICAL(&s_stats_lock);
}

static void inc_u64(uint64_t *field)
{
    add_u64(field, 1);
}

void comm_stats_uart_rx_frame(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.uart_rx_frames++;
    s_stats.uart_rx_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_uart_tx_result(size_t requested, int written)
{
    portENTER_CRITICAL(&s_stats_lock);
    if (written > 0) {
        s_stats.uart_tx_bytes += (uint64_t)written;
    }
    if (written < 0 || (size_t)written < requested) {
        s_stats.uart_tx_failures++;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_uart_overflow(int event_type, size_t assemble_bytes, size_t driver_bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.uart_overflows++;
    if (event_type == UART_FIFO_OVF) {
        s_stats.uart_fifo_overflows++;
    } else if (event_type == UART_BUFFER_FULL) {
        s_stats.uart_buffer_full_overflows++;
    }
    s_stats.uart_overflow_assemble_bytes += assemble_bytes;
    s_stats.uart_overflow_driver_bytes += driver_bytes;
    s_stats.uart_last_overflow_event = (uint64_t)event_type;
    s_stats.uart_last_overflow_assemble_bytes = assemble_bytes;
    s_stats.uart_last_overflow_driver_bytes = driver_bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_uart_dispatch(uint32_t duration_us)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.uart_dispatch_calls++;
    s_stats.uart_dispatch_total_us += duration_us;
    if (duration_us > s_stats.uart_dispatch_max_us) {
        s_stats.uart_dispatch_max_us = duration_us;
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_uart_route_timing(bool cloud_route, uint32_t duration_us)
{
    portENTER_CRITICAL(&s_stats_lock);
    if (cloud_route) {
        s_stats.uart_cloud_route_calls++;
        s_stats.uart_cloud_route_total_us += duration_us;
        if (duration_us > s_stats.uart_cloud_route_max_us) {
            s_stats.uart_cloud_route_max_us = duration_us;
        }
    } else {
        s_stats.uart_local_route_calls++;
        s_stats.uart_local_route_total_us += duration_us;
        if (duration_us > s_stats.uart_local_route_max_us) {
            s_stats.uart_local_route_max_us = duration_us;
        }
    }
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_ble_rx_frame(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.ble_rx_frames++;
    s_stats.ble_rx_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_ble_tx_bytes(size_t bytes)
{
    add_u64(&s_stats.ble_tx_bytes, bytes);
}

void comm_stats_ble_notify_failure(size_t dropped_bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.ble_notify_failures++;
    s_stats.ble_dropped_bytes += dropped_bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_ble_no_subscriber_drop(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.ble_no_subscriber_drops++;
    s_stats.ble_dropped_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_ble_alloc_failure(void)
{
    inc_u64(&s_stats.ble_alloc_failures);
}

void comm_stats_wifi_rx_frame(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.wifi_rx_frames++;
    s_stats.wifi_rx_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_wifi_rx_failure(void)
{
    inc_u64(&s_stats.wifi_rx_failures);
}

void comm_stats_wifi_tx_queued(size_t bytes)
{
    add_u64(&s_stats.wifi_tx_queued_bytes, bytes);
}

void comm_stats_wifi_tx_sent(size_t bytes)
{
    add_u64(&s_stats.wifi_tx_sent_bytes, bytes);
}

void comm_stats_wifi_tx_failure(void)
{
    inc_u64(&s_stats.wifi_tx_failures);
}

void comm_stats_wifi_no_client_drop(size_t bytes)
{
    (void)bytes;
    inc_u64(&s_stats.wifi_no_client_drops);
}

void comm_stats_wifi_pool_exhausted(void)
{
    inc_u64(&s_stats.wifi_pool_exhausted);
}

void comm_stats_wifi_queue_full(void)
{
    inc_u64(&s_stats.wifi_queue_full);
}

void comm_stats_wifi_httpd_queue_failure(void)
{
    inc_u64(&s_stats.wifi_httpd_queue_failures);
}

void comm_stats_route_idle_drop(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.route_idle_drops++;
    s_stats.route_dropped_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_route_unavailable_drop(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.route_unavailable_drops++;
    s_stats.route_dropped_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_route_partial_drop(size_t bytes)
{
    portENTER_CRITICAL(&s_stats_lock);
    s_stats.route_partial_drops++;
    s_stats.route_dropped_bytes += bytes;
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_get_snapshot(comm_stats_snapshot_t *out)
{
    if (out == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_stats_lock);
    memcpy(out, &s_stats, sizeof(*out));
    portEXIT_CRITICAL(&s_stats_lock);
}

void comm_stats_reset(void)
{
    portENTER_CRITICAL(&s_stats_lock);
    memset(&s_stats, 0, sizeof(s_stats));
    portEXIT_CRITICAL(&s_stats_lock);
}
