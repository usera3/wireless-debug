#ifndef DISPLAY_PORT_H
#define DISPLAY_PORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifndef CONFIG_ENABLE_DISPLAY
#define CONFIG_ENABLE_DISPLAY 1
#endif

#ifndef CONFIG_DISPLAY_BACKEND_VIRTUAL
#define CONFIG_DISPLAY_BACKEND_VIRTUAL 0
#endif

#ifndef CONFIG_DISPLAY_BACKEND_SSD1315
#define CONFIG_DISPLAY_BACKEND_SSD1315 1
#endif

#if CONFIG_ENABLE_DISPLAY && (CONFIG_DISPLAY_BACKEND_VIRTUAL + CONFIG_DISPLAY_BACKEND_SSD1315 != 1)
#error "Select exactly one display backend: VIRTUAL or SSD1315"
#endif

#ifndef DISPLAY_WIDTH
#define DISPLAY_WIDTH 128
#endif

#ifndef DISPLAY_HEIGHT
#define DISPLAY_HEIGHT 64
#endif

#ifndef DISPLAY_FRAMEBUFFER_SIZE
#define DISPLAY_FRAMEBUFFER_SIZE (((DISPLAY_WIDTH) * (DISPLAY_HEIGHT) + 7) / 8)
#endif

#ifndef DISPLAY_SSD1315_I2C_PORT
#define DISPLAY_SSD1315_I2C_PORT 0
#endif

#ifndef DISPLAY_SSD1315_SCL_GPIO
#define DISPLAY_SSD1315_SCL_GPIO 5
#endif

#ifndef DISPLAY_SSD1315_SDA_GPIO
#define DISPLAY_SSD1315_SDA_GPIO 4
#endif

#ifndef DISPLAY_SSD1315_I2C_ADDR
#define DISPLAY_SSD1315_I2C_ADDR 0x3C
#endif

#ifndef DISPLAY_SSD1315_I2C_HZ
#define DISPLAY_SSD1315_I2C_HZ 100000
#endif

#ifndef DISPLAY_SSD1315_COLUMN_OFFSET
#define DISPLAY_SSD1315_COLUMN_OFFSET 2
#endif

typedef struct {
    uint16_t x1;
    uint16_t y1;
    uint16_t x2;
    uint16_t y2;
} display_area_t;

typedef struct {
    bool enabled;
    char backend[16];
    char status[48];
    uint16_t width;
    uint16_t height;
    int8_t scl_gpio;
    int8_t sda_gpio;
    uint8_t i2c_addr;
    uint32_t flush_count;
    uint32_t status_update_count;
    uint32_t last_flush_bytes;
    int64_t last_flush_us;
    display_area_t last_area;
} display_port_stats_t;

esp_err_t display_port_init(void);
esp_err_t display_port_flush_rgb565(const display_area_t *area, const uint16_t *pixels);
esp_err_t display_port_flush_mono(const display_area_t *area, const uint8_t *bits, uint16_t stride_bytes);
void display_port_set_status(const char *status);
void display_port_get_stats(display_port_stats_t *out);
size_t display_port_copy_framebuffer(uint8_t *out, size_t out_size);

#endif /* DISPLAY_PORT_H */
