#include "display_port.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#if CONFIG_DISPLAY_BACKEND_SSD1315
#include "esp_check.h"
#include "driver/i2c_master.h"
#endif

static const char *TAG = "display_port";

#if CONFIG_ENABLE_DISPLAY
static SemaphoreHandle_t s_display_mutex;
static uint8_t s_framebuffer[DISPLAY_FRAMEBUFFER_SIZE];
static display_port_stats_t s_stats = {
    .enabled = true,
#if CONFIG_DISPLAY_BACKEND_SSD1315
    .backend = "ssd1315",
#elif CONFIG_DISPLAY_BACKEND_VIRTUAL
    .backend = "virtual",
#else
    .backend = "custom",
#endif
    .status = "not_init",
    .width = DISPLAY_WIDTH,
    .height = DISPLAY_HEIGHT,
    .scl_gpio = DISPLAY_SSD1315_SCL_GPIO,
    .sda_gpio = DISPLAY_SSD1315_SDA_GPIO,
    .i2c_addr = DISPLAY_SSD1315_I2C_ADDR,
};

#if CONFIG_DISPLAY_BACKEND_SSD1315
static i2c_master_bus_handle_t s_i2c_bus;
static i2c_master_dev_handle_t s_i2c_dev;
static bool s_panel_ready;

static esp_err_t ssd1315_write_control(uint8_t control, const uint8_t *data, size_t len)
{
    if (s_i2c_dev == NULL || data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t tx[17];
    tx[0] = control;
    while (len > 0) {
        size_t chunk = len > (sizeof(tx) - 1) ? (sizeof(tx) - 1) : len;
        memcpy(&tx[1], data, chunk);
        esp_err_t ret = i2c_master_transmit(s_i2c_dev, tx, chunk + 1, 20);
        if (ret != ESP_OK) {
            return ret;
        }
        data += chunk;
        len -= chunk;
    }
    return ESP_OK;
}

static esp_err_t ssd1315_cmds(const uint8_t *cmds, size_t len)
{
    return ssd1315_write_control(0x00, cmds, len);
}

static esp_err_t ssd1315_data(const uint8_t *data, size_t len)
{
    return ssd1315_write_control(0x40, data, len);
}

static esp_err_t ssd1315_init_panel(void)
{
    i2c_master_bus_config_t bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .i2c_port = DISPLAY_SSD1315_I2C_PORT,
        .sda_io_num = DISPLAY_SSD1315_SDA_GPIO,
        .scl_io_num = DISPLAY_SSD1315_SCL_GPIO,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_config, &s_i2c_bus),
                        TAG, "create i2c bus failed");

    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = DISPLAY_SSD1315_I2C_ADDR,
        .scl_speed_hz = DISPLAY_SSD1315_I2C_HZ,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s_i2c_bus, &dev_config, &s_i2c_dev),
                        TAG, "add ssd1315 device failed");

    esp_err_t probe_ret = i2c_master_probe(s_i2c_bus, DISPLAY_SSD1315_I2C_ADDR, 20);
    if (probe_ret != ESP_OK) {
        ESP_LOGW(TAG, "SSD1315 not detected at 0x%02x: %s",
                 DISPLAY_SSD1315_I2C_ADDR, esp_err_to_name(probe_ret));
        return probe_ret;
    }

    const uint8_t init_cmds[] = {
        0xAE,       /* display off */
        0x20, 0x02, /* page addressing */
        0xB0,
        0xC8,
        0x00,
        0x10,
        0x40,
        0x81, 0x7F,
        0xA1,
        0xA6,
        0xA8, DISPLAY_HEIGHT - 1,
        0xA4,
        0xD3, 0x00,
        0xD5, 0x80,
        0xD9, 0xF1,
        0xDA, 0x12,
        0xDB, 0x40,
        0x8D, 0x14,
        0xAF,       /* display on */
    };
    ESP_RETURN_ON_ERROR(ssd1315_cmds(init_cmds, sizeof(init_cmds)),
                        TAG, "ssd1315 init failed");
    s_panel_ready = true;
    return ESP_OK;
}

static esp_err_t ssd1315_flush_pages(uint8_t first_page, uint8_t last_page)
{
    const uint8_t page_count = DISPLAY_HEIGHT / 8;
    if (first_page >= page_count) {
        first_page = page_count - 1;
    }
    if (last_page >= page_count) {
        last_page = page_count - 1;
    }
    if (first_page > last_page) {
        return ESP_ERR_INVALID_ARG;
    }

    for (uint8_t page = first_page; page <= last_page; page++) {
        uint8_t col = DISPLAY_SSD1315_COLUMN_OFFSET;
        const uint8_t addr_cmds[] = {
            (uint8_t)(0xB0 | page),
            (uint8_t)(0x00 | (col & 0x0F)),
            (uint8_t)(0x10 | (col >> 4)),
        };
        ESP_RETURN_ON_ERROR(ssd1315_cmds(addr_cmds, sizeof(addr_cmds)),
                            TAG, "ssd1315 set page failed");
        ESP_RETURN_ON_ERROR(ssd1315_data(&s_framebuffer[(size_t)page * DISPLAY_WIDTH],
                                         DISPLAY_WIDTH),
                            TAG, "ssd1315 page write failed");
    }
    return ESP_OK;
}

static esp_err_t ssd1315_flush_all(void)
{
    return ssd1315_flush_pages(0, (DISPLAY_HEIGHT / 8) - 1);
}
#endif

static void framebuffer_set_pixel(uint16_t x, uint16_t y, bool on)
{
    if (x >= DISPLAY_WIDTH || y >= DISPLAY_HEIGHT) {
        return;
    }
    size_t index = (size_t)(y / 8) * DISPLAY_WIDTH + x;
    uint8_t mask = (uint8_t)(1U << (y & 7));
    if (on) {
        s_framebuffer[index] |= mask;
    } else {
        s_framebuffer[index] &= (uint8_t)~mask;
    }
}

static void ssd1315_draw_status_pattern(void)
{
    memset(s_framebuffer, 0, sizeof(s_framebuffer));

    /* Minimal alignment target: single-pixel border, corner blocks, and center cross. */
    for (uint16_t x = 0; x < DISPLAY_WIDTH; x++) {
        framebuffer_set_pixel(x, 0, true);
        framebuffer_set_pixel(x, DISPLAY_HEIGHT - 1, true);
    }

    for (uint16_t y = 0; y < DISPLAY_HEIGHT; y++) {
        framebuffer_set_pixel(0, y, true);
        framebuffer_set_pixel(DISPLAY_WIDTH - 1, y, true);
    }

    const uint16_t block = 6;
    for (uint16_t y = 2; y < 2 + block; y++) {
        for (uint16_t x = 2; x < 2 + block; x++) {
            framebuffer_set_pixel(x, y, true);
            framebuffer_set_pixel(DISPLAY_WIDTH - 1 - x, y, true);
            framebuffer_set_pixel(x, DISPLAY_HEIGHT - 1 - y, true);
            framebuffer_set_pixel(DISPLAY_WIDTH - 1 - x, DISPLAY_HEIGHT - 1 - y, true);
        }
    }

    uint16_t cx = DISPLAY_WIDTH / 2;
    uint16_t cy = DISPLAY_HEIGHT / 2;
    for (uint16_t x = cx - 12; x <= cx + 12; x++) {
        framebuffer_set_pixel(x, cy, true);
    }
    for (uint16_t y = cy - 12; y <= cy + 12; y++) {
        framebuffer_set_pixel(cx, y, true);
    }

    for (uint16_t y = cy - 2; y <= cy + 2; y++) {
        for (uint16_t x = cx - 2; x <= cx + 2; x++) {
            framebuffer_set_pixel(x, y, true);
        }
    }
}

static void display_write_rgb565_to_framebuffer(const display_area_t *area, const uint16_t *pixels)
{
    if (pixels == NULL) {
        ssd1315_draw_status_pattern();
        return;
    }

    uint32_t src_index = 0;
    for (uint16_t y = area->y1; y <= area->y2; y++) {
        for (uint16_t x = area->x1; x <= area->x2; x++, src_index++) {
            uint16_t rgb = pixels[src_index];
            uint8_t r = (uint8_t)((rgb >> 11) & 0x1F);
            uint8_t g = (uint8_t)((rgb >> 5) & 0x3F);
            uint8_t b = (uint8_t)(rgb & 0x1F);
            bool on = ((uint16_t)r * 299 + (uint16_t)g * 587 + (uint16_t)b * 114) > 30000;
            framebuffer_set_pixel(x, y, on);
        }
    }
}

static bool display_area_is_valid(const display_area_t *area)
{
    if (area == NULL) return false;
    if (area->x1 > area->x2 || area->y1 > area->y2) return false;
    if (area->x2 >= DISPLAY_WIDTH || area->y2 >= DISPLAY_HEIGHT) return false;
    return true;
}

static bool display_stats_try_lock(TickType_t wait_ticks)
{
    if (s_display_mutex == NULL) {
        return false;
    }
    return xSemaphoreTake(s_display_mutex, wait_ticks) == pdTRUE;
}

static void display_stats_unlock(void)
{
    if (s_display_mutex != NULL) {
        xSemaphoreGive(s_display_mutex);
    }
}

esp_err_t display_port_init(void)
{
    if (s_display_mutex == NULL) {
        s_display_mutex = xSemaphoreCreateMutex();
        if (s_display_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    display_area_t full = {
        .x1 = 0,
        .y1 = 0,
        .x2 = DISPLAY_WIDTH - 1,
        .y2 = DISPLAY_HEIGHT - 1,
    };

#if CONFIG_DISPLAY_BACKEND_SSD1315
    esp_err_t ret = ssd1315_init_panel();
    if (ret != ESP_OK) {
        display_port_set_status("ssd1315_missing");
        return ret;
    }
#endif

    display_port_set_status("display_init");
    ESP_LOGI(TAG, "Display backend=%s, size=%ux%u",
             s_stats.backend, s_stats.width, s_stats.height);
    return display_port_flush_rgb565(&full, NULL);
}

esp_err_t display_port_flush_rgb565(const display_area_t *area, const uint16_t *pixels)
{
    if (!display_area_is_valid(area)) {
        return ESP_ERR_INVALID_ARG;
    }

    uint32_t width = (uint32_t)area->x2 - area->x1 + 1;
    uint32_t height = (uint32_t)area->y2 - area->y1 + 1;
    uint32_t bytes = width * height / 8;
    if (bytes == 0) {
        bytes = 1;
    }

    if (display_stats_try_lock(pdMS_TO_TICKS(1))) {
        s_stats.flush_count++;
        s_stats.last_area = *area;
        s_stats.last_flush_bytes = bytes;
        s_stats.last_flush_us = esp_timer_get_time();
        display_write_rgb565_to_framebuffer(area, pixels);
        display_stats_unlock();
    }

#if CONFIG_DISPLAY_BACKEND_SSD1315
    if (!s_panel_ready) {
        return ESP_OK;
    }
    return pixels == NULL ? ssd1315_flush_all() :
           ssd1315_flush_pages(area->y1 / 8, area->y2 / 8);
#else
    return ESP_OK;
#endif
}

esp_err_t display_port_flush_mono(const display_area_t *area, const uint8_t *bits, uint16_t stride_bytes)
{
    if (!display_area_is_valid(area) || bits == NULL || stride_bytes == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    uint32_t width = (uint32_t)area->x2 - area->x1 + 1;
    uint32_t height = (uint32_t)area->y2 - area->y1 + 1;
    uint32_t bytes = (width * height + 7) / 8;

    if (display_stats_try_lock(pdMS_TO_TICKS(1))) {
        s_stats.flush_count++;
        s_stats.last_area = *area;
        s_stats.last_flush_bytes = bytes;
        s_stats.last_flush_us = esp_timer_get_time();

        for (uint16_t y = area->y1; y <= area->y2; y++) {
            const uint8_t *row = bits + ((uint32_t)y - area->y1) * stride_bytes;
            for (uint16_t x = area->x1; x <= area->x2; x++) {
                uint16_t local_x = (uint16_t)(x - area->x1);
                bool on = (row[local_x / 8] & (uint8_t)(0x80U >> (local_x & 7))) != 0;
                framebuffer_set_pixel(x, y, on);
            }
        }

        display_stats_unlock();
    }

#if CONFIG_DISPLAY_BACKEND_SSD1315
    if (!s_panel_ready) {
        return ESP_OK;
    }
    return ssd1315_flush_pages(area->y1 / 8, area->y2 / 8);
#else
    return ESP_OK;
#endif
}

void display_port_set_status(const char *status)
{
    if (status == NULL) {
        status = "unknown";
    }

    if (display_stats_try_lock(pdMS_TO_TICKS(1))) {
        snprintf(s_stats.status, sizeof(s_stats.status), "%s", status);
        s_stats.status_update_count++;
        display_stats_unlock();
    }

    if (s_stats.flush_count == 0) {
        display_area_t full = {
            .x1 = 0,
            .y1 = 0,
            .x2 = DISPLAY_WIDTH - 1,
            .y2 = DISPLAY_HEIGHT - 1,
        };
        display_port_flush_rgb565(&full, NULL);
    }
}

void display_port_get_stats(display_port_stats_t *out)
{
    if (out == NULL) return;

    if (display_stats_try_lock(pdMS_TO_TICKS(20))) {
        *out = s_stats;
        display_stats_unlock();
    } else {
        memset(out, 0, sizeof(*out));
        out->enabled = true;
        snprintf(out->backend, sizeof(out->backend), "%s", "busy");
    }
}

size_t display_port_copy_framebuffer(uint8_t *out, size_t out_size)
{
    if (out == NULL || out_size == 0) {
        return 0;
    }

    size_t copy_size = out_size < sizeof(s_framebuffer) ? out_size : sizeof(s_framebuffer);
    if (display_stats_try_lock(pdMS_TO_TICKS(20))) {
        memcpy(out, s_framebuffer, copy_size);
        display_stats_unlock();
        return copy_size;
    }
    return 0;
}

#else

esp_err_t display_port_init(void)
{
    return ESP_OK;
}

esp_err_t display_port_flush_rgb565(const display_area_t *area, const uint16_t *pixels)
{
    (void)area;
    (void)pixels;
    return ESP_OK;
}

esp_err_t display_port_flush_mono(const display_area_t *area, const uint8_t *bits, uint16_t stride_bytes)
{
    (void)area;
    (void)bits;
    (void)stride_bytes;
    return ESP_OK;
}

void display_port_set_status(const char *status)
{
    (void)status;
}

void display_port_get_stats(display_port_stats_t *out)
{
    if (out == NULL) return;
    memset(out, 0, sizeof(*out));
    out->enabled = false;
    snprintf(out->backend, sizeof(out->backend), "%s", "disabled");
}

size_t display_port_copy_framebuffer(uint8_t *out, size_t out_size)
{
    (void)out;
    (void)out_size;
    return 0;
}

#endif
