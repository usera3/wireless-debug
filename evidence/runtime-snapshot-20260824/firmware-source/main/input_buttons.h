#ifndef INPUT_BUTTONS_H
#define INPUT_BUTTONS_H

#include "esp_err.h"
#include "system_menu.h"

#define INPUT_BUTTON_S4_GPIO 17
#define INPUT_BUTTON_S5_GPIO 18

typedef void (*input_button_key_cb_t)(system_key_t key, void *ctx);

typedef struct {
    int s4_gpio;
    int s5_gpio;
    input_button_key_cb_t on_key;
    void *ctx;
} input_buttons_config_t;

esp_err_t input_buttons_start(const input_buttons_config_t *config);

#endif /* INPUT_BUTTONS_H */
