#pragma once

#include <stdint.h>

struct dhcps_msg;
struct netif;

int16_t local_usb_dhcps_post_state(struct dhcps_msg *message,
                                   uint16_t message_length, int16_t state);
void local_usb_dhcps_post_append_opts(struct netif *netif, void *dhcps,
                                      uint8_t state, uint8_t **options);

#define LWIP_HOOK_DHCPS_POST_STATE(message, length, state) \
    local_usb_dhcps_post_state((message), (length), (state))

/* ESP-IDF's hook call site intentionally has no trailing semicolon. */
#define LWIP_HOOK_DHCPS_POST_APPEND_OPTS(netif, dhcps, state, options) \
    local_usb_dhcps_post_append_opts((netif), (dhcps), (state), (options));
