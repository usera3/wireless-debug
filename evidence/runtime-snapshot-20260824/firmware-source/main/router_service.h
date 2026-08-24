#ifndef ROUTER_SERVICE_H
#define ROUTER_SERVICE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    ROUTER_MODE_IDLE,
    ROUTER_MODE_BLE,
    ROUTER_MODE_WIFI,
} router_mode_t;

typedef size_t (*router_send_fn_t)(const uint8_t *data, size_t len);
typedef void (*router_mode_set_fn_t)(router_mode_t mode, void *ctx);

typedef struct {
    router_mode_t current_mode;
    bool ble_available;
    bool wifi_available;
    router_send_fn_t send_ble;
    router_send_fn_t send_wifi;
    router_mode_set_fn_t set_mode;
    void *set_mode_ctx;
} router_context_t;

void router_dispatch_uart_frame(const router_context_t *ctx, const uint8_t *data, size_t len);
const char *router_mode_name(router_mode_t mode);

#endif /* ROUTER_SERVICE_H */
