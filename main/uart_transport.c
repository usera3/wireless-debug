#include "uart_transport.h"

#include <stdbool.h>
#include "comm_stats.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "uart_transport";

#define UART_TRANSPORT_PORT              UART_NUM_1
#define UART_TRANSPORT_TX_PIN            GPIO_NUM_10
#define UART_TRANSPORT_RX_PIN            GPIO_NUM_9
#define UART_TRANSPORT_BUF_SIZE          (1024 * 32)
#define UART_TRANSPORT_ASSEMBLE_BUF_SIZE (1024 * 64)
#define UART_TRANSPORT_FRAME_IDLE_MS     2
#define UART_TRANSPORT_QUEUE_LEN         20
#define UART_TRANSPORT_RX_TIMEOUT        5
#define UART_TRANSPORT_RX_FULL_THRESHOLD 113
#define UART_TRANSPORT_TASK_STACK        8192
#define UART_TRANSPORT_TASK_PRIORITY     8

static QueueHandle_t s_uart_queue;
static uart_transport_frame_cb_t s_frame_cb;
static void *s_frame_cb_ctx;
static bool s_started;
static uint32_t s_baud = UART_TRANSPORT_DEFAULT_BAUD;
static uint8_t s_assemble_buf[UART_TRANSPORT_ASSEMBLE_BUF_SIZE];

static void dispatch_frame(size_t len)
{
    if (len == 0 || s_frame_cb == NULL) {
        return;
    }
    comm_stats_uart_rx_frame(len);
    s_frame_cb(s_assemble_buf, len, s_frame_cb_ctx);
}

static void uart_transport_task(void *pvParameters)
{
    (void)pvParameters;
    ESP_LOGI(TAG, "UART transport task started");

    uart_event_t event;
    size_t assemble_len = 0;

    for (;;) {
        TickType_t wait_ticks = (assemble_len > 0)
                    ? pdMS_TO_TICKS(UART_TRANSPORT_FRAME_IDLE_MS)
                    : portMAX_DELAY;

        BaseType_t got_event = xQueueReceive(s_uart_queue, &event, wait_ticks);

        if (got_event == pdFALSE) {
            if (assemble_len == 0) {
                continue;
            }
            ESP_LOGD(TAG, "Frame end by SW timeout, len=%u", (unsigned)assemble_len);
            dispatch_frame(assemble_len);
            assemble_len = 0;
            continue;
        }

        if (event.type == UART_DATA) {
            int n;
            do {
                n = uart_read_bytes(UART_TRANSPORT_PORT,
                                    s_assemble_buf + assemble_len,
                                    UART_TRANSPORT_ASSEMBLE_BUF_SIZE - assemble_len,
                                    0);
                if (n > 0) {
                    assemble_len += (size_t)n;
                }
            } while (n > 0 && assemble_len < UART_TRANSPORT_ASSEMBLE_BUF_SIZE);

            if (assemble_len >= UART_TRANSPORT_ASSEMBLE_BUF_SIZE) {
                ESP_LOGW(TAG, "Assemble buffer full, len=%u", (unsigned)assemble_len);
                dispatch_frame(assemble_len);
                assemble_len = 0;
                continue;
            }

            if (event.timeout_flag) {
                dispatch_frame(assemble_len);
                assemble_len = 0;
            }
            continue;
        }

        if (event.type == UART_FIFO_OVF || event.type == UART_BUFFER_FULL) {
            ESP_LOGW(TAG, "UART overflow event=%d, flushing", event.type);
            comm_stats_uart_overflow();
            uart_transport_flush();
            assemble_len = 0;
        }
    }
}

esp_err_t uart_transport_start(uart_transport_frame_cb_t frame_cb, void *ctx)
{
    if (frame_cb == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_started) {
        s_frame_cb = frame_cb;
        s_frame_cb_ctx = ctx;
        return ESP_OK;
    }

    s_frame_cb = frame_cb;
    s_frame_cb_ctx = ctx;

    uart_config_t uart_config = {
        .baud_rate = UART_TRANSPORT_DEFAULT_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    esp_err_t ret = uart_driver_install(UART_TRANSPORT_PORT,
                                        UART_TRANSPORT_BUF_SIZE,
                                        UART_TRANSPORT_BUF_SIZE,
                                        UART_TRANSPORT_QUEUE_LEN,
                                        &s_uart_queue,
                                        ESP_INTR_FLAG_IRAM);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = uart_set_rx_timeout(UART_TRANSPORT_PORT, UART_TRANSPORT_RX_TIMEOUT);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = uart_set_rx_full_threshold(UART_TRANSPORT_PORT, UART_TRANSPORT_RX_FULL_THRESHOLD);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = uart_param_config(UART_TRANSPORT_PORT, &uart_config);
    if (ret != ESP_OK) {
        return ret;
    }

    ret = uart_set_pin(UART_TRANSPORT_PORT,
                       UART_TRANSPORT_TX_PIN,
                       UART_TRANSPORT_RX_PIN,
                       UART_PIN_NO_CHANGE,
                       UART_PIN_NO_CHANGE);
    if (ret != ESP_OK) {
        return ret;
    }

    gpio_set_pull_mode(UART_TRANSPORT_TX_PIN, GPIO_PULLUP_ONLY);
    gpio_set_pull_mode(UART_TRANSPORT_RX_PIN, GPIO_PULLUP_ONLY);

    if (xTaskCreate(uart_transport_task, "uart_transport",
                    UART_TRANSPORT_TASK_STACK, NULL,
                    UART_TRANSPORT_TASK_PRIORITY, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_started = true;
    ESP_LOGI(TAG, "UART initialized: Baud=%lu, TX=%d (PU), RX=%d (PU)",
             (unsigned long)s_baud,
             (int)UART_TRANSPORT_TX_PIN,
             (int)UART_TRANSPORT_RX_PIN);
    return ESP_OK;
}

esp_err_t uart_transport_set_baud(uint32_t baud)
{
    if (baud < UART_TRANSPORT_MIN_BAUD || baud > UART_TRANSPORT_MAX_BAUD) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t ret = uart_set_baudrate(UART_TRANSPORT_PORT, baud);
    if (ret == ESP_OK) {
        s_baud = baud;
    }
    return ret;
}

int uart_transport_write(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return 0;
    }
    int written = uart_write_bytes(UART_TRANSPORT_PORT, (const char *)data, len);
    comm_stats_uart_tx_result(len, written);
    return written;
}

void uart_transport_flush(void)
{
    (void)uart_flush_input(UART_TRANSPORT_PORT);
    if (s_uart_queue != NULL) {
        xQueueReset(s_uart_queue);
    }
}
