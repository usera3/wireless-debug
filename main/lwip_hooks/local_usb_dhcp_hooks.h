#pragma once

#include <stdint.h>
#include <stdbool.h>

struct dhcps_msg;
struct netif;

void local_usb_dhcps_bind_netif(struct netif *netif);
bool local_usb_dhcps_recovery_accept(struct netif *netif,
                                     struct dhcps_msg *message,
                                     uint16_t length, uint32_t lease_ip);
bool local_usb_dhcps_recovery_request(struct netif *netif,
                                      struct dhcps_msg *message,
                                      uint16_t length, uint32_t lease_ip);
bool local_usb_dhcps_recovery_address(struct netif *netif, uint32_t ip);
void local_usb_dhcps_recovery_ack(struct netif *netif,
                                  struct dhcps_msg *message,
                                  uint16_t length, uint32_t assigned_ip);

#define LWIP_HOOK_DHCPS_RECOVERY_ACCEPT(n, m, length, ip) \
    local_usb_dhcps_recovery_accept((n), (m), (length), (ip))
#define LWIP_HOOK_DHCPS_RECOVERY_REQUEST(n, m, length, ip) \
    local_usb_dhcps_recovery_request((n), (m), (length), (ip))
#define LWIP_HOOK_DHCPS_RECOVERY_ADDRESS(n, ip) \
    local_usb_dhcps_recovery_address((n), (ip))
#define LWIP_HOOK_DHCPS_RECOVERY_ACK(n, m, length, ip) \
    local_usb_dhcps_recovery_ack((n), (m), (length), (ip))

int16_t local_usb_dhcps_post_state(struct dhcps_msg *message,
                                   uint16_t message_length, int16_t state);
void local_usb_dhcps_post_append_opts(struct netif *netif, void *dhcps,
                                      uint8_t state, uint8_t **options);

#define LWIP_HOOK_DHCPS_POST_STATE(message, length, state) \
    local_usb_dhcps_post_state((message), (length), (state))

/* ESP-IDF's hook call site intentionally has no trailing semicolon. */
#define LWIP_HOOK_DHCPS_POST_APPEND_OPTS(netif, dhcps, state, options) \
    local_usb_dhcps_post_append_opts((netif), (dhcps), (state), (options));
