#include "display_lvgl.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "comm_stats.h"
#include "display_port.h"
#include "display_ui.h"
#include "esp_heap_caps.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "uart_transport.h"

LV_FONT_DECLARE(display_font_fusion_12_zh)

static const char *TAG = "display_lvgl";

#define LVGL_TASK_STACK_SIZE 8192
#define LVGL_TASK_PRIORITY   2
#define LVGL_TICK_MS         5
#define LVGL_BUFFER_ROWS     16
#define LVGL_TASK_MIN_WAIT_MS 5
#define LVGL_TASK_MAX_WAIT_MS 20
#define DISPLAY_STATS_REFRESH_MS 1000
#define DISPLAY_OVERLAY_SCROLL_MS 2500

static SemaphoreHandle_t s_lvgl_mutex;
static SemaphoreHandle_t s_state_mutex;
static lv_display_t *s_display;
static display_ui_state_t s_state = {
    .mode = "IDLE",
    .status = "boot",
    .firmware = "v?",
    .ssid = "-",
    .wifi_ap_ip = "192.168.4.1",
    .wifi_sta_ip = "-",
    .wifi_sta_connecting = false,
    .wifi_sta_connected = false,
    .baud = UART_TRANSPORT_DEFAULT_BAUD,
    .ble_ready = 0,
};
static bool s_ui_dirty = true;
static int64_t s_last_stats_refresh_us;
static int64_t s_last_overlay_scroll_us;

static uint8_t s_lvgl_draw_buf[DISPLAY_WIDTH * LVGL_BUFFER_ROWS * 2];
static uint8_t s_mono_rows[DISPLAY_FRAMEBUFFER_SIZE];

static bool lvgl_lock(TickType_t ticks)
{
    return s_lvgl_mutex != NULL && xSemaphoreTake(s_lvgl_mutex, ticks) == pdTRUE;
}

static void lvgl_unlock(void)
{
    if (s_lvgl_mutex != NULL) {
        xSemaphoreGive(s_lvgl_mutex);
    }
}

static void state_update_string(char *dst, size_t dst_size, const char *src)
{
    if (dst == NULL || dst_size == 0) {
        return;
    }
    if (src == NULL || src[0] == '\0') {
        src = "-";
    }
    snprintf(dst, dst_size, "%s", src);
}

static void state_update_optional_string(char *dst, size_t dst_size, const char *src)
{
    if (dst == NULL || dst_size == 0) {
        return;
    }
    if (src == NULL) {
        src = "";
    }
    snprintf(dst, dst_size, "%s", src);
}

static bool utf8_continuation(unsigned char c)
{
    return (c & 0xC0U) == 0x80U;
}

static void terminate_at_utf8_boundary(char *s)
{
    size_t len;
    size_t start;
    unsigned char c;
    size_t expected = 1;

    if (s == NULL) {
        return;
    }

    len = strlen(s);
    if (len == 0) {
        return;
    }

    start = len - 1;
    while (start > 0 && utf8_continuation((unsigned char)s[start])) {
        start--;
    }

    c = (unsigned char)s[start];
    if (c < 0x80U) {
        expected = 1;
    } else if ((c & 0xE0U) == 0xC0U) {
        expected = 2;
    } else if ((c & 0xF0U) == 0xE0U) {
        expected = 3;
    } else if ((c & 0xF8U) == 0xF0U) {
        expected = 4;
    } else {
        s[start] = '\0';
        return;
    }

    if (start + expected > len) {
        s[start] = '\0';
    }
}

static void normalize_display_punctuation(char *s)
{
    char *read = s;
    char *write = s;

    if (s == NULL) {
        return;
    }

    while (*read != '\0') {
        if ((unsigned char)read[0] == 0xE2U &&
            read[1] != '\0' &&
            read[2] != '\0' &&
            (unsigned char)read[1] == 0x80U) {
            switch ((unsigned char)read[2]) {
            case 0x90U: /* hyphen */
            case 0x91U: /* non-breaking hyphen */
            case 0x92U: /* figure dash */
            case 0x93U: /* en dash */
            case 0x94U: /* em dash */
            case 0x95U: /* horizontal bar */
                *write++ = '-';
                read += 3;
                continue;
            case 0x98U: /* left single quotation mark */
            case 0x99U: /* right single quotation mark */
            case 0x9AU: /* single low-9 quotation mark */
            case 0x9BU: /* single high-reversed-9 quotation mark */
                *write++ = '\'';
                read += 3;
                continue;
            case 0x9CU: /* left double quotation mark */
            case 0x9DU: /* right double quotation mark */
            case 0x9EU: /* double low-9 quotation mark */
            case 0x9FU: /* double high-reversed-9 quotation mark */
                *write++ = '"';
                read += 3;
                continue;
            case 0xA2U: /* bullet */
                *write++ = '*';
                read += 3;
                continue;
            case 0xA6U: /* ellipsis */
                *write++ = '.';
                *write++ = '.';
                *write++ = '.';
                read += 3;
                continue;
            default:
                break;
            }
        }

        if ((unsigned char)read[0] == 0xC2U &&
            read[1] != '\0' &&
            (unsigned char)read[1] == 0xA0U) {
            *write++ = ' ';
            read += 2;
            continue;
        }

        *write++ = *read++;
    }

    *write = '\0';
}

static size_t utf8_encode(uint32_t cp, char *out)
{
    if (out == NULL) {
        return 0;
    }
    if (cp <= 0x7FU) {
        out[0] = (char)cp;
        return 1;
    }
    if (cp <= 0x7FFU) {
        out[0] = (char)(0xC0U | (cp >> 6));
        out[1] = (char)(0x80U | (cp & 0x3FU));
        return 2;
    }
    if (cp <= 0xFFFFU) {
        out[0] = (char)(0xE0U | (cp >> 12));
        out[1] = (char)(0x80U | ((cp >> 6) & 0x3FU));
        out[2] = (char)(0x80U | (cp & 0x3FU));
        return 3;
    }
    if (cp <= 0x10FFFFU) {
        out[0] = (char)(0xF0U | (cp >> 18));
        out[1] = (char)(0x80U | ((cp >> 12) & 0x3FU));
        out[2] = (char)(0x80U | ((cp >> 6) & 0x3FU));
        out[3] = (char)(0x80U | (cp & 0x3FU));
        return 4;
    }
    return 0;
}

static bool utf8_decode_next(const char **cursor, uint32_t *cp)
{
    const unsigned char *s;

    if (cursor == NULL || *cursor == NULL || cp == NULL || **cursor == '\0') {
        return false;
    }

    s = (const unsigned char *)*cursor;
    if (s[0] < 0x80U) {
        *cp = s[0];
        *cursor += 1;
        return true;
    }
    if ((s[0] & 0xE0U) == 0xC0U && utf8_continuation(s[1])) {
        *cp = ((uint32_t)(s[0] & 0x1FU) << 6) |
              (uint32_t)(s[1] & 0x3FU);
        *cursor += 2;
        return true;
    }
    if ((s[0] & 0xF0U) == 0xE0U &&
        utf8_continuation(s[1]) && utf8_continuation(s[2])) {
        *cp = ((uint32_t)(s[0] & 0x0FU) << 12) |
              ((uint32_t)(s[1] & 0x3FU) << 6) |
              (uint32_t)(s[2] & 0x3FU);
        *cursor += 3;
        return true;
    }
    if ((s[0] & 0xF8U) == 0xF0U &&
        utf8_continuation(s[1]) && utf8_continuation(s[2]) &&
        utf8_continuation(s[3])) {
        *cp = ((uint32_t)(s[0] & 0x07U) << 18) |
              ((uint32_t)(s[1] & 0x3FU) << 12) |
              ((uint32_t)(s[2] & 0x3FU) << 6) |
              (uint32_t)(s[3] & 0x3FU);
        *cursor += 4;
        return true;
    }

    *cp = '?';
    *cursor += 1;
    return true;
}

static bool display_font_has_glyph(uint32_t cp)
{
    lv_font_glyph_dsc_t glyph;

    if (cp == '\n' || cp == '\r' || cp == '\t') {
        return true;
    }

    memset(&glyph, 0, sizeof(glyph));
    if (!lv_font_get_glyph_dsc(&display_font_fusion_12_zh, &glyph, cp, 0)) {
        return false;
    }
    return glyph.is_placeholder == 0;
}

static void sanitize_overlay_text_for_font(char *s)
{
    const char *read = s;
    char *write = s;

    if (s == NULL) {
        return;
    }

    while (*read != '\0') {
        uint32_t cp = 0;
        char encoded[4];
        size_t encoded_len;

        if (!utf8_decode_next(&read, &cp)) {
            break;
        }

        if (cp < 0x20U && cp != '\n' && cp != '\r' && cp != '\t') {
            continue;
        }

        if (!display_font_has_glyph(cp)) {
            cp = cp > 0x7FU ? '?' : cp;
        }

        encoded_len = utf8_encode(cp, encoded);
        if (encoded_len == 0) {
            continue;
        }
        for (size_t i = 0; i < encoded_len; i++) {
            *write++ = encoded[i];
        }
    }

    *write = '\0';
}

static void state_update_optional_utf8_string(char *dst, size_t dst_size, const char *src)
{
    state_update_optional_string(dst, dst_size, src);
    normalize_display_punctuation(dst);
    terminate_at_utf8_boundary(dst);
    sanitize_overlay_text_for_font(dst);
}

static bool text_has_non_ascii(const char *s)
{
    if (s == NULL) {
        return false;
    }
    while (*s != '\0') {
        if ((unsigned char)*s >= 0x80U) {
            return true;
        }
        s++;
    }
    return false;
}

static void append_scroll_line(char *dst, size_t dst_size, const char *line)
{
    size_t len;

    if (dst == NULL || dst_size == 0 || line == NULL || line[0] == '\0') {
        return;
    }

    len = strlen(dst);
    if (len > 0 && len + 1 < dst_size) {
        dst[len++] = '\n';
        dst[len] = '\0';
    }
    if (len + 1 < dst_size) {
        snprintf(dst + len, dst_size - len, "%s", line);
    }
}

static uint8_t firmware_month_number(const char *month)
{
    static const char months[][4] = {
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    };

    if (month == NULL) {
        return 0;
    }
    for (uint8_t i = 0; i < sizeof(months) / sizeof(months[0]); i++) {
        if (strncmp(month, months[i], 3) == 0) {
            return (uint8_t)(i + 1);
        }
    }
    return 0;
}

static void init_firmware_label(void)
{
    const esp_app_desc_t *desc = esp_app_get_description();
    char version[5] = "?";
    char month[4] = {0};
    unsigned day = 0;
    uint8_t month_num = 0;
    char date_code[5] = "????";
    char time_code[7] = "??????";

    if (desc != NULL && desc->version[0] != '\0') {
        snprintf(version, sizeof(version), "%.4s", desc->version);
    }

    if (desc != NULL && sscanf(desc->date, "%3s %u", month, &day) == 2) {
        month_num = firmware_month_number(month);
        if (month_num > 0 && day > 0 && day <= 31) {
            date_code[0] = (char)('0' + month_num / 10);
            date_code[1] = (char)('0' + month_num % 10);
            date_code[2] = (char)('0' + day / 10);
            date_code[3] = (char)('0' + day % 10);
            date_code[4] = '\0';
        }
    }

    if (desc != NULL && strlen(desc->time) >= 8) {
        snprintf(time_code, sizeof(time_code), "%c%c%c%c%c%c",
                 desc->time[0], desc->time[1],
                 desc->time[3], desc->time[4],
                 desc->time[6], desc->time[7]);
    }

    snprintf(s_state.firmware, sizeof(s_state.firmware),
             "v%s %s-%s", version, date_code, time_code);
}

static void mark_dirty_locked(void)
{
    s_state.update_count++;
    s_ui_dirty = true;
}

static void refresh_runtime_stats_locked(void)
{
    s_state.uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    s_state.heap_internal_kb =
        (uint32_t)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024U);
    s_state.heap_min_internal_kb =
        (uint32_t)(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024U);
    s_state.heap_largest_kb =
        (uint32_t)(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) / 1024U);
    comm_stats_get_snapshot(&s_state.stats);
}

static void display_lvgl_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    int32_t x1 = area->x1 < 0 ? 0 : area->x1;
    int32_t y1 = area->y1 < 0 ? 0 : area->y1;
    int32_t x2 = area->x2 >= DISPLAY_WIDTH ? DISPLAY_WIDTH - 1 : area->x2;
    int32_t y2 = area->y2 >= DISPLAY_HEIGHT ? DISPLAY_HEIGHT - 1 : area->y2;

    if (x1 <= x2 && y1 <= y2) {
        uint16_t width = (uint16_t)(x2 - x1 + 1);
        uint16_t height = (uint16_t)(y2 - y1 + 1);
        uint16_t src_stride_px = (uint16_t)(area->x2 - area->x1 + 1);
        uint16_t mono_stride = (uint16_t)((width + 7) / 8);

        memset(s_mono_rows, 0, mono_stride * height);
        const uint16_t *src = (const uint16_t *)px_map;
        for (uint16_t y = 0; y < height; y++) {
            uint8_t *dst_row = &s_mono_rows[y * mono_stride];
            const uint16_t *src_row = src + (uint32_t)(y + y1 - area->y1) * src_stride_px + (x1 - area->x1);
            for (uint16_t x = 0; x < width; x++) {
                uint16_t c = src_row[x];
                uint8_t r = (uint8_t)((c >> 11) & 0x1F);
                uint8_t g = (uint8_t)((c >> 5) & 0x3F);
                uint8_t b = (uint8_t)(c & 0x1F);
                if (((uint16_t)r * 299 + (uint16_t)g * 587 + (uint16_t)b * 114) > 30000) {
                    dst_row[x / 8] |= (uint8_t)(0x80U >> (x & 7));
                }
            }
        }

        display_area_t flush_area = {
            .x1 = (uint16_t)x1,
            .y1 = (uint16_t)y1,
            .x2 = (uint16_t)x2,
            .y2 = (uint16_t)y2,
        };
        esp_err_t ret = display_port_flush_mono(&flush_area, s_mono_rows, mono_stride);
        if (ret != ESP_OK) {
            ESP_LOGW(TAG, "OLED flush failed: %s", esp_err_to_name(ret));
        }
    }

    lv_display_flush_ready(disp);
}

static void refresh_ui_from_state(void)
{
    display_ui_state_t copy;
    bool dirty = false;
    int64_t now_us = esp_timer_get_time();

    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        if (s_last_stats_refresh_us == 0 ||
            now_us - s_last_stats_refresh_us >= DISPLAY_STATS_REFRESH_MS * 1000LL) {
            refresh_runtime_stats_locked();
            s_last_stats_refresh_us = now_us;
            mark_dirty_locked();
        }
        if (s_state.overlay_active && s_state.overlay_scroll &&
            (s_last_overlay_scroll_us == 0 ||
             now_us - s_last_overlay_scroll_us >= DISPLAY_OVERLAY_SCROLL_MS * 1000LL)) {
            s_state.overlay_scroll_tick++;
            s_last_overlay_scroll_us = now_us;
            mark_dirty_locked();
        }
        copy = s_state;
        dirty = s_ui_dirty;
        s_ui_dirty = false;
        xSemaphoreGive(s_state_mutex);
    } else {
        return;
    }

    system_menu_get_snapshot(&copy.menu);

    if (!dirty) {
        return;
    }

    display_ui_update(&copy);
}

static void lvgl_tick_cb(void *arg)
{
    (void)arg;
    lv_tick_inc(LVGL_TICK_MS);
}

static void display_lvgl_task(void *arg)
{
    (void)arg;
    while (1) {
        uint32_t wait_ms = LVGL_TASK_MAX_WAIT_MS;

        if (lvgl_lock(pdMS_TO_TICKS(50))) {
            refresh_ui_from_state();
            wait_ms = lv_timer_handler();
            lvgl_unlock();
        }
        if (wait_ms < LVGL_TASK_MIN_WAIT_MS) {
            wait_ms = LVGL_TASK_MIN_WAIT_MS;
        } else if (wait_ms > LVGL_TASK_MAX_WAIT_MS) {
            wait_ms = LVGL_TASK_MAX_WAIT_MS;
        }
        vTaskDelay(pdMS_TO_TICKS(wait_ms));
    }
}

esp_err_t display_lvgl_start(void)
{
    if (s_display != NULL) {
        return ESP_OK;
    }

    s_lvgl_mutex = xSemaphoreCreateMutex();
    s_state_mutex = xSemaphoreCreateMutex();
    if (s_lvgl_mutex == NULL || s_state_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    lv_init();
    system_menu_init();
    init_firmware_label();

    s_display = lv_display_create(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    if (s_display == NULL) {
        return ESP_ERR_NO_MEM;
    }
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(s_display, display_lvgl_flush_cb);
    lv_display_set_buffers(s_display, s_lvgl_draw_buf, NULL, sizeof(s_lvgl_draw_buf),
                           LV_DISPLAY_RENDER_MODE_PARTIAL);

    display_ui_build(lv_screen_active());

    const esp_timer_create_args_t tick_args = {
        .callback = lvgl_tick_cb,
        .name = "lvgl_tick",
    };
    esp_timer_handle_t tick_timer;
    esp_err_t ret = esp_timer_create(&tick_args, &tick_timer);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_timer_start_periodic(tick_timer, LVGL_TICK_MS * 1000);
    if (ret != ESP_OK) {
        return ret;
    }

    if (xTaskCreate(display_lvgl_task, "display_lvgl", LVGL_TASK_STACK_SIZE, NULL,
                    LVGL_TASK_PRIORITY, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "LVGL started: buf=%u bytes, task_stack=%u",
             (unsigned)sizeof(s_lvgl_draw_buf), (unsigned)LVGL_TASK_STACK_SIZE);
    return ESP_OK;
}

void display_lvgl_set_mode(const char *mode)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        state_update_string(s_state.mode, sizeof(s_state.mode), mode);
        if (mode != NULL) {
            if (strcmp(mode, "WIFI") == 0) {
                system_menu_set_comm_mode(SYSTEM_COMM_WIFI);
            } else if (strcmp(mode, "BLE") == 0) {
                system_menu_set_comm_mode(SYSTEM_COMM_BLE);
            } else if (strcmp(mode, "AUTO") == 0) {
                system_menu_set_comm_mode(SYSTEM_COMM_AUTO);
            }
        }
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_status(const char *status)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        state_update_string(s_state.status, sizeof(s_state.status), status);
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_uart_baud(uint32_t baud)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        s_state.baud = baud;
        system_menu_set_uart_baud(baud);
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_wifi_ssid(const char *ssid)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        state_update_string(s_state.ssid, sizeof(s_state.ssid), ssid);
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_wifi_state(system_net_mode_t mode, const char *ap_ip,
                                 const char *sta_ip, bool sta_connecting,
                                 bool sta_connected)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        system_menu_set_net_mode(mode);
        state_update_string(s_state.wifi_ap_ip, sizeof(s_state.wifi_ap_ip),
                            ap_ip != NULL && ap_ip[0] != '\0' ? ap_ip : "192.168.4.1");
        state_update_string(s_state.wifi_sta_ip, sizeof(s_state.wifi_sta_ip),
                            sta_ip != NULL && sta_ip[0] != '\0' ? sta_ip : "-");
        s_state.wifi_sta_connecting = sta_connecting;
        s_state.wifi_sta_connected = sta_connected;
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_ble_ready(int ready)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        s_state.ble_ready = ready ? 1 : 0;
        system_menu_set_ble_ready(ready != 0);
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_text_screen(const char *title, const char *line1,
                                   const char *line2, const char *line3,
                                   const char *line4, const char *footer)
{
    bool use_utf8_scroll = text_has_non_ascii(line1) ||
                            text_has_non_ascii(line2) ||
                            text_has_non_ascii(line3) ||
                            text_has_non_ascii(line4);
    char scroll_text[sizeof(s_state.overlay_text)] = {0};

    if (use_utf8_scroll) {
        append_scroll_line(scroll_text, sizeof(scroll_text), line1);
        append_scroll_line(scroll_text, sizeof(scroll_text), line2);
        append_scroll_line(scroll_text, sizeof(scroll_text), line3);
        append_scroll_line(scroll_text, sizeof(scroll_text), line4);
    }

    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        s_state.overlay_active = true;
        state_update_optional_utf8_string(s_state.overlay_title, sizeof(s_state.overlay_title), title);
        state_update_optional_utf8_string(s_state.overlay_footer, sizeof(s_state.overlay_footer), footer);
        if (use_utf8_scroll) {
            for (uint8_t i = 0; i < 4; i++) {
                s_state.overlay_lines[i][0] = '\0';
            }
            state_update_optional_utf8_string(s_state.overlay_text,
                                              sizeof(s_state.overlay_text),
                                              scroll_text);
            s_state.overlay_scroll = true;
            s_state.overlay_scroll_tick = 0;
            s_last_overlay_scroll_us = esp_timer_get_time();
        } else {
            state_update_optional_string(s_state.overlay_lines[0], sizeof(s_state.overlay_lines[0]), line1);
            state_update_optional_string(s_state.overlay_lines[1], sizeof(s_state.overlay_lines[1]), line2);
            state_update_optional_string(s_state.overlay_lines[2], sizeof(s_state.overlay_lines[2]), line3);
            state_update_optional_string(s_state.overlay_lines[3], sizeof(s_state.overlay_lines[3]), line4);
            s_state.overlay_scroll = false;
            s_state.overlay_scroll_tick = 0;
            s_state.overlay_text[0] = '\0';
        }
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

void display_lvgl_set_text_scroll(const char *title, const char *text, const char *footer)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        s_state.overlay_active = true;
        state_update_optional_string(s_state.overlay_title, sizeof(s_state.overlay_title), title);
        for (uint8_t i = 0; i < 4; i++) {
            s_state.overlay_lines[i][0] = '\0';
        }
        state_update_optional_string(s_state.overlay_footer, sizeof(s_state.overlay_footer), footer);
        state_update_optional_utf8_string(s_state.overlay_text, sizeof(s_state.overlay_text), text);
        s_state.overlay_scroll = true;
        s_state.overlay_scroll_tick = 0;
        s_last_overlay_scroll_us = esp_timer_get_time();
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}

bool display_lvgl_clear_text_screen(void)
{
    bool was_active = false;

    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        was_active = s_state.overlay_active;
        s_state.overlay_active = false;
        s_state.overlay_title[0] = '\0';
        for (uint8_t i = 0; i < 4; i++) {
            s_state.overlay_lines[i][0] = '\0';
        }
        s_state.overlay_footer[0] = '\0';
        s_state.overlay_scroll = false;
        s_state.overlay_scroll_tick = 0;
        s_state.overlay_text[0] = '\0';
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }

    return was_active;
}

void display_lvgl_request_redraw(void)
{
    if (s_state_mutex != NULL && xSemaphoreTake(s_state_mutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        mark_dirty_locked();
        xSemaphoreGive(s_state_mutex);
    }
}
