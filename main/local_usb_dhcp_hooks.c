/* Per-client DHCP policy for Android hosts attached through native USB NCM. */
#include "lwip_hooks/local_usb_dhcp_hooks.h"

#include <stddef.h>

#include "dhcpserver/dhcpserver.h"
#include "esp_log.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"

#include "local_usb_dhcp_policy.h"

#define DHCP_OPTION_ROUTER 3U
#define DHCP_REPLY_OFFER 2U
#define DHCP_REPLY_ACK 5U
#define DHCP_MAGIC_COOKIE_LENGTH 4U

static const char *TAG = "usb_dhcp_policy";
static bool s_offer_router_for_current_client;

int16_t local_usb_dhcps_post_state(struct dhcps_msg *message,
                                   uint16_t message_length, int16_t state)
{
    s_offer_router_for_current_client = false;
    if (message == NULL) {
        return state;
    }

    const size_t options_offset = offsetof(struct dhcps_msg, options);
    if (message_length <= options_offset + DHCP_MAGIC_COOKIE_LENGTH) {
        return state;
    }

    size_t options_length = message_length - options_offset;
    if (options_length > sizeof(message->options)) {
        options_length = sizeof(message->options);
    }
    options_length -= DHCP_MAGIC_COOKIE_LENGTH;

    s_offer_router_for_current_client =
        local_usb_dhcp_policy_should_offer_router(
            message->chaddr,
            message->options + DHCP_MAGIC_COOKIE_LENGTH,
            options_length);
    if (s_offer_router_for_current_client) {
        ESP_LOGI(TAG, "Android USB host detected; offering local gateway");
    }
    return state;
}

void local_usb_dhcps_post_append_opts(struct netif *netif, void *dhcps,
                                      uint8_t state, uint8_t **options)
{
    (void)dhcps;
    if (!s_offer_router_for_current_client || netif == NULL ||
        options == NULL || *options == NULL ||
        (state != DHCP_REPLY_OFFER && state != DHCP_REPLY_ACK)) {
        s_offer_router_for_current_client = false;
        return;
    }

    const ip4_addr_t *server = netif_ip4_addr(netif);
    if (ip4_addr_isany_val(*server)) {
        s_offer_router_for_current_client = false;
        return;
    }

    uint8_t *output = *options;
    *output++ = DHCP_OPTION_ROUTER;
    *output++ = 4;
    *output++ = ip4_addr1(server);
    *output++ = ip4_addr2(server);
    *output++ = ip4_addr3(server);
    *output++ = ip4_addr4(server);
    *options = output;
    s_offer_router_for_current_client = false;
}
