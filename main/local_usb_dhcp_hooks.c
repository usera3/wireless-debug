/* Per-client DHCP policy for Android hosts attached through native USB NCM. */
#include "lwip_hooks/local_usb_dhcp_hooks.h"

#include <stddef.h>

#include "dhcpserver/dhcpserver.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"

#include "local_usb_dhcp_policy.h"
#include "local_usb_dhcp_recovery.h"

#define DHCP_OPTION_ROUTER 3U
#define DHCP_REPLY_OFFER 2U
#define DHCP_REPLY_ACK 5U
#define DHCP_MAGIC_COOKIE_LENGTH 4U

static const char *TAG = "usb_dhcp_policy";
static bool s_offer_router_for_current_client;
static struct netif *s_recovery_netif;

static uint64_t recovery_now_ms(void)
{
    /* sys_now() wraps after ~49.7 days; quarantine lifetime must not restart. */
    return (uint64_t)esp_timer_get_time() / 1000U;
}

void local_usb_dhcps_bind_netif(struct netif *netif)
{
    /* Called once at bridge activation, before the DHCP server starts. */
    local_usb_dhcp_recovery_reset();
    s_recovery_netif = netif;
}

bool local_usb_dhcps_recovery_accept(struct netif *netif,
                                     struct dhcps_msg *message,
                                     uint16_t length, uint32_t lease_ip)
{
    local_usb_dhcp_message_t parsed;
    if (netif == NULL || netif != s_recovery_netif || message == NULL ||
        length < offsetof(struct dhcps_msg, chaddr) + 6) {
        return true;
    }
    bool is_usb = local_usb_dhcp_policy_is_usb_client(message->chaddr);
    if (!local_usb_dhcp_recovery_parse(message, length, &parsed)) {
        /* A malformed USB DECLINE must never enter the stock lease-delete path.
         * Valid option-overload messages are parsed/marked and remain supported. */
        return !is_usb;
    }
    return local_usb_dhcp_recovery_accept(
        &parsed, lwip_ntohl(lease_ip), lwip_ntohl(netif_ip4_addr(netif)->addr),
        is_usb, recovery_now_ms());
}

bool local_usb_dhcps_recovery_request(struct netif *netif,
                                      struct dhcps_msg *message,
                                      uint16_t length, uint32_t lease_ip)
{
    local_usb_dhcp_message_t parsed;
    if (netif == NULL || netif != s_recovery_netif ||
        !local_usb_dhcp_recovery_parse(message, length, &parsed)) {
        return false;
    }
    uint32_t ip = lwip_ntohl(lease_ip);
    int reason = local_usb_dhcp_recovery_before(
        &parsed, ip, lwip_ntohl(netif_ip4_addr(netif)->addr),
        local_usb_dhcp_policy_is_usb_client(parsed.mac), recovery_now_ms());
    if (reason != LOCAL_USB_DHCP_RECOVERY_NONE) {
        ESP_LOGW(TAG, "USB candidate quarantined: %u.%u.%u.%u reason=%s xid=%08lX",
                 (unsigned)(ip >> 24), (unsigned)((ip >> 16) & 255U),
                 (unsigned)((ip >> 8) & 255U), (unsigned)(ip & 255U),
                 reason == LOCAL_USB_DHCP_RECOVERY_DECLINE ? "decline" : "early-restart-heuristic",
                 (unsigned long)parsed.xid);
    }
    /* DECLINE still runs the upstream release path, for this client's old lease. */
    return reason == LOCAL_USB_DHCP_RECOVERY_RETRY;
}

bool local_usb_dhcps_recovery_address(struct netif *netif, uint32_t ip)
{
    return netif == NULL || netif != s_recovery_netif ||
           local_usb_dhcp_recovery_allowed(lwip_ntohl(ip), recovery_now_ms());
}

void local_usb_dhcps_recovery_ack(struct netif *netif,
                                  struct dhcps_msg *message,
                                  uint16_t length, uint32_t assigned_ip)
{
    local_usb_dhcp_message_t parsed;
    if (netif == NULL || netif != s_recovery_netif ||
        !local_usb_dhcp_recovery_parse(message, length, &parsed) ||
        (parsed.has_server && parsed.server != lwip_ntohl(netif_ip4_addr(netif)->addr))) {
        return;
    }
    /* This records an ACK decision, not proof that the host installed the IP. */
    local_usb_dhcp_recovery_ack(&parsed, lwip_ntohl(assigned_ip),
                               local_usb_dhcp_policy_is_usb_client(parsed.mac),
                               recovery_now_ms());
}

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
