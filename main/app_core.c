#include "app_core.h"

#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

typedef struct {
    app_comm_mode_t comm_mode;
    uint32_t uart_baud;
    SemaphoreHandle_t mutex;
} app_core_state_t;

static app_core_state_t s_state = {
    .comm_mode = APP_COMM_AUTO,
};

static bool lock_state(TickType_t timeout)
{
    return s_state.mutex != NULL &&
           xSemaphoreTake(s_state.mutex, timeout) == pdTRUE;
}

static void unlock_state(void)
{
    xSemaphoreGive(s_state.mutex);
}

esp_err_t app_core_init(uint32_t default_uart_baud, app_comm_mode_t default_comm_mode)
{
    if (s_state.mutex == NULL) {
        s_state.mutex = xSemaphoreCreateMutex();
        if (s_state.mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (lock_state(pdMS_TO_TICKS(50))) {
        s_state.uart_baud = default_uart_baud;
        s_state.comm_mode = default_comm_mode;
        unlock_state();
    } else {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

app_comm_mode_t app_core_get_comm_mode(void)
{
    app_comm_mode_t mode = APP_COMM_AUTO;
    if (lock_state(pdMS_TO_TICKS(10))) {
        mode = s_state.comm_mode;
        unlock_state();
    }
    return mode;
}

void app_core_set_comm_mode(app_comm_mode_t mode)
{
    if (lock_state(pdMS_TO_TICKS(20))) {
        s_state.comm_mode = mode;
        unlock_state();
    }
}

uint32_t app_core_get_uart_baud(void)
{
    uint32_t baud = 0;
    if (lock_state(pdMS_TO_TICKS(10))) {
        baud = s_state.uart_baud;
        unlock_state();
    }
    return baud;
}

void app_core_set_uart_baud(uint32_t baud)
{
    if (lock_state(pdMS_TO_TICKS(20))) {
        s_state.uart_baud = baud;
        unlock_state();
    }
}

const char *app_core_comm_mode_name(app_comm_mode_t mode)
{
    switch (mode) {
    case APP_COMM_BLE:
        return "BLE";
    case APP_COMM_WIFI:
        return "WIFI";
    case APP_COMM_AUTO:
    default:
        return "AUTO";
    }
}
