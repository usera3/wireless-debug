#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* IPv4 values below are canonical host-order numbers, e.g. 0xc0a80402. */
typedef struct {
    uint8_t type;
    uint8_t mac[6];
    uint32_t xid;
    uint32_t ciaddr;
    uint32_t requested;
    uint32_t server;
    bool has_requested;
    bool has_server;
    bool overloaded;
} local_usb_dhcp_message_t;

enum {
    LOCAL_USB_DHCP_RECOVERY_NONE,
    LOCAL_USB_DHCP_RECOVERY_DECLINE,
    LOCAL_USB_DHCP_RECOVERY_RETRY,
};

/* Reset all state at bridge startup; reset_client retains quarantined IPs. */
void local_usb_dhcp_recovery_reset(void);
void local_usb_dhcp_recovery_reset_client(void);
bool local_usb_dhcp_recovery_parse(const void *payload, size_t length,
                                  local_usb_dhcp_message_t *message);
/* Ignore delayed old-candidate REQUESTs and invalid/stale USB DECLINEs. */
bool local_usb_dhcp_recovery_accept(const local_usb_dhcp_message_t *message,
                                   uint32_t lease_ip, uint32_t server_ip,
                                   bool is_usb, uint64_t now_ms);
int local_usb_dhcp_recovery_before(const local_usb_dhcp_message_t *message,
                                   uint32_t lease_ip, uint32_t server_ip,
                                   bool is_usb, uint64_t now_ms);
void local_usb_dhcp_recovery_ack(const local_usb_dhcp_message_t *message,
                                uint32_t assigned_ip, bool is_usb,
                                uint64_t now_ms);
bool local_usb_dhcp_recovery_allowed(uint32_t ip, uint64_t now_ms);
/* Only call for USB ingress; non-DHCP IPv4 from the leased MAC/IP confirms use. */
void local_usb_dhcp_recovery_note_frame(const void *frame, size_t length);
