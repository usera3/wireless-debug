#include "system_menu.h"

#include <stdio.h>
#include <string.h>
#include "esp_timer.h"

#if !defined(SYSTEM_MENU_NO_FREERTOS)
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#endif

#define MENU_FEEDBACK_MS 1400

typedef enum {
    MENU_PAGE_ROOT,
    MENU_PAGE_NETWORK,
    MENU_PAGE_COMM,
    MENU_PAGE_UART,
    MENU_PAGE_BLE,
    MENU_PAGE_DISPLAY,
    MENU_PAGE_SYSTEM,
    MENU_PAGE_COUNT,
} menu_page_t;

typedef enum {
    ROOT_ITEM_NETWORK,
    ROOT_ITEM_COMM,
    ROOT_ITEM_UART,
    ROOT_ITEM_BLE,
    ROOT_ITEM_DISPLAY,
    ROOT_ITEM_SYSTEM,
    ROOT_ITEM_COUNT,
} root_item_t;

static const uint32_t s_uart_baud_choices[] = {
    115200,
    921600,
    2000000,
    3000000,
};

typedef struct {
    bool active;
    menu_page_t page;
    uint8_t selected[MENU_PAGE_COUNT];
    uint32_t event_count;
    system_net_mode_t net_mode;
    system_comm_mode_t comm_mode;
    uint32_t uart_baud;
    bool ble_ready;
    char message[SYSTEM_MENU_TEXT_LEN];
    bool feedback_active;
    int64_t feedback_until_us;
    char feedback_title[SYSTEM_MENU_TEXT_LEN];
    char feedback_status[SYSTEM_MENU_TEXT_LEN];
    char feedback_detail[SYSTEM_MENU_TEXT_LEN];
} system_menu_state_t;

static system_menu_state_t s_menu = {
    .active = false,
    .page = MENU_PAGE_ROOT,
    .event_count = 0,
    .net_mode = SYSTEM_NET_AP,
    .comm_mode = SYSTEM_COMM_AUTO,
    .uart_baud = 2000000,
    .ble_ready = false,
    .message = "READY",
};

#if !defined(SYSTEM_MENU_NO_FREERTOS)
static SemaphoreHandle_t s_menu_mutex;
#endif

static uint8_t baud_choice_count(void)
{
    return (uint8_t)(sizeof(s_uart_baud_choices) / sizeof(s_uart_baud_choices[0]));
}

uint8_t system_menu_uart_baud_choice_count(void)
{
    return baud_choice_count();
}

uint32_t system_menu_uart_baud_choice(uint8_t index)
{
    if (index >= baud_choice_count()) {
        return s_uart_baud_choices[0];
    }
    return s_uart_baud_choices[index];
}

static void menu_lock(void)
{
#if !defined(SYSTEM_MENU_NO_FREERTOS)
    if (s_menu_mutex != NULL) {
        xSemaphoreTake(s_menu_mutex, portMAX_DELAY);
    }
#endif
}

static void menu_unlock(void)
{
#if !defined(SYSTEM_MENU_NO_FREERTOS)
    if (s_menu_mutex != NULL) {
        xSemaphoreGive(s_menu_mutex);
    }
#endif
}

static void set_message_locked(const char *message)
{
    if (message == NULL || message[0] == '\0') {
        message = "-";
    }
    snprintf(s_menu.message, sizeof(s_menu.message), "%s", message);
}

static void make_baud(char *dst, size_t dst_size, uint32_t baud)
{
    if (baud >= 1000000U && baud % 1000000U == 0) {
        snprintf(dst, dst_size, "%luM", (unsigned long)(baud / 1000000U));
        return;
    }
    if (baud >= 1000U && baud % 1000U == 0) {
        snprintf(dst, dst_size, "%luK", (unsigned long)(baud / 1000U));
        return;
    }
    snprintf(dst, dst_size, "%lu", (unsigned long)baud);
}

static uint8_t item_count_for_page(menu_page_t page)
{
    switch (page) {
    case MENU_PAGE_NETWORK:
        return 3;
    case MENU_PAGE_COMM:
        return 3;
    case MENU_PAGE_UART:
        return baud_choice_count();
    case MENU_PAGE_BLE:
        return 2;
    case MENU_PAGE_DISPLAY:
        return 1;
    case MENU_PAGE_SYSTEM:
        return 2;
    case MENU_PAGE_ROOT:
    default:
        return ROOT_ITEM_COUNT;
    }
}

static menu_page_t root_item_page(uint8_t selected)
{
    switch (selected) {
    case ROOT_ITEM_NETWORK:
        return MENU_PAGE_NETWORK;
    case ROOT_ITEM_COMM:
        return MENU_PAGE_COMM;
    case ROOT_ITEM_UART:
        return MENU_PAGE_UART;
    case ROOT_ITEM_BLE:
        return MENU_PAGE_BLE;
    case ROOT_ITEM_DISPLAY:
        return MENU_PAGE_DISPLAY;
    case ROOT_ITEM_SYSTEM:
        return MENU_PAGE_SYSTEM;
    default:
        return MENU_PAGE_ROOT;
    }
}

static void close_feedback_locked(void)
{
    s_menu.feedback_active = false;
    s_menu.feedback_until_us = 0;
    s_menu.feedback_title[0] = '\0';
    s_menu.feedback_status[0] = '\0';
    s_menu.feedback_detail[0] = '\0';
}

static void expire_feedback_locked(void)
{
    if (s_menu.feedback_active && s_menu.feedback_until_us > 0 &&
        esp_timer_get_time() >= s_menu.feedback_until_us) {
        close_feedback_locked();
    }
}

static uint8_t scroll_top_for(uint8_t selected, uint8_t item_count)
{
    if (item_count <= SYSTEM_MENU_ROWS || selected < SYSTEM_MENU_ROWS) {
        return 0;
    }
    return (uint8_t)(selected - (SYSTEM_MENU_ROWS - 1U));
}

static void make_row(char *dst, size_t dst_size, bool selected,
                     const char *label, const char *value)
{
    snprintf(dst, dst_size, "%c%-12s %s",
             selected ? '>' : ' ',
             label == NULL ? "" : label,
             value == NULL ? "" : value);
}

static void root_item_label(uint8_t index, char *label, size_t label_size,
                            char *value, size_t value_size)
{
    char baud[12];
    if (label == NULL || value == NULL || label_size == 0 || value_size == 0) {
        return;
    }

    label[0] = '\0';
    value[0] = '\0';

    switch (index) {
    case ROOT_ITEM_NETWORK:
        snprintf(label, label_size, "Network");
        snprintf(value, value_size, "%s", system_menu_net_name(s_menu.net_mode));
        break;
    case ROOT_ITEM_COMM:
        snprintf(label, label_size, "Comm");
        snprintf(value, value_size, "%s", system_menu_comm_name(s_menu.comm_mode));
        break;
    case ROOT_ITEM_UART:
        make_baud(baud, sizeof(baud), s_menu.uart_baud);
        snprintf(label, label_size, "UART");
        snprintf(value, value_size, "%s", baud);
        break;
    case ROOT_ITEM_BLE:
        snprintf(label, label_size, "BLE");
        snprintf(value, value_size, "%s", s_menu.ble_ready ? "READY" : "--");
        break;
    case ROOT_ITEM_DISPLAY:
        snprintf(label, label_size, "Display");
        snprintf(value, value_size, "Info");
        break;
    case ROOT_ITEM_SYSTEM:
        snprintf(label, label_size, "System");
        snprintf(value, value_size, "Health");
        break;
    default:
        snprintf(label, label_size, "-");
        break;
    }
}

static void page_item_label(menu_page_t page, uint8_t index,
                            char *label, size_t label_size,
                            char *value, size_t value_size)
{
    char baud[12];
    if (label == NULL || value == NULL || label_size == 0 || value_size == 0) {
        return;
    }

    label[0] = '\0';
    value[0] = '\0';

    switch (page) {
    case MENU_PAGE_NETWORK:
        if (index == 0) {
            snprintf(label, label_size, "AP Mode");
            snprintf(value, value_size, "%s", s_menu.net_mode == SYSTEM_NET_AP ? "ON" : "");
        } else if (index == 1) {
            snprintf(label, label_size, "STA Mode");
            snprintf(value, value_size, "%s", s_menu.net_mode == SYSTEM_NET_STA ? "ON" : "");
        } else {
            snprintf(label, label_size, "Clear STA");
        }
        break;
    case MENU_PAGE_COMM:
        if (index == 0) {
            snprintf(label, label_size, "Auto");
            snprintf(value, value_size, "%s", s_menu.comm_mode == SYSTEM_COMM_AUTO ? "ON" : "");
        } else if (index == 1) {
            snprintf(label, label_size, "WiFi");
            snprintf(value, value_size, "%s", s_menu.comm_mode == SYSTEM_COMM_WIFI ? "ON" : "");
        } else {
            snprintf(label, label_size, "BLE");
            snprintf(value, value_size, "%s", s_menu.comm_mode == SYSTEM_COMM_BLE ? "ON" : "");
        }
        break;
    case MENU_PAGE_UART:
        make_baud(baud, sizeof(baud), system_menu_uart_baud_choice(index));
        snprintf(label, label_size, "%s", baud);
        snprintf(value, value_size, "%s",
                 system_menu_uart_baud_choice(index) == s_menu.uart_baud ? "ON" : "");
        break;
    case MENU_PAGE_BLE:
        if (index == 0) {
            snprintf(label, label_size, "Status");
            snprintf(value, value_size, "%s", s_menu.ble_ready ? "READY" : "--");
        } else {
            snprintf(label, label_size, "Start");
        }
        break;
    case MENU_PAGE_DISPLAY:
        snprintf(label, label_size, "OLED Info");
        break;
    case MENU_PAGE_SYSTEM:
        if (index == 0) {
            snprintf(label, label_size, "Health");
        } else {
            snprintf(label, label_size, "Clear Stats");
        }
        break;
    case MENU_PAGE_ROOT:
    default:
        root_item_label(index, label, label_size, value, value_size);
        break;
    }
}

static const char *page_title(menu_page_t page)
{
    switch (page) {
    case MENU_PAGE_NETWORK:
        return "NETWORK";
    case MENU_PAGE_COMM:
        return "COMM MODE";
    case MENU_PAGE_UART:
        return "UART BAUD";
    case MENU_PAGE_BLE:
        return "BLE";
    case MENU_PAGE_DISPLAY:
        return "DISPLAY";
    case MENU_PAGE_SYSTEM:
        return "SYSTEM";
    case MENU_PAGE_ROOT:
    default:
        return "MENU";
    }
}

static const char *page_path(menu_page_t page)
{
    switch (page) {
    case MENU_PAGE_NETWORK:
        return "MENU/NET";
    case MENU_PAGE_COMM:
        return "MENU/COMM";
    case MENU_PAGE_UART:
        return "MENU/UART";
    case MENU_PAGE_BLE:
        return "MENU/BLE";
    case MENU_PAGE_DISPLAY:
        return "MENU/DISP";
    case MENU_PAGE_SYSTEM:
        return "MENU/SYS";
    case MENU_PAGE_ROOT:
    default:
        return "MENU";
    }
}

static system_menu_action_t action_for_selected_locked(void)
{
    uint8_t selected = s_menu.selected[s_menu.page];

    switch (s_menu.page) {
    case MENU_PAGE_NETWORK:
        if (selected == 0) return SYSTEM_ACTION_NET_AP;
        if (selected == 1) return SYSTEM_ACTION_NET_STA;
        return SYSTEM_ACTION_NET_STA_CLEAR;
    case MENU_PAGE_COMM:
        if (selected == 0) return SYSTEM_ACTION_COMM_AUTO;
        if (selected == 1) return SYSTEM_ACTION_COMM_WIFI;
        return SYSTEM_ACTION_COMM_BLE;
    case MENU_PAGE_UART:
        if (selected == 0) return SYSTEM_ACTION_UART_BAUD_115200;
        if (selected == 1) return SYSTEM_ACTION_UART_BAUD_921600;
        if (selected == 2) return SYSTEM_ACTION_UART_BAUD_2000000;
        return SYSTEM_ACTION_UART_BAUD_3000000;
    case MENU_PAGE_BLE:
        return selected == 1 ? SYSTEM_ACTION_BLE_START : SYSTEM_ACTION_NONE;
    case MENU_PAGE_DISPLAY:
        return SYSTEM_ACTION_DISPLAY_INFO;
    case MENU_PAGE_SYSTEM:
        return selected == 0 ? SYSTEM_ACTION_HEAP_INFO : SYSTEM_ACTION_STATS_RESET;
    case MENU_PAGE_ROOT:
    default:
        return SYSTEM_ACTION_NONE;
    }
}

void system_menu_init(void)
{
#if !defined(SYSTEM_MENU_NO_FREERTOS)
    if (s_menu_mutex == NULL) {
        s_menu_mutex = xSemaphoreCreateMutex();
    }
#endif
}

bool system_menu_key_from_name(const char *name, system_key_t *out)
{
    if (name == NULL || out == NULL) {
        return false;
    }

    if (strcmp(name, "next") == 0 || strcmp(name, "cycle") == 0 ||
        strcmp(name, "up") == 0 || strcmp(name, "down") == 0 ||
        strcmp(name, "left") == 0 || strcmp(name, "right") == 0 ||
        strcmp(name, "s4") == 0) {
        *out = SYSTEM_KEY_NEXT;
    } else if (strcmp(name, "ok") == 0 || strcmp(name, "enter") == 0 ||
               strcmp(name, "s5") == 0 || strcmp(name, "short") == 0) {
        *out = SYSTEM_KEY_OK;
    } else if (strcmp(name, "back") == 0 || strcmp(name, "esc") == 0 ||
               strcmp(name, "long") == 0) {
        *out = SYSTEM_KEY_BACK;
    } else {
        return false;
    }
    return true;
}

system_menu_action_t system_menu_handle_key(system_key_t key)
{
    system_menu_action_t action = SYSTEM_ACTION_NONE;

    menu_lock();
    expire_feedback_locked();

    if (s_menu.feedback_active) {
        close_feedback_locked();
        s_menu.event_count++;
        menu_unlock();
        return SYSTEM_ACTION_NONE;
    }

    if (!s_menu.active) {
        if (key == SYSTEM_KEY_OK) {
            s_menu.active = true;
            s_menu.page = MENU_PAGE_ROOT;
            set_message_locked("MENU OPEN");
        }
        s_menu.event_count++;
        menu_unlock();
        return SYSTEM_ACTION_NONE;
    }

    switch (key) {
    case SYSTEM_KEY_NEXT: {
        uint8_t count = item_count_for_page(s_menu.page);
        if (count > 0) {
            s_menu.selected[s_menu.page] = (uint8_t)((s_menu.selected[s_menu.page] + 1U) % count);
        }
        set_message_locked("-");
        break;
    }
    case SYSTEM_KEY_OK:
        if (s_menu.page == MENU_PAGE_ROOT) {
            s_menu.page = root_item_page(s_menu.selected[MENU_PAGE_ROOT]);
        } else {
            action = action_for_selected_locked();
        }
        break;
    case SYSTEM_KEY_BACK:
        if (s_menu.page == MENU_PAGE_ROOT) {
            s_menu.active = false;
            set_message_locked("MENU CLOSED");
        } else {
            s_menu.page = MENU_PAGE_ROOT;
            set_message_locked("-");
        }
        break;
    default:
        break;
    }

    s_menu.event_count++;
    menu_unlock();

    return action;
}

void system_menu_get_snapshot(system_menu_snapshot_t *out)
{
    if (out == NULL) {
        return;
    }

    menu_lock();
    expire_feedback_locked();
    memset(out, 0, sizeof(*out));
    out->active = s_menu.active || s_menu.feedback_active;
    out->page = (uint8_t)s_menu.page;
    out->depth = s_menu.page == MENU_PAGE_ROOT ? 0 : 1;
    out->selected = s_menu.selected[s_menu.page];
    out->item_count = item_count_for_page(s_menu.page);
    out->scroll_top = scroll_top_for(out->selected, out->item_count);
    out->event_count = s_menu.event_count;
    out->net_mode = s_menu.net_mode;
    out->comm_mode = s_menu.comm_mode;
    out->uart_baud = s_menu.uart_baud;
    out->ble_ready = s_menu.ble_ready;
    snprintf(out->message, sizeof(out->message), "%s", s_menu.message);

    if (s_menu.feedback_active) {
        snprintf(out->title, sizeof(out->title), "%s", s_menu.feedback_title);
        snprintf(out->path, sizeof(out->path), "FEEDBACK");
        snprintf(out->rows[0], sizeof(out->rows[0]), " %.45s", s_menu.feedback_status);
        snprintf(out->rows[1], sizeof(out->rows[1]), " %.45s", s_menu.feedback_detail);
        snprintf(out->rows[2], sizeof(out->rows[2]), " ");
        snprintf(out->rows[3], sizeof(out->rows[3]), " ");
        snprintf(out->footer, sizeof(out->footer), "S5L BACK");
        menu_unlock();
        return;
    }

    if (!s_menu.active) {
        char baud[12];
        make_baud(baud, sizeof(baud), s_menu.uart_baud);
        snprintf(out->title, sizeof(out->title), "STATUS");
        snprintf(out->path, sizeof(out->path), "IDLE");
        make_row(out->rows[0], sizeof(out->rows[0]), false, "Net", system_menu_net_name(s_menu.net_mode));
        make_row(out->rows[1], sizeof(out->rows[1]), false, "Comm", system_menu_comm_name(s_menu.comm_mode));
        make_row(out->rows[2], sizeof(out->rows[2]), false, "UART", baud);
        make_row(out->rows[3], sizeof(out->rows[3]), false, "BLE", s_menu.ble_ready ? "READY" : "--");
        snprintf(out->footer, sizeof(out->footer), "S5 MENU");
        menu_unlock();
        return;
    }

    snprintf(out->title, sizeof(out->title), "%s", page_title(s_menu.page));
    snprintf(out->path, sizeof(out->path), "%s", page_path(s_menu.page));
    snprintf(out->footer, sizeof(out->footer), "S4 NEXT S5 OK");

    for (uint8_t row = 0; row < SYSTEM_MENU_ROWS; row++) {
        uint8_t item = (uint8_t)(out->scroll_top + row);
        if (item < out->item_count) {
            char label[24];
            char value[16];
            page_item_label(s_menu.page, item, label, sizeof(label), value, sizeof(value));
            make_row(out->rows[row], sizeof(out->rows[row]),
                     item == out->selected, label, value);
        } else {
            snprintf(out->rows[row], sizeof(out->rows[row]), " ");
        }
    }

    menu_unlock();
}

void system_menu_set_net_mode(system_net_mode_t mode)
{
    menu_lock();
    s_menu.net_mode = mode;
    menu_unlock();
}

void system_menu_set_comm_mode(system_comm_mode_t mode)
{
    menu_lock();
    s_menu.comm_mode = mode;
    menu_unlock();
}

void system_menu_set_uart_baud(uint32_t baud)
{
    menu_lock();
    s_menu.uart_baud = baud;
    menu_unlock();
}

void system_menu_set_ble_ready(bool ready)
{
    menu_lock();
    s_menu.ble_ready = ready;
    menu_unlock();
}

void system_menu_set_message(const char *message)
{
    menu_lock();
    set_message_locked(message);
    menu_unlock();
}

void system_menu_show_action_result(system_menu_action_t action,
                                    const char *status,
                                    const char *detail,
                                    system_action_source_t source)
{
    if (status == NULL || status[0] == '\0') {
        status = "-";
    }
    if (detail == NULL || detail[0] == '\0') {
        detail = "-";
    }

    menu_lock();
    set_message_locked(detail);
    if (source == SYSTEM_ACTION_SOURCE_KEY) {
        s_menu.active = true;
        s_menu.feedback_active = true;
        s_menu.feedback_until_us = esp_timer_get_time() + (int64_t)MENU_FEEDBACK_MS * 1000LL;
        snprintf(s_menu.feedback_title, sizeof(s_menu.feedback_title),
                 "%s", system_menu_action_title(action));
        snprintf(s_menu.feedback_status, sizeof(s_menu.feedback_status), "%s", status);
        snprintf(s_menu.feedback_detail, sizeof(s_menu.feedback_detail), "%s", detail);
    }
    s_menu.event_count++;
    menu_unlock();
}

const char *system_menu_key_name(system_key_t key)
{
    switch (key) {
    case SYSTEM_KEY_NEXT:
        return "next";
    case SYSTEM_KEY_OK:
        return "ok";
    case SYSTEM_KEY_BACK:
        return "back";
    default:
        return "?";
    }
}

const char *system_menu_action_name(system_menu_action_t action)
{
    switch (action) {
    case SYSTEM_ACTION_NET_AP:
        return "net_ap";
    case SYSTEM_ACTION_NET_STA:
        return "net_sta";
    case SYSTEM_ACTION_NET_STA_CLEAR:
        return "net_sta_clear";
    case SYSTEM_ACTION_COMM_AUTO:
        return "comm_auto";
    case SYSTEM_ACTION_COMM_WIFI:
        return "comm_wifi";
    case SYSTEM_ACTION_COMM_BLE:
        return "comm_ble";
    case SYSTEM_ACTION_UART_BAUD_115200:
        return "uart_baud_115200";
    case SYSTEM_ACTION_UART_BAUD_921600:
        return "uart_baud_921600";
    case SYSTEM_ACTION_UART_BAUD_2000000:
        return "uart_baud_2000000";
    case SYSTEM_ACTION_UART_BAUD_3000000:
        return "uart_baud_3000000";
    case SYSTEM_ACTION_BLE_START:
        return "ble_start";
    case SYSTEM_ACTION_HEAP_INFO:
        return "heap_info";
    case SYSTEM_ACTION_STATS_RESET:
        return "stats_reset";
    case SYSTEM_ACTION_DISPLAY_INFO:
        return "display_info";
    case SYSTEM_ACTION_NONE:
    default:
        return "none";
    }
}

const char *system_menu_action_title(system_menu_action_t action)
{
    switch (action) {
    case SYSTEM_ACTION_NET_AP:
        return "WIFI AP";
    case SYSTEM_ACTION_NET_STA:
        return "WIFI STA";
    case SYSTEM_ACTION_NET_STA_CLEAR:
        return "CLEAR STA";
    case SYSTEM_ACTION_COMM_AUTO:
    case SYSTEM_ACTION_COMM_WIFI:
    case SYSTEM_ACTION_COMM_BLE:
        return "COMM MODE";
    case SYSTEM_ACTION_UART_BAUD_115200:
    case SYSTEM_ACTION_UART_BAUD_921600:
    case SYSTEM_ACTION_UART_BAUD_2000000:
    case SYSTEM_ACTION_UART_BAUD_3000000:
        return "UART BAUD";
    case SYSTEM_ACTION_BLE_START:
        return "BLE START";
    case SYSTEM_ACTION_HEAP_INFO:
        return "HEALTH";
    case SYSTEM_ACTION_STATS_RESET:
        return "CLEAR STATS";
    case SYSTEM_ACTION_DISPLAY_INFO:
        return "OLED INFO";
    case SYSTEM_ACTION_NONE:
    default:
        return "ACTION";
    }
}

const char *system_menu_net_name(system_net_mode_t mode)
{
    return mode == SYSTEM_NET_STA ? "STA" : "AP";
}

const char *system_menu_comm_name(system_comm_mode_t mode)
{
    switch (mode) {
    case SYSTEM_COMM_WIFI:
        return "WIFI";
    case SYSTEM_COMM_BLE:
        return "BLE";
    case SYSTEM_COMM_AUTO:
    default:
        return "AUTO";
    }
}
