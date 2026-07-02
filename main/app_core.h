#ifndef APP_CORE_H
#define APP_CORE_H

#include <stdint.h>
#include "esp_err.h"

typedef enum {
    APP_COMM_AUTO,
    APP_COMM_BLE,
    APP_COMM_WIFI,
} app_comm_mode_t;

esp_err_t app_core_init(uint32_t default_uart_baud, app_comm_mode_t default_comm_mode);

app_comm_mode_t app_core_get_comm_mode(void);
void app_core_set_comm_mode(app_comm_mode_t mode);

uint32_t app_core_get_uart_baud(void);
void app_core_set_uart_baud(uint32_t baud);

const char *app_core_comm_mode_name(app_comm_mode_t mode);

#endif /* APP_CORE_H */
