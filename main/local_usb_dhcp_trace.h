#pragma once

#include <stddef.h>

/* Bytes excluding NUL, or -1 for malformed/non-DHCP input or insufficient space.
 * Neither input nor destination is modified on failure. No heap allocation. */
int local_usb_dhcp_trace_format(char *dst, size_t capacity,
                                const void *frame, size_t length);

#ifdef ESP_PLATFORM
/* RX: callback received a frame. TX: driver submission result, not delivery. */
void local_usb_dhcp_trace_log(const char *direction, const void *frame,
                              size_t length, int submit_result);
#endif
