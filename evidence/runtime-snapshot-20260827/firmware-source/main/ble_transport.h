#ifndef BLE_TRANSPORT_H
#define BLE_TRANSPORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef void (*ble_transport_rx_fn_t)(const uint8_t *data, size_t len, void *ctx);
typedef void (*ble_transport_ready_fn_t)(bool ready, void *ctx);
typedef void (*ble_transport_status_fn_t)(const char *status, void *ctx);
typedef void (*ble_transport_log_heap_fn_t)(const char *label, void *ctx);

typedef struct {
    ble_transport_rx_fn_t on_rx;
    ble_transport_ready_fn_t on_ready;
    ble_transport_status_fn_t on_status;
    ble_transport_log_heap_fn_t log_heap;
    void *ctx;
} ble_transport_config_t;

esp_err_t ble_spp_transport_init(const ble_transport_config_t *config);
esp_err_t ble_spp_transport_start(void);
bool ble_spp_transport_is_started(void);
bool ble_spp_transport_has_subscribers(void);
size_t ble_spp_transport_send(const uint8_t *data, size_t len);

#endif /* BLE_TRANSPORT_H */
