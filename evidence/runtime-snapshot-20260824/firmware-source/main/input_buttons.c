#include "input_buttons.h"

#include <string.h>
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define BUTTON_POLL_MS       10
#define BUTTON_DEBOUNCE_MS   30
#define BUTTON_LONG_PRESS_MS 800
#define BUTTON_TASK_STACK    4096
#define BUTTON_TASK_PRIORITY 4

typedef struct {
    int gpio;
    bool stable_pressed;
    bool last_raw_pressed;
    uint32_t raw_changed_ms;
    uint32_t pressed_since_ms;
} button_state_t;

static const char *TAG = "input_buttons";
static input_buttons_config_t s_config;
static bool s_started;
static button_state_t s_s4;
static button_state_t s_s5;

static uint32_t now_ms(void)
{
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

static bool read_pressed(int gpio)
{
    return gpio_get_level(gpio) == 0;
}

static void button_state_init(button_state_t *button, int gpio)
{
    memset(button, 0, sizeof(*button));
    button->gpio = gpio;
    button->last_raw_pressed = read_pressed(gpio);
    button->stable_pressed = button->last_raw_pressed;
    button->raw_changed_ms = now_ms();
    button->pressed_since_ms = button->stable_pressed ? button->raw_changed_ms : 0;
}

static void emit_key(system_key_t key)
{
    if (s_config.on_key != NULL) {
        s_config.on_key(key, s_config.ctx);
    }
}

static void poll_button(button_state_t *button, bool is_s5)
{
    uint32_t now = now_ms();
    bool raw_pressed = read_pressed(button->gpio);

    if (raw_pressed != button->last_raw_pressed) {
        button->last_raw_pressed = raw_pressed;
        button->raw_changed_ms = now;
        return;
    }

    if ((uint32_t)(now - button->raw_changed_ms) < BUTTON_DEBOUNCE_MS ||
        raw_pressed == button->stable_pressed) {
        return;
    }

    button->stable_pressed = raw_pressed;
    if (raw_pressed) {
        button->pressed_since_ms = now;
        return;
    }

    uint32_t held_ms = button->pressed_since_ms == 0 ? 0 : (uint32_t)(now - button->pressed_since_ms);
    button->pressed_since_ms = 0;

    if (is_s5) {
        emit_key(held_ms >= BUTTON_LONG_PRESS_MS ? SYSTEM_KEY_BACK : SYSTEM_KEY_OK);
    } else {
        emit_key(SYSTEM_KEY_NEXT);
    }
}

static void input_buttons_task(void *arg)
{
    (void)arg;
    while (1) {
        poll_button(&s_s4, false);
        poll_button(&s_s5, true);
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
    }
}

static esp_err_t configure_button_gpio(int gpio)
{
    gpio_config_t config = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    return gpio_config(&config);
}

esp_err_t input_buttons_start(const input_buttons_config_t *config)
{
    if (config == NULL || config->on_key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_started) {
        return ESP_OK;
    }

    s_config = *config;
    if (s_config.s4_gpio < 0) {
        s_config.s4_gpio = INPUT_BUTTON_S4_GPIO;
    }
    if (s_config.s5_gpio < 0) {
        s_config.s5_gpio = INPUT_BUTTON_S5_GPIO;
    }

    ESP_RETURN_ON_ERROR(configure_button_gpio(s_config.s4_gpio), TAG, "s4 gpio");
    ESP_RETURN_ON_ERROR(configure_button_gpio(s_config.s5_gpio), TAG, "s5 gpio");

    button_state_init(&s_s4, s_config.s4_gpio);
    button_state_init(&s_s5, s_config.s5_gpio);

    if (xTaskCreate(input_buttons_task, "input_buttons", BUTTON_TASK_STACK,
                    NULL, BUTTON_TASK_PRIORITY, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_started = true;
    ESP_LOGI(TAG, "Buttons started: S4 GPIO%d next, S5 GPIO%d ok/back",
             s_config.s4_gpio, s_config.s5_gpio);
    return ESP_OK;
}
