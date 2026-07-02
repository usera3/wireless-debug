#ifndef UART_TRANSPORT_H
#define UART_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define UART_TRANSPORT_DEFAULT_BAUD 2000000U
#define UART_TRANSPORT_MIN_BAUD    1200U
#define UART_TRANSPORT_MAX_BAUD    5000000U

typedef void (*uart_transport_frame_cb_t)(const uint8_t *data, size_t len, void *ctx);

esp_err_t uart_transport_start(uart_transport_frame_cb_t frame_cb, void *ctx);
esp_err_t uart_transport_set_baud(uint32_t baud);
int uart_transport_write(const uint8_t *data, size_t len);
void uart_transport_flush(void);

#endif /* UART_TRANSPORT_H */
