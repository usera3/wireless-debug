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
static lv_obj_t *s_home_extra_rows[2];
static lv_obj_t *s_footer;

#define UI_W            DISPLAY_WIDTH
#define UI_H            DISPLAY_HEIGHT
#define UI_STATUS_Y     0
#define UI_TITLE_Y      9
#define UI_ROW_Y        18
#define UI_ROW_H        8
#define UI_FOOTER_Y     56
#define UI_MARGIN_X     2
#define HOME_ROW_Y      0
#define HOME_ROW_COUNT  6
#define HOME_ROW_STEP   9
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
    for (uint8_t i = 0; i < HOME_ROW_COUNT - SYSTEM_MENU_ROWS; i++) {
        lv_obj_add_flag(s_home_extra_rows[i], LV_OBJ_FLAG_HIDDEN);
    }
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

static lv_obj_t *home_row(uint8_t index)
{
    return index < SYSTEM_MENU_ROWS
               ? s_rows[index]
               : s_home_extra_rows[index - SYSTEM_MENU_ROWS];
}

static void set_home_layout(void)
{
    for (uint8_t i = 0; i < HOME_ROW_COUNT; i++) {
        lv_obj_t *row = home_row(i);
        lv_obj_remove_flag(row, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_text_font(row, DISPLAY_LVGL_FONT, 0);
        lv_obj_set_height(row, UI_ROW_H);
        lv_obj_set_y(row, HOME_ROW_Y + i * HOME_ROW_STEP);
        set_label_long_mode(row, LV_LABEL_LONG_MODE_CLIP);
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

static bool is_ipv4_label(const char *text)
{
    uint8_t dots = 0;
    uint8_t digits = 0;

    if (text == NULL || text[0] == '\0') {
        return false;
    }
    for (const char *p = text; *p != '\0'; p++) {
        if (*p >= '0' && *p <= '9') {
            digits++;
        } else if (*p == '.') {
            dots++;
        } else {
            return false;
        }
    }
    return dots == 3 && digits >= 4;
}

static const char *wifi_sta_status(const display_ui_state_t *state)
{
    if (state != NULL && state->wifi_sta_connected &&
        is_ipv4_label(state->wifi_sta_ip)) {
        return "OK";
    }
    if (state != NULL && state->wifi_sta_connecting) {
        return "TRY";
    }
    return "OFF";
}

static void clear_status_bar(void)
{
    lv_label_set_text(s_status_left, " ");
    lv_label_set_text(s_status_mid, " ");
    lv_label_set_text(s_status_right, " ");
}

static void update_closed_view(const display_ui_state_t *state)
{
    const system_menu_snapshot_t *menu = &state->menu;
    char baud[12];

    set_home_layout();

    format_baud(baud, sizeof(baud), state->baud);

    lv_label_set_text(s_title, " ");
    for (uint8_t i = 0; i < HOME_ROW_COUNT; i++) {
        lv_label_set_text(home_row(i), " ");
    }
    switch (menu->net_mode) {
    case SYSTEM_NET_AP:
        lv_label_set_text(home_row(0), "WiFi:AP");
        lv_label_set_text(home_row(1), "AP:");
        lv_label_set_text(home_row(2),
                          is_ipv4_label(state->wifi_ap_ip) ? state->wifi_ap_ip : "192.168.4.1");
        lv_label_set_text_fmt(home_row(3), "UART:%s", baud);
        lv_label_set_text_fmt(home_row(4), "BLE:%s",
                              (menu->ble_ready || state->ble_ready) ? "ON" : "OFF");
        break;
    case SYSTEM_NET_STA:
        lv_label_set_text_fmt(home_row(0), "WiFi:STA %s", wifi_sta_status(state));
        lv_label_set_text(home_row(1), "STA:");
        lv_label_set_text(home_row(2),
                          is_ipv4_label(state->wifi_sta_ip) ? state->wifi_sta_ip : "-");
        lv_label_set_text_fmt(home_row(3), "UART:%s", baud);
        lv_label_set_text_fmt(home_row(4), "BLE:%s",
                              (menu->ble_ready || state->ble_ready) ? "ON" : "OFF");
        break;
    case SYSTEM_NET_APSTA:
    default:
        lv_label_set_text_fmt(home_row(0), "WiFi:APSTA %s", wifi_sta_status(state));
        lv_label_set_text(home_row(1), "AP:");
        lv_label_set_text(home_row(2),
                          is_ipv4_label(state->wifi_ap_ip) ? state->wifi_ap_ip : "192.168.4.1");
        lv_label_set_text(home_row(3), "STA:");
        lv_label_set_text(home_row(4),
                          is_ipv4_label(state->wifi_sta_ip) ? state->wifi_sta_ip : "-");
        lv_label_set_text_fmt(home_row(5), "U:%s BLE:%s", baud,
                              (menu->ble_ready || state->ble_ready) ? "ON" : "OFF");
        break;
    }
    for (uint8_t i = 0; i < HOME_ROW_COUNT; i++) {
        set_row_selected(home_row(i), false);
    }
    lv_label_set_text(s_footer, "S5 MENU");
}

static void update_menu_view(const display_ui_state_t *state)
{
    const system_menu_snapshot_t *menu = &state->menu;

    set_standard_layout();

    set_label_long_mode(s_title, LV_LABEL_LONG_MODE_CLIP);
    set_label_long_mode(s_footer, LV_LABEL_LONG_MODE_CLIP);
    lv_label_set_text(s_title, menu->title[0] ? menu->title : " ");

    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        bool selected = menu->rows[i][0] == '>';
        set_label_long_mode(s_rows[i], LV_LABEL_LONG_MODE_CLIP);
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

    for (uint8_t i = 0; i < HOME_ROW_COUNT - SYSTEM_MENU_ROWS; i++) {
        lv_obj_add_flag(s_home_extra_rows[i], LV_OBJ_FLAG_HIDDEN);
    }

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

    set_standard_layout();

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

    s_status_left = make_label(s_root, UI_MARGIN_X, UI_STATUS_Y, 42, 8, " ");
    s_status_mid = make_label(s_root, 43, UI_STATUS_Y, 42, 8, " ");
    lv_obj_set_style_text_align(s_status_mid, LV_TEXT_ALIGN_CENTER, 0);
    s_status_right = make_label(s_root, 86, UI_STATUS_Y, 40, 8, " ");
    lv_obj_set_style_text_align(s_status_right, LV_TEXT_ALIGN_RIGHT, 0);

    s_title = make_label(s_root, UI_MARGIN_X, UI_TITLE_Y, 124, 8, "v?");
    lv_obj_set_style_text_align(s_title, LV_TEXT_ALIGN_CENTER, 0);

    for (uint8_t i = 0; i < SYSTEM_MENU_ROWS; i++) {
        s_rows[i] = make_label(s_root, UI_MARGIN_X, UI_ROW_Y + i * UI_ROW_H,
                               124, UI_ROW_H, " ");
    }
    for (uint8_t i = 0; i < HOME_ROW_COUNT - SYSTEM_MENU_ROWS; i++) {
        s_home_extra_rows[i] = make_label(s_root, UI_MARGIN_X, 0, 124, UI_ROW_H, " ");
        lv_obj_add_flag(s_home_extra_rows[i], LV_OBJ_FLAG_HIDDEN);
    }

    s_footer = make_label(s_root, UI_MARGIN_X, UI_FOOTER_Y, 124, 8, "OK E0 U0m");
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
}

void display_ui_update(const display_ui_state_t *state)
{
    if (state == NULL || s_root == NULL) {
        return;
    }

    clear_status_bar();
    if (state->overlay_active) {
        update_overlay_view(state);
    } else if (state->menu.active) {
        update_menu_view(state);
    } else {
        update_closed_view(state);
    }
}
