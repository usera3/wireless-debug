#ifndef WIFI_TRANSPORT_H
#define WIFI_TRANSPORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_http_server.h"

typedef void (*wifi_transport_rx_fn_t)(const uint8_t *data, size_t len, void *ctx);

typedef struct {
    wifi_transport_rx_fn_t on_rx;
    void *ctx;
} wifi_transport_config_t;

esp_err_t wifi_transport_init(const wifi_transport_config_t *config);
esp_err_t wifi_transport_register_ws(httpd_handle_t server);
bool wifi_transport_client_connected(void);
size_t wifi_transport_send(const uint8_t *data, size_t len);

#endif /* WIFI_TRANSPORT_H */
