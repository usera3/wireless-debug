#include "display_ui.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

LV_FONT_DECLARE(display_font_fusion_12_zh)

static lv_obj_t *s_root;
static lv_obj_t *s_status_left;
static lv_obj_t *s_status_mid;
static lv_obj_t *s_status_right;
static lv_obj_t *s_title;
static lv_obj_t *s_rows[SYSTEM_MENU_ROWS];
static lv_obj_t *s_footer;

#define UI_W            DISPLAY_WIDTH
#define UI_H            DISPLAY_HEIGHT
#define UI_STATUS_Y     0
#define UI_TITLE_Y      9
#define UI_ROW_Y        18
#define UI_ROW_H        8
#define UI_FOOTER_Y     56
#define UI_MARGIN_X     2
#define OVERLAY_CJK_COL_UNITS 20
#define OVERLAY_CJK_ROW_H 12
#define OVERLAY_ROW_BYTES 80
#define OVERLAY_MAX_ROWS  64
#define OVERLAY_VISIBLE_ROWS 3

#if LV_FONT_UNSCII_8
#define DISPLAY_LVGL_FONT (&lv_font_unscii_8)
#else
#define DISPLAY_LVGL_FONT LV_FONT_DEFAULT
#endif

#define DISPLAY_OVERLAY_FONT (&display_font_fusion_12_zh)

static bool s_overlay_text_layout;
static char s_overlay_rows[OVERLAY_MAX_ROWS][OVERLAY_ROW_BYTES];

static void make_plain_box(lv_obj_t *obj)
{
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_shadow_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
}

static void set_label_style(lv_obj_t *obj)
{
    lv_obj_set_style_text_font(obj, DISPLAY_LVGL_FONT, 0);
    lv_obj_set_style_text_color(obj, lv_color_white(), 0);
    lv_obj_set_style_text_letter_space(obj, 0, 0);
    lv_obj_set_style_text_line_space(obj, 0, 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_label_set_long_mode(obj, LV_LABEL_LONG_MODE_CLIP);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
}

static void set_label_long_mode(lv_obj_t *obj, lv_label_long_mode_t mode)
{
    if (obj != NULL) {
        lv_label_set_long_mode(obj, mode);
    }
}

static void set_standard_layout(void)
{
    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        lv_obj_set_style_text_font(s_rows[i], DISPLAY_LVGL_FONT, 0);
        lv_obj_set_height(s_rows[i], UI_ROW_H);
        lv_obj_set_y(s_rows[i], UI_ROW_Y + i * UI_ROW_H);
        set_label_long_mode(s_rows[i], LV_LABEL_LONG_MODE_CLIP);
    }
    set_label_long_mode(s_title, LV_LABEL_LONG_MODE_CLIP);
    set_label_long_mode(s_footer, LV_LABEL_LONG_MODE_CLIP);
    s_overlay_text_layout = false;
}

static lv_obj_t *make_label(lv_obj_t *parent, int32_t x, int32_t y,
                            int32_t w, int32_t h, const char *text)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_size(label, w, h);
    set_label_style(label);
    lv_label_set_text(label, text);
    return label;
}

static size_t utf8_char_len(const char *s)
{
    unsigned char c;

    if (s == NULL || *s == '\0') {
        return 0;
    }

    c = (unsigned char)s[0];
    if (c < 0x80U) {
        return 1;
    }
    if ((c & 0xE0U) == 0xC0U &&
        (s[1] & 0xC0U) == 0x80U) {
        return 2;
    }
    if ((c & 0xF0U) == 0xE0U &&
        (s[1] & 0xC0U) == 0x80U &&
        (s[2] & 0xC0U) == 0x80U) {
        return 3;
    }
    if ((c & 0xF8U) == 0xF0U &&
        (s[1] & 0xC0U) == 0x80U &&
        (s[2] & 0xC0U) == 0x80U &&
        (s[3] & 0xC0U) == 0x80U) {
        return 4;
    }
    return 1;
}

static uint8_t utf8_col_units(const char *s)
{
    unsigned char c = (unsigned char)s[0];
    return c < 0x80U ? 1 : 2;
}

static bool utf8_is_ascii_space(const char *s)
{
    return s != NULL && (*s == ' ' || *s == '\t' || *s == '\r');
}

static void set_row_selected(lv_obj_t *row, bool selected)
{
    if (selected) {
        lv_obj_set_style_bg_color(row, lv_color_white(), 0);
        lv_obj_set_style_bg_opa(row, LV_OPA_COVER, 0);
        lv_obj_set_style_text_color(row, lv_color_black(), 0);
    } else {
        lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
        lv_obj_set_style_text_color(row, lv_color_white(), 0);
    }
}

static const char *comm_short(system_comm_mode_t mode)
{
    switch (mode) {
    case SYSTEM_COMM_WIFI:
        return "W";
    case SYSTEM_COMM_BLE:
        return "B";
    case SYSTEM_COMM_AUTO:
    default:
        return "A";
    }
}

static const char *status_compact(const char *status)
{
    if (status == NULL || status[0] == '\0') {
        return "-";
    }
    if (strcmp(status, "lvgl_on") == 0 ||
        strcmp(status, "auto") == 0 ||
        strcmp(status, "baud_ok") == 0) {
        return "OK";
    }
    if (strcmp(status, "mode_wifi_auto") == 0 ||
        strcmp(status, "menu_wifi") == 0) {
        return "WIFI";
    }
    if (strcmp(status, "mode_ble_auto") == 0 ||
        strcmp(status, "menu_ble") == 0) {
        return "BLE";
    }
    if (strcmp(status, "menu_auto") == 0) {
        return "AUTO";
    }
    if (strcmp(status, "ap_on") == 0) {
        return "AP";
    }
    if (strcmp(status, "ap_switch") == 0 ||
        strcmp(status, "menu_ap") == 0) {
        return "AP...";
    }
    if (strcmp(status, "sta_on") == 0) {
        return "STA";
    }
    if (strcmp(status, "sta_switch") == 0 ||
        strcmp(status, "menu_sta") == 0) {
        return "STA...";
    }
    if (strcmp(status, "ws_rx") == 0) {
        return "WS RX";
    }
    if (strcmp(status, "ble_rx") == 0) {
        return "BLE RX";
    }
    if (strcmp(status, "ble_on") == 0) {
        return "BLE";
    }
    if (strcmp(status, "sta_conn") == 0) {
        return "STA...";
    }
    if (strcmp(status, "sta_cfg") == 0 ||
        strcmp(status, "sta_clear") == 0 ||
        strcmp(status, "sta_need_cfg") == 0 ||
        strcmp(status, "menu_sta_clear") == 0 ||
        strcmp(status, "menu_sta_pending") == 0) {
        return "CFG";
    }
    if (strcmp(status, "ble_start") == 0) {
        return "BLE...";
    }
    if (strcmp(status, "heap_info") == 0) {
        return "HEAP";
    }
    if (strcmp(status, "sta_lost") == 0 ||
        strcmp(status, "sta_fail") == 0 ||
        strcmp(status, "ble_fail") == 0) {
        return "WARN";
    }
    return status;
}

static uint64_t total_error_count(const comm_stats_snapshot_t *s)
{
    return s->uart_tx_failures +
           s->uart_overflows +
           s->ble_notify_failures +
           s->ble_no_subscriber_drops +
           s->ble_alloc_failures +
           s->wifi_tx_failures +
           s->wifi_no_client_drops +
           s->wifi_pool_exhausted +
           s->wifi_queue_full +
           s->wifi_httpd_queue_failures +
           s->wifi_rx_failures +
           s->route_idle_drops +
           s->route_unavailable_drops +
           s->route_partial_drops;
}

static unsigned long count_k(uint64_t value)
{
    return (unsigned long)(value / 1000ULL);
}

static void format_count(char *out, size_t out_size, uint64_t value)
{
    if (out == NULL || out_size == 0) {
        return;
    }
    if (value >= 1000000000ULL) {
        snprintf(out, out_size, "1G+");
    } else if (value >= 1000000ULL) {
        snprintf(out, out_size, "%luM", (unsigned long)(value / 1000000ULL));
    } else if (value >= 10000ULL) {
        snprintf(out, out_size, "%luK", count_k(value));
    } else {
        snprintf(out, out_size, "%lu", (unsigned long)value);
    }
}

static void format_baud(char *out, size_t out_size, uint32_t baud)
{
    if (out == NULL || out_size == 0) {
        return;
    }
    if (baud >= 1000000U && baud % 1000000U == 0) {
        snprintf(out, out_size, "%luM", (unsigned long)(baud / 1000000U));
    } else if (baud >= 1000000U) {
        snprintf(out, out_size, "%lu.%luM",
                 (unsigned long)(baud / 1000000U),
                 (unsigned long)((baud % 1000000U) / 100000U));
    } else if (baud >= 1000U) {
        snprintf(out, out_size, "%luK", (unsigned long)(baud / 1000U));
    } else {
        snprintf(out, out_size, "%lu", (unsigned long)baud);
    }
}

static void format_wifi_label(char *out, size_t out_size, const char *ssid)
{
    const char *label = ssid;

    if (out == NULL || out_size == 0) {
        return;
    }

    if (label == NULL || label[0] == '\0' || strcmp(label, "-") == 0) {
        snprintf(out, out_size, "-");
        return;
    }

    if (strncmp(label, "ESP32-S3_AP_", 12) == 0) {
        snprintf(out, out_size, "AP%.4s", label + 12);
    } else if (strncmp(label, "ESP32-S3_", 9) == 0) {
        snprintf(out, out_size, "%.6s", label + 9);
    } else {
        snprintf(out, out_size, "%.6s", label);
    }
}

static void update_status_bar(const display_ui_state_t *state)
{
    char left[16];
    char mid[16];
    char right[16];
    const system_menu_snapshot_t *menu = &state->menu;

    snprintf(left, sizeof(left), "NET:%s", system_menu_net_name(menu->net_mode));
    snprintf(mid, sizeof(mid), "COM:%s", comm_short(menu->comm_mode));
    snprintf(right, sizeof(right), "BLE:%s",
             (menu->ble_ready || state->ble_ready) ? "ON" : "--");

    lv_label_set_text(s_status_left, left);
    lv_label_set_text(s_status_mid, mid);
    lv_label_set_text(s_status_right, right);
}

static void update_closed_view(const display_ui_state_t *state)
{
    const system_menu_snapshot_t *menu = &state->menu;
    const comm_stats_snapshot_t *stats = &state->stats;
    char baud[8];
    char wifi[8];
    char uart_rx[8];
    char uart_tx[8];
    char ble_rx[8];
    char ble_tx[8];
    char wifi_rx[8];
    char wifi_tx[8];
    uint64_t errors = total_error_count(stats);
    uint32_t minutes = state->uptime_s / 60U;

    set_standard_layout();

    format_baud(baud, sizeof(baud), state->baud);
    format_wifi_label(wifi, sizeof(wifi), state->ssid);
    format_count(uart_rx, sizeof(uart_rx), stats->uart_rx_frames);
    format_count(uart_tx, sizeof(uart_tx), stats->uart_tx_bytes);
    format_count(ble_rx, sizeof(ble_rx), stats->ble_rx_frames);
    format_count(ble_tx, sizeof(ble_tx), stats->ble_tx_bytes);
    format_count(wifi_rx, sizeof(wifi_rx), stats->wifi_rx_frames);
    format_count(wifi_tx, sizeof(wifi_tx), stats->wifi_tx_sent_bytes);

    lv_label_set_text(s_title, state->firmware[0] ? state->firmware : "v?");
    lv_label_set_text_fmt(s_rows[0], "U%s %s/%s",
                          baud, uart_rx, uart_tx);
    lv_label_set_text_fmt(s_rows[1], "B%s %s/%s",
                          (menu->ble_ready || state->ble_ready) ? "ON" : "--",
                          ble_rx, ble_tx);
    lv_label_set_text_fmt(s_rows[2], "W%s %s/%s",
                          wifi, wifi_rx, wifi_tx);
    lv_label_set_text_fmt(s_rows[3], "H %lu/%luK",
                          (unsigned long)state->heap_internal_kb,
                          (unsigned long)state->heap_min_internal_kb);
    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        set_row_selected(s_rows[i], false);
    }
    lv_label_set_text_fmt(s_footer, "%s E%lu U%lum",
                          status_compact(state->status),
                          (unsigned long)errors,
                          (unsigned long)minutes);
}

static void update_menu_view(const display_ui_state_t *state)
{
    const system_menu_snapshot_t *menu = &state->menu;

    if (s_overlay_text_layout) {
        set_standard_layout();
    }

    set_label_long_mode(s_title, LV_LABEL_LONG_MODE_SCROLL_CIRCULAR);
    set_label_long_mode(s_footer, LV_LABEL_LONG_MODE_SCROLL_CIRCULAR);
    lv_label_set_text(s_title, menu->title[0] ? menu->title : "MENU");

    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        bool selected = menu->rows[i][0] == '>';
        set_label_long_mode(s_rows[i], LV_LABEL_LONG_MODE_SCROLL_CIRCULAR);
        lv_label_set_text(s_rows[i], menu->rows[i][0] ? menu->rows[i] : " ");
        set_row_selected(s_rows[i], selected);
    }

    lv_label_set_text(s_footer, menu->footer[0] ? menu->footer : "S4 NEXT S5 OK");
}

static void update_overlay_view(const display_ui_state_t *state)
{
    size_t row_count = 0;
    size_t page_count = 1;
    size_t page = 0;

    lv_label_set_text(s_title, state->overlay_title[0] ? state->overlay_title : "TEXT");

    if (state->overlay_scroll && state->overlay_text[0] != '\0') {
        const char *text = state->overlay_text;

        if (!s_overlay_text_layout) {
            for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
                lv_obj_set_style_text_font(s_rows[i], DISPLAY_OVERLAY_FONT, 0);
                lv_obj_set_height(s_rows[i], OVERLAY_CJK_ROW_H);
                lv_obj_set_y(s_rows[i], UI_ROW_Y + i * OVERLAY_CJK_ROW_H);
            }
            s_overlay_text_layout = true;
        }

        while (*text != '\0' && row_count < OVERLAY_MAX_ROWS) {
            char line[OVERLAY_ROW_BYTES];
            size_t len = 0;
            size_t col_units = 0;
            size_t last_space = 0;
            const char *last_space_next = NULL;
            bool has_space = false;
            const char *p;

            while (utf8_is_ascii_space(text)) {
                text++;
            }
            if (*text == '\n') {
                text++;
                s_overlay_rows[row_count][0] = ' ';
                s_overlay_rows[row_count][1] = '\0';
                row_count++;
                continue;
            }

            p = text;
            while (*p != '\0' && *p != '\n') {
                size_t char_len;
                uint8_t char_cols;

                if (*p == '\r') {
                    p++;
                    continue;
                }
                char_len = utf8_char_len(p);
                char_cols = utf8_col_units(p);
                if (col_units + char_cols > OVERLAY_CJK_COL_UNITS ||
                    len + char_len >= sizeof(line)) {
                    break;
                }

                if (*p == '\t') {
                    line[len++] = ' ';
                    col_units++;
                    p++;
                } else if ((unsigned char)*p < 32U) {
                    p += char_len;
                    continue;
                } else {
                    memcpy(&line[len], p, char_len);
                    len += char_len;
                    col_units += char_cols;
                    p += char_len;
                }

                if (line[len - 1] == ' ') {
                    last_space = len;
                    last_space_next = p;
                    has_space = true;
                }
            }

            if (len == 0 && *p == '\n') {
                text = p + 1;
                s_overlay_rows[row_count][0] = ' ';
                s_overlay_rows[row_count][1] = '\0';
                row_count++;
                continue;
            }

            if (*p != '\0' && *p != '\n' && has_space && last_space > 0) {
                len = last_space > 0 ? last_space - 1 : 0;
                p = last_space_next != NULL ? last_space_next : p;
                while (utf8_is_ascii_space(p)) {
                    p++;
                }
            }

            while (len > 0 && line[len - 1] == ' ') {
                len--;
            }
            if (len == 0) {
                line[0] = ' ';
                len = 1;
            }
            line[len] = '\0';
            snprintf(s_overlay_rows[row_count], sizeof(s_overlay_rows[row_count]), "%s", line);
            row_count++;

            text = p;
            if (*text == '\n') {
                text++;
            }
        }

        if (row_count == 0) {
            snprintf(s_overlay_rows[row_count], sizeof(s_overlay_rows[row_count]), " ");
            row_count++;
        }

        page_count = (row_count + OVERLAY_VISIBLE_ROWS - 1U) / OVERLAY_VISIBLE_ROWS;
        if (page_count == 0) {
            page_count = 1;
        }
        page = state->overlay_scroll_tick % page_count;

        lv_label_set_text_fmt(s_title, "%.8s %lu/%lu",
                              state->overlay_title[0] ? state->overlay_title : "TEXT",
                              (unsigned long)(page + 1U),
                              (unsigned long)page_count);
        for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
            size_t row = page * OVERLAY_VISIBLE_ROWS + i;
            lv_label_set_text(s_rows[i], (i < OVERLAY_VISIBLE_ROWS && row < row_count) ? s_overlay_rows[row] : " ");
            set_row_selected(s_rows[i], false);
        }

        lv_label_set_text(s_footer, " ");
        return;
    }

    if (s_overlay_text_layout) {
        for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
            lv_obj_set_style_text_font(s_rows[i], DISPLAY_LVGL_FONT, 0);
            lv_obj_set_height(s_rows[i], UI_ROW_H);
            lv_obj_set_y(s_rows[i], UI_ROW_Y + i * UI_ROW_H);
        }
        s_overlay_text_layout = false;
    }

    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        lv_label_set_text(s_rows[i], state->overlay_lines[i][0] ? state->overlay_lines[i] : " ");
        set_row_selected(s_rows[i], false);
    }
    lv_label_set_text(s_footer, state->overlay_footer[0] ? state->overlay_footer : "OK E0");
}

void display_ui_build(lv_obj_t *screen)
{
    lv_obj_set_style_bg_color(screen, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_style_text_font(screen, DISPLAY_LVGL_FONT, 0);

    s_root = lv_obj_create(screen);
    lv_obj_set_pos(s_root, 0, 0);
    lv_obj_set_size(s_root, UI_W, UI_H);
    make_plain_box(s_root);

    s_status_left = make_label(s_root, UI_MARGIN_X, UI_STATUS_Y, 42, 8, "NET:AP");
    s_status_mid = make_label(s_root, 43, UI_STATUS_Y, 42, 8, "COM:A");
    lv_obj_set_style_text_align(s_status_mid, LV_TEXT_ALIGN_CENTER, 0);
    s_status_right = make_label(s_root, 86, UI_STATUS_Y, 40, 8, "BLE:--");
    lv_obj_set_style_text_align(s_status_right, LV_TEXT_ALIGN_RIGHT, 0);

    s_title = make_label(s_root, UI_MARGIN_X, UI_TITLE_Y, 124, 8, "v?");
    lv_obj_set_style_text_align(s_title, LV_TEXT_ALIGN_CENTER, 0);

    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        s_rows[i] = make_label(s_root, UI_MARGIN_X, UI_ROW_Y + i * UI_ROW_H,
                               124, UI_ROW_H, " ");
    }

    s_footer = make_label(s_root, UI_MARGIN_X, UI_FOOTER_Y, 124, 8, "OK E0 U0m");
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
}

void display_ui_update(const display_ui_state_t *state)
{
    if (state == NULL || s_root == NULL) {
        return;
    }

    update_status_bar(state);
    if (state->overlay_active) {
        update_overlay_view(state);
    } else if (state->menu.active) {
        update_menu_view(state);
    } else {
        update_closed_view(state);
    }
}
