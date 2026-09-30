#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Forget the USB host identity when the native USB link is reset/detached. */
void local_usb_dhcp_policy_reset(void);

/* Learn the directly attached USB host MAC from an incoming Ethernet frame. */
void local_usb_dhcp_policy_note_frame(const void *frame, size_t length);

/* True only for an Android DHCP client previously observed on the USB port. */
bool local_usb_dhcp_policy_should_offer_router(
    const uint8_t client_mac[6], const uint8_t *options, size_t options_length);
