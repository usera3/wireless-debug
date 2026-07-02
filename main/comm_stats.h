#ifndef COMM_STATS_H
#define COMM_STATS_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint64_t uart_rx_frames;
    uint64_t uart_rx_bytes;
    uint64_t uart_tx_bytes;
    uint64_t uart_tx_failures;
    uint64_t uart_overflows;

    uint64_t ble_rx_frames;
    uint64_t ble_rx_bytes;
    uint64_t ble_tx_bytes;
    uint64_t ble_notify_failures;
    uint64_t ble_no_subscriber_drops;
    uint64_t ble_dropped_bytes;
    uint64_t ble_alloc_failures;

    uint64_t wifi_rx_frames;
    uint64_t wifi_rx_bytes;
    uint64_t wifi_tx_queued_bytes;
    uint64_t wifi_tx_sent_bytes;
    uint64_t wifi_tx_failures;
    uint64_t wifi_no_client_drops;
    uint64_t wifi_pool_exhausted;
    uint64_t wifi_queue_full;
    uint64_t wifi_httpd_queue_failures;
    uint64_t wifi_rx_failures;

    uint64_t route_idle_drops;
    uint64_t route_unavailable_drops;
    uint64_t route_partial_drops;
    uint64_t route_dropped_bytes;
} comm_stats_snapshot_t;

void comm_stats_uart_rx_frame(size_t bytes);
void comm_stats_uart_tx_result(size_t requested, int written);
void comm_stats_uart_overflow(void);

void comm_stats_ble_rx_frame(size_t bytes);
void comm_stats_ble_tx_bytes(size_t bytes);
void comm_stats_ble_notify_failure(size_t dropped_bytes);
void comm_stats_ble_no_subscriber_drop(size_t bytes);
void comm_stats_ble_alloc_failure(void);

void comm_stats_wifi_rx_frame(size_t bytes);
void comm_stats_wifi_rx_failure(void);
void comm_stats_wifi_tx_queued(size_t bytes);
void comm_stats_wifi_tx_sent(size_t bytes);
void comm_stats_wifi_tx_failure(void);
void comm_stats_wifi_no_client_drop(size_t bytes);
void comm_stats_wifi_pool_exhausted(void);
void comm_stats_wifi_queue_full(void);
void comm_stats_wifi_httpd_queue_failure(void);

void comm_stats_route_idle_drop(size_t bytes);
void comm_stats_route_unavailable_drop(size_t bytes);
void comm_stats_route_partial_drop(size_t bytes);

void comm_stats_get_snapshot(comm_stats_snapshot_t *out);
void comm_stats_reset(void);

#endif /* COMM_STATS_H */
