#include "local_usb_dhcp_trace.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_log.h"
#endif

enum { ETHERNET_SIZE = 14, UDP_SIZE = 8, DHCP_FIXED_SIZE = 240,
       SUMMARY_CAPACITY = 224 };

static unsigned read_be16(const uint8_t *p)
{
    return ((unsigned)p[0] << 8) | p[1];
}

static void format_optional_ip(char dst[16], const uint8_t *address)
{
    if (address == NULL) {
        dst[0] = '-';
        dst[1] = '\0';
        return;
    }
    snprintf(dst, 16, "%u.%u.%u.%u", (unsigned)address[0],
             (unsigned)address[1], (unsigned)address[2], (unsigned)address[3]);
}

int local_usb_dhcp_trace_format(char *dst, size_t capacity,
                                const void *frame, size_t length)
{
    static const char *const types[] = {
        "DISCOVER", "OFFER", "REQUEST", "DECLINE",
        "ACK", "NAK", "RELEASE", "INFORM"
    };
    if (dst == NULL || capacity == 0 || frame == NULL ||
        length < ETHERNET_SIZE + 20) {
        return -1;
    }
    const uint8_t *ethernet = frame;
    if (read_be16(ethernet + 12) != 0x0800) {
        return -1;
    }
    const uint8_t *ip = ethernet + ETHERNET_SIZE;
    size_t ihl = (size_t)(ip[0] & 0x0f) * 4;
    size_t ip_length = read_be16(ip + 2);
    if ((ip[0] >> 4) != 4 || ihl < 20 || ip_length < ihl + UDP_SIZE ||
        ip_length > length - ETHERNET_SIZE || ip[9] != 17 ||
        (read_be16(ip + 6) & 0x3fff) != 0) {
        return -1;
    }
    const uint8_t *udp = ip + ihl;
    unsigned source_port = read_be16(udp);
    unsigned destination_port = read_be16(udp + 2);
    size_t udp_length = read_be16(udp + 4);
    if (!((source_port == 68 && destination_port == 67) ||
          (source_port == 67 && destination_port == 68)) ||
        udp_length < UDP_SIZE + DHCP_FIXED_SIZE ||
        udp_length > ip_length - ihl) {
        return -1;
    }
    const uint8_t *dhcp = udp + UDP_SIZE;
    if ((dhcp[0] != 1 && dhcp[0] != 2) || dhcp[1] != 1 || dhcp[2] != 6 ||
        dhcp[236] != 99 || dhcp[237] != 130 ||
        dhcp[238] != 83 || dhcp[239] != 99) {
        return -1;
    }
    const uint8_t *requested = NULL;
    const uint8_t *server = NULL;
    unsigned message_type = 0;
    size_t options_length = udp_length - UDP_SIZE - DHCP_FIXED_SIZE;
    const uint8_t *options = dhcp + DHCP_FIXED_SIZE;
    size_t offset = 0;
    int ended = 0;
    while (offset < options_length) {
        unsigned code = options[offset++];
        if (code == 0) {
            continue;
        }
        if (code == 255) {
            ended = 1;
            break;
        }
        if (offset == options_length) {
            return -1;
        }
        size_t option_length = options[offset++];
        if (option_length > options_length - offset) {
            return -1;
        }
        const uint8_t *value = options + offset;
        if (code == 53) {
            if (message_type != 0 || option_length != 1 ||
                value[0] < 1 || value[0] > 8) {
                return -1;
            }
            message_type = value[0];
        } else if (code == 50) {
            if (requested != NULL || option_length != 4) {
                return -1;
            }
            requested = value;
        } else if (code == 54) {
            if (server != NULL || option_length != 4) {
                return -1;
            }
            server = value;
        }
        offset += option_length;
    }
    if (!ended || message_type == 0) {
        return -1;
    }

    char requested_text[16], server_text[16], summary[SUMMARY_CAPACITY];
    format_optional_ip(requested_text, requested);
    format_optional_ip(server_text, server);
    int result = snprintf(summary, sizeof(summary),
        "type=%s xid=%02X%02X%02X%02X mac=%02X:%02X:%02X:%02X:%02X:%02X "
        "ciaddr=%u.%u.%u.%u yiaddr=%u.%u.%u.%u requested=%s server=%s",
        types[message_type - 1], (unsigned)dhcp[4], (unsigned)dhcp[5],
        (unsigned)dhcp[6], (unsigned)dhcp[7], (unsigned)dhcp[28],
        (unsigned)dhcp[29], (unsigned)dhcp[30], (unsigned)dhcp[31],
        (unsigned)dhcp[32], (unsigned)dhcp[33],
        (unsigned)dhcp[12], (unsigned)dhcp[13], (unsigned)dhcp[14], (unsigned)dhcp[15],
        (unsigned)dhcp[16], (unsigned)dhcp[17], (unsigned)dhcp[18], (unsigned)dhcp[19],
        requested_text, server_text);
    if (result < 0 || (size_t)result >= sizeof(summary) ||
        (size_t)result >= capacity) {
        return -1;
    }
    memcpy(dst, summary, (size_t)result + 1);
    return result;
}

#ifdef ESP_PLATFORM
void local_usb_dhcp_trace_log(const char *direction, const void *frame,
                              size_t length, int submit_result)
{
    static const char *const tag = "usb_dhcp_trace";
    if (esp_log_level_get(tag) < ESP_LOG_INFO) {
        return;
    }
    char summary[SUMMARY_CAPACITY];
    if (local_usb_dhcp_trace_format(summary, sizeof(summary), frame, length) < 0) {
        return;
    }
    ESP_LOGI(tag, "%s submit_result=%d %s", direction, submit_result, summary);
}
#endif
