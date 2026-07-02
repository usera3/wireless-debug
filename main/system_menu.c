#include "system_menu.h"

#include <stdio.h>
#include <string.h>

#if !defined(SYSTEM_MENU_NO_FREERTOS)
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#endif

#define SYSTEM_MENU_PAGE_WIFI_MODE 0
#define WIFI_MODE_ITEM_COUNT       2

static const uint32_t s_uart_baud_choices[] = {
    115200,
    921600,
    2000000,
    3000000,
};

typedef struct {
    bool active;
    uint8_t selected;
    uint32_t event_count;
    system_net_mode_t net_mode;
    system_comm_mode_t comm_mode;
    uint32_t uart_baud;
    bool ble_ready;
    char message[SYSTEM_MENU_TEXT_LEN];
} system_menu_state_t;

static system_menu_state_t s_menu = {
    .active = false,
    .selected = 0,
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

static uint8_t selected_for_net_mode(system_net_mode_t mode)
{
    return mode == SYSTEM_NET_STA ? 1 : 0;
}

static void sync_selected_for_net_mode_locked(void)
{
    s_menu.selected = selected_for_net_mode(s_menu.net_mode);
}

static void make_row(char *dst, size_t dst_size, bool selected, const char *label, const char *value)
{
    snprintf(dst, dst_size, "%c%-10s %s", selected ? '>' : ' ', label, value == NULL ? "" : value);
}

static void make_baud(char *dst, size_t dst_size, uint32_t baud)
{
    if (baud >= 1000000 && baud % 1000000 == 0) {
        if (baud == 1000000) {
            snprintf(dst, dst_size, "1M");
            return;
        }
        if (baud == 2000000) {
            snprintf(dst, dst_size, "2M");
            return;
        }
        if (baud == 3000000) {
            snprintf(dst, dst_size, "3M");
            return;
        }
    }
    if (baud >= 1000 && baud % 1000 == 0) {
        snprintf(dst, dst_size, "%luK", (unsigned long)(baud / 1000));
        return;
    }
    snprintf(dst, dst_size, "%lu", (unsigned long)baud);
}

static system_menu_action_t commit_selected_locked(void)
{
    if (s_menu.selected == 0) {
        s_menu.net_mode = SYSTEM_NET_AP;
        set_message_locked("AP MODE");
        return SYSTEM_ACTION_NET_AP;
    }

    s_menu.net_mode = SYSTEM_NET_STA;
    set_message_locked("STA MODE");
    return SYSTEM_ACTION_NET_STA;
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
        strcmp(name, "left") == 0 || strcmp(name, "right") == 0) {
        *out = SYSTEM_KEY_NEXT;
    } else if (strcmp(name, "ok") == 0 || strcmp(name, "enter") == 0) {
        *out = SYSTEM_KEY_OK;
    } else if (strcmp(name, "back") == 0 || strcmp(name, "esc") == 0) {
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

    if (!s_menu.active) {
        if (key == SYSTEM_KEY_OK) {
            s_menu.active = true;
            sync_selected_for_net_mode_locked();
            set_message_locked("MENU OPEN");
        }
        s_menu.event_count++;
        menu_unlock();
        return SYSTEM_ACTION_NONE;
    }

    switch (key) {
    case SYSTEM_KEY_NEXT:
        s_menu.selected = (uint8_t)((s_menu.selected + 1) % WIFI_MODE_ITEM_COUNT);
        set_message_locked("-");
        break;
    case SYSTEM_KEY_OK:
        action = commit_selected_locked();
        break;
    case SYSTEM_KEY_BACK:
        s_menu.active = false;
        set_message_locked("MENU CLOSED");
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
    memset(out, 0, sizeof(*out));
    out->active = s_menu.active;
    out->page = SYSTEM_MENU_PAGE_WIFI_MODE;
    out->depth = 0;
    out->selected = s_menu.selected;
    out->item_count = s_menu.active ? WIFI_MODE_ITEM_COUNT : SYSTEM_MENU_ROWS;
    out->scroll_top = 0;
    out->event_count = s_menu.event_count;
    out->net_mode = s_menu.net_mode;
    out->comm_mode = s_menu.comm_mode;
    out->uart_baud = s_menu.uart_baud;
    out->ble_ready = s_menu.ble_ready;
    snprintf(out->message, sizeof(out->message), "%s", s_menu.message);

    if (!s_menu.active) {
        char baud[12];
        make_baud(baud, sizeof(baud), s_menu.uart_baud);
        snprintf(out->title, sizeof(out->title), "STATUS");
        snprintf(out->path, sizeof(out->path), "IDLE");
        make_row(out->rows[0], sizeof(out->rows[0]), false, "Net", system_menu_net_name(s_menu.net_mode));
        make_row(out->rows[1], sizeof(out->rows[1]), false, "Comm", system_menu_comm_name(s_menu.comm_mode));
        make_row(out->rows[2], sizeof(out->rows[2]), false, "UART", baud);
        make_row(out->rows[3], sizeof(out->rows[3]), false, "BLE", s_menu.ble_ready ? "READY" : "--");
        snprintf(out->footer, sizeof(out->footer), "OK WIFI MODE");
        menu_unlock();
        return;
    }

    snprintf(out->title, sizeof(out->title), "WIFI MODE");
    snprintf(out->path, sizeof(out->path), "WIFI");
    make_row(out->rows[0], sizeof(out->rows[0]), s_menu.selected == 0,
             "AP Mode", s_menu.net_mode == SYSTEM_NET_AP ? "ON" : "");
    make_row(out->rows[1], sizeof(out->rows[1]), s_menu.selected == 1,
             "STA Mode", s_menu.net_mode == SYSTEM_NET_STA ? "ON" : "");
    snprintf(out->rows[2], sizeof(out->rows[2]), " ");
    snprintf(out->rows[3], sizeof(out->rows[3]), " ");
    snprintf(out->footer, sizeof(out->footer), "NEXT SET BACK");
    menu_unlock();
}

void system_menu_set_net_mode(system_net_mode_t mode)
{
    menu_lock();
    s_menu.net_mode = mode;
    if (s_menu.active) {
        sync_selected_for_net_mode_locked();
    }
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
