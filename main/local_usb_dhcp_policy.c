#include "local_usb_dhcp_policy.h"

#include <string.h>

#ifdef ESP_PLATFORM
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
static portMUX_TYPE s_policy_lock = portMUX_INITIALIZER_UNLOCKED;
#define POLICY_LOCK() portENTER_CRITICAL(&s_policy_lock)
#define POLICY_UNLOCK() portEXIT_CRITICAL(&s_policy_lock)
#else
#define POLICY_LOCK() ((void)0)
#define POLICY_UNLOCK() ((void)0)
#endif

#define ETHERNET_HEADER_LENGTH 14U
#define ETHERNET_SOURCE_OFFSET 6U
#define DHCP_OPTION_PAD 0U
#define DHCP_OPTION_VENDOR_INFO 43U
#define DHCP_OPTION_PARAMETER_REQUEST_LIST 55U
#define DHCP_OPTION_VENDOR_CLASS 60U
#define DHCP_OPTION_IPV6_ONLY_PREFERRED 108U
#define DHCP_OPTION_CAPTIVE_PORTAL 114U
#define DHCP_OPTION_END 255U

static uint8_t s_usb_host_mac[6];
static bool s_usb_host_mac_valid;

void local_usb_dhcp_policy_reset(void)
{
    POLICY_LOCK();
    memset(s_usb_host_mac, 0, sizeof(s_usb_host_mac));
    s_usb_host_mac_valid = false;
    POLICY_UNLOCK();
}

void local_usb_dhcp_policy_note_frame(const void *frame, size_t length)
{
    if (frame == NULL || length < ETHERNET_HEADER_LENGTH) {
        return;
    }

    const uint8_t *bytes = frame;
    const uint8_t *source = bytes + ETHERNET_SOURCE_OFFSET;
    if ((source[0] & 0x01U) != 0U) {
        return;
    }

    POLICY_LOCK();
    memcpy(s_usb_host_mac, source, sizeof(s_usb_host_mac));
    s_usb_host_mac_valid = true;
    POLICY_UNLOCK();
}

static bool option_has_prefix(const uint8_t *value, size_t value_length,
                              const char *prefix, size_t prefix_length)
{
    return value_length >= prefix_length &&
           memcmp(value, prefix, prefix_length) == 0;
}

static bool parameter_request_list_identifies_android(
    const uint8_t *value, size_t value_length)
{
    /* Stable leading order in AOSP NetworkStack's DHCP request list. */
    static const uint8_t aosp_core[] = {
        1U, 3U, 6U, 15U, 26U, 28U, 51U, 58U, 59U,
    };

    if (value_length <= sizeof(aosp_core) ||
        memcmp(value, aosp_core, sizeof(aosp_core)) != 0) {
        return false;
    }

    /* Android releases/OEMs may include one or more of these after the core. */
    for (size_t index = sizeof(aosp_core); index < value_length; ++index) {
        if (value[index] == DHCP_OPTION_VENDOR_INFO ||
            value[index] == DHCP_OPTION_IPV6_ONLY_PREFERRED ||
            value[index] == DHCP_OPTION_CAPTIVE_PORTAL) {
            return true;
        }
    }
    return false;
}

static bool options_identify_android(const uint8_t *options, size_t length)
{
    static const char android_vendor[] = "android-dhcp-";
    bool has_android_vendor = false;
    bool has_android_parameter_list = false;
    size_t offset = 0;

    while (offset < length) {
        uint8_t code = options[offset++];
        if (code == DHCP_OPTION_END) {
            break;
        }
        if (code == DHCP_OPTION_PAD) {
            continue;
        }
        if (offset >= length) {
            return false;
        }

        size_t option_length = options[offset++];
        if (option_length > length - offset) {
            return false;
        }
        const uint8_t *value = options + offset;
        if (code == DHCP_OPTION_VENDOR_CLASS) {
            has_android_vendor = option_has_prefix(
                value, option_length, android_vendor,
                sizeof(android_vendor) - 1U);
        } else if (code == DHCP_OPTION_PARAMETER_REQUEST_LIST) {
            has_android_parameter_list =
                parameter_request_list_identifies_android(value, option_length);
        }
        offset += option_length;
    }
    return has_android_vendor || has_android_parameter_list;
}

bool local_usb_dhcp_policy_is_usb_client(const uint8_t client_mac[6])
{
    if (client_mac == NULL) {
        return false;
    }

    uint8_t usb_host_mac[6];
    bool usb_host_mac_valid;
    POLICY_LOCK();
    memcpy(usb_host_mac, s_usb_host_mac, sizeof(usb_host_mac));
    usb_host_mac_valid = s_usb_host_mac_valid;
    POLICY_UNLOCK();

    return usb_host_mac_valid &&
           memcmp(client_mac, usb_host_mac, sizeof(usb_host_mac)) == 0;
}

bool local_usb_dhcp_policy_should_offer_router(
    const uint8_t client_mac[6], const uint8_t *options, size_t options_length)
{
    return options != NULL && local_usb_dhcp_policy_is_usb_client(client_mac) &&
           options_identify_android(options, options_length);
}
