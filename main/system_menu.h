#ifndef SYSTEM_MENU_H
#define SYSTEM_MENU_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SYSTEM_MENU_ROWS 4
#define SYSTEM_MENU_TEXT_LEN 48
#define SYSTEM_MENU_WIFI_MAX_APS 8

typedef enum {
    SYSTEM_KEY_NEXT,
    SYSTEM_KEY_OK,
    SYSTEM_KEY_BACK,
} system_key_t;

typedef enum {
    SYSTEM_ACTION_SOURCE_KEY,
    SYSTEM_ACTION_SOURCE_WEB,
    SYSTEM_ACTION_SOURCE_SYSTEM,
} system_action_source_t;

typedef enum {
    SYSTEM_NET_AP,
    SYSTEM_NET_STA,
} system_net_mode_t;

typedef enum {
    SYSTEM_COMM_AUTO,
    SYSTEM_COMM_WIFI,
    SYSTEM_COMM_BLE,
} system_comm_mode_t;

typedef enum {
    SYSTEM_ACTION_NONE,
    SYSTEM_ACTION_NET_AP,
    SYSTEM_ACTION_NET_STA,
    SYSTEM_ACTION_NET_STA_QUICK,
    SYSTEM_ACTION_NET_STA_WEB_SETUP,
    SYSTEM_ACTION_NET_STA_QUICK_CONNECT,
    SYSTEM_ACTION_NET_STA_CLEAR,
    SYSTEM_ACTION_COMM_AUTO,
    SYSTEM_ACTION_COMM_WIFI,
    SYSTEM_ACTION_COMM_BLE,
    SYSTEM_ACTION_UART_BAUD_115200,
    SYSTEM_ACTION_UART_BAUD_921600,
    SYSTEM_ACTION_UART_BAUD_2000000,
    SYSTEM_ACTION_UART_BAUD_3000000,
    SYSTEM_ACTION_BLE_START,
    SYSTEM_ACTION_HEAP_INFO,
    SYSTEM_ACTION_STATS_RESET,
    SYSTEM_ACTION_DISPLAY_INFO,
} system_menu_action_t;

typedef struct {
    char ssid[33];
    int8_t rssi;
    bool saved;
} system_menu_wifi_ap_t;

typedef struct {
    bool active;
    uint8_t page;
    uint8_t depth;
    uint8_t selected;
    uint8_t item_count;
    uint8_t scroll_top;
    uint32_t event_count;
    system_net_mode_t net_mode;
    system_comm_mode_t comm_mode;
    uint32_t uart_baud;
    bool ble_ready;
    char title[SYSTEM_MENU_TEXT_LEN];
    char path[SYSTEM_MENU_TEXT_LEN];
    char rows[SYSTEM_MENU_ROWS][SYSTEM_MENU_TEXT_LEN];
    char footer[SYSTEM_MENU_TEXT_LEN];
    char message[SYSTEM_MENU_TEXT_LEN];
} system_menu_snapshot_t;

void system_menu_init(void);
bool system_menu_key_from_name(const char *name, system_key_t *out);
system_menu_action_t system_menu_handle_key(system_key_t key);
void system_menu_get_snapshot(system_menu_snapshot_t *out);
void system_menu_set_net_mode(system_net_mode_t mode);
void system_menu_set_comm_mode(system_comm_mode_t mode);
void system_menu_set_uart_baud(uint32_t baud);
void system_menu_set_ble_ready(bool ready);
void system_menu_set_message(const char *message);
void system_menu_set_wifi_scan_results(const system_menu_wifi_ap_t *aps,
                                       uint8_t count);
bool system_menu_get_selected_wifi_ssid(char *out, size_t out_size);
void system_menu_show_action_result(system_menu_action_t action,
                                    const char *status,
                                    const char *detail,
                                    system_action_source_t source);
uint32_t system_menu_uart_baud_choice(uint8_t index);
uint8_t system_menu_uart_baud_choice_count(void);

const char *system_menu_key_name(system_key_t key);
const char *system_menu_action_name(system_menu_action_t action);
const char *system_menu_action_title(system_menu_action_t action);
const char *system_menu_net_name(system_net_mode_t mode);
const char *system_menu_comm_name(system_comm_mode_t mode);

#endif /* SYSTEM_MENU_H */
