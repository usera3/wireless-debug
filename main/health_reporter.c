#include "health_reporter.h"

#include <stdbool.h>
#include <string.h>
#include "comm_stats.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define HEALTH_REPORT_INTERVAL_MS 30000
#define HEALTH_REPORT_TASK_STACK 4096
#define HEALTH_REPORT_TASK_PRIORITY 3

static const char *TAG = "health";

static bool s_started;

static uint64_t total_error_count(const comm_stats_snapshot_t *s)
{
    return s->uart_tx_failures +
           s->uart_overflows +
           s->ble_notify_failures +
           s->ble_no_subscriber_drops +
           s->ble_alloc_failures +
           s->wifi_tx_failures +
           s->wifi_no_client_drops +
           s->wifi_pool_exhausted +
           s->wifi_queue_full +
           s->wifi_httpd_queue_failures +
           s->wifi_rx_failures +
           s->route_idle_drops +
           s->route_unavailable_drops +
           s->route_partial_drops;
}

static uint64_t total_io_count(const comm_stats_snapshot_t *s)
{
    return s->uart_rx_bytes +
           s->uart_tx_bytes +
           s->ble_rx_bytes +
           s->ble_tx_bytes +
           s->wifi_rx_bytes +
           s->wifi_tx_sent_bytes +
           s->wifi_tx_queued_bytes;
}

static void log_health(const char *level, const comm_stats_snapshot_t *s)
{
    ESP_LOGI(TAG,
             "%s uart(rx=%llu/%lluB tx=%lluB fail=%llu ovf=%llu) "
             "ble(rx=%llu/%lluB tx=%lluB fail=%llu nosub=%llu drop=%llu alloc=%llu) "
             "wifi(rx=%llu/%lluB queued=%lluB sent=%lluB fail=%llu nocli=%llu pool=%llu qfull=%llu httpdq=%llu rxfail=%llu) "
             "route(idle=%llu unavail=%llu partial=%llu dropB=%llu) "
             "heap(internal=%u min=%u total=%u largest=%u)",
             level,
             (unsigned long long)s->uart_rx_frames,
             (unsigned long long)s->uart_rx_bytes,
             (unsigned long long)s->uart_tx_bytes,
             (unsigned long long)s->uart_tx_failures,
             (unsigned long long)s->uart_overflows,
             (unsigned long long)s->ble_rx_frames,
             (unsigned long long)s->ble_rx_bytes,
             (unsigned long long)s->ble_tx_bytes,
             (unsigned long long)s->ble_notify_failures,
             (unsigned long long)s->ble_no_subscriber_drops,
             (unsigned long long)s->ble_dropped_bytes,
             (unsigned long long)s->ble_alloc_failures,
             (unsigned long long)s->wifi_rx_frames,
             (unsigned long long)s->wifi_rx_bytes,
             (unsigned long long)s->wifi_tx_queued_bytes,
             (unsigned long long)s->wifi_tx_sent_bytes,
             (unsigned long long)s->wifi_tx_failures,
             (unsigned long long)s->wifi_no_client_drops,
             (unsigned long long)s->wifi_pool_exhausted,
             (unsigned long long)s->wifi_queue_full,
             (unsigned long long)s->wifi_httpd_queue_failures,
             (unsigned long long)s->wifi_rx_failures,
             (unsigned long long)s->route_idle_drops,
             (unsigned long long)s->route_unavailable_drops,
             (unsigned long long)s->route_partial_drops,
             (unsigned long long)s->route_dropped_bytes,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

static void health_reporter_task(void *arg)
{
    (void)arg;
    comm_stats_snapshot_t prev;
    comm_stats_get_snapshot(&prev);
    uint64_t prev_errors = total_error_count(&prev);
    uint64_t prev_io = total_io_count(&prev);

    log_health("OK", &prev);

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(HEALTH_REPORT_INTERVAL_MS));

        comm_stats_snapshot_t current;
        comm_stats_get_snapshot(&current);

        uint64_t errors = total_error_count(&current);
        uint64_t io = total_io_count(&current);
        if (errors != prev_errors) {
            log_health("ALERT", &current);
        } else if (io != prev_io || memcmp(&current, &prev, sizeof(current)) == 0) {
            log_health("OK", &current);
        }

        prev = current;
        prev_errors = errors;
        prev_io = io;
    }
}

esp_err_t health_reporter_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    if (xTaskCreate(health_reporter_task, "health_report",
                    HEALTH_REPORT_TASK_STACK, NULL,
                    HEALTH_REPORT_TASK_PRIORITY, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_started = true;
    ESP_LOGI(TAG, "Health reporter started, interval=%d ms", HEALTH_REPORT_INTERVAL_MS);
    return ESP_OK;
}
