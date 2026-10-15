/* One local 192.168.4.1 LAN shared by native USB NCM and Wi-Fi SoftAP. */
#include "local_access_bridge.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif_defaults.h"
#include "esp_netif_net_stack.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/FreeRTOS.h"
#include "lwip/esp_netif_net_stack.h"
#include "netif/bridgeif.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "tinyusb_net.h"
#include "tusb.h"

#include "local_dns_proxy.h"
#include "local_usb_dhcp_policy.h"
#include "local_usb_dhcp_trace.h"
#include "local_usb_dhcp_recovery.h"
#include "lwip_hooks/local_usb_dhcp_hooks.h"
#include "usb_ncm_windows.h"

#define USB_SERIAL_LENGTH 13
#define USB_MAC_STRING_LENGTH 13

static const char *TAG = "local_access";

static esp_netif_t *s_usb_netif;
static esp_netif_t *s_ap_netif;
static esp_netif_t *s_bridge_netif;
static uint8_t s_usb_driver_token;
static volatile bool s_usb_attached;
static bool s_bridge_active;
static char s_usb_serial[USB_SERIAL_LENGTH];
static char s_usb_mac_string[USB_MAC_STRING_LENGTH];

static const char s_usb_language[] = {0x09, 0x04};
static const char *s_usb_strings[] = {
    s_usb_language,
    "Midea",
    "Wireless Debug USB Network",
    s_usb_serial,
    "Wireless Debug NCM",
    s_usb_mac_string,
};

static const tusb_desc_device_t s_usb_device_descriptor = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0201,
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = TINYUSB_ESPRESSIF_VID,
    .idProduct = 0x4000,
    .bcdDevice = 0x0201,
    .iManufacturer = 1,
    .iProduct = 2,
    .iSerialNumber = 3,
    .bNumConfigurations = 1,
};

static const esp_netif_ip_info_t s_bridge_ip = {
    .ip = {.addr = ESP_IP4TOADDR(192, 168, 4, 1)},
    .gw = {.addr = 0},
    .netmask = {.addr = ESP_IP4TOADDR(255, 255, 255, 0)},
};

static bridgeif_config_t s_bridge_layout = {
    .max_fdb_dyn_entries = 16,
    .max_fdb_sta_entries = 4,
    .max_ports = 2,
};

const uint8_t *tud_descriptor_bos_cb(void)
{
    return usb_ncm_bos_descriptor;
}

bool tud_vendor_control_xfer_cb(uint8_t rhport, uint8_t stage,
                                const tusb_control_request_t *request)
{
    if (stage != CONTROL_STAGE_SETUP) {
        return true;
    }
    const uint8_t *data = NULL;
    uint16_t length = 0;
    if (!usb_ncm_windows_get_descriptor(request->bmRequestType,
                                        request->bRequest,
                                        request->wIndex,
                                        &data, &length)) {
        return false;
    }
    return tud_control_xfer(rhport, request, (void *)data, length);
}

static void usb_device_event(tinyusb_event_t *event, void *arg)
{
    (void)arg;
    if (event == NULL) {
        return;
    }
    if (event->id == TINYUSB_EVENT_ATTACHED) {
        local_usb_dhcp_policy_reset();
        local_usb_dhcp_recovery_reset_client();
        s_usb_attached = true;
        ESP_LOGI(TAG, "USB host attached");
    } else if (event->id == TINYUSB_EVENT_DETACHED) {
        local_usb_dhcp_policy_reset();
        local_usb_dhcp_recovery_reset_client();
        s_usb_attached = false;
        ESP_LOGI(TAG, "USB host detached; Wi-Fi local access remains active");
    }
}

static void derive_local_mac(uint8_t output[6], const uint8_t base[6],
                             uint8_t discriminator)
{
    memcpy(output, base, 6);
    output[0] = (uint8_t)((output[0] | 0x02U) & 0xfeU);
    output[5] ^= discriminator;
}

static void free_rx_buffer(void *handle, void *buffer)
{
    (void)handle;
    free(buffer);
}

static esp_err_t usb_transmit(void *handle, void *buffer, size_t len)
{
    (void)handle;
    if (len > UINT16_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }
    /* Keep the bridge port alive while unplugged; only its frames are dropped. */
    if (!tud_mounted()) {
        return ESP_OK;
    }
    esp_err_t ret = tinyusb_net_send_sync(buffer, (uint16_t)len, NULL,
                                        pdMS_TO_TICKS(100));
    local_usb_dhcp_trace_log("TX", buffer, len, ret);
    return ret;
}

static esp_err_t usb_receive(void *buffer, uint16_t len, void *context)
{
    (void)context;
    if (s_usb_netif == NULL || len == 0) {
        return ESP_OK;
    }

    local_usb_dhcp_policy_note_frame(buffer, len);
    local_usb_dhcp_recovery_note_frame(buffer, len);
    local_usb_dhcp_trace_log("RX", buffer, len, ESP_OK);

    /* TinyUSB owns its RX buffer; lwIP receives a separately owned copy. */
    void *copy = malloc(len);
    if (copy == NULL) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(copy, buffer, len);
    return esp_netif_receive(s_usb_netif, copy, len, NULL);
}

static esp_err_t bridge_post_attach(esp_netif_t *netif, void *driver)
{
    ((esp_netif_driver_base_t *)driver)->netif = netif;
    return ESP_OK;
}

static esp_netif_driver_base_t s_bridge_driver = {
    .post_attach = bridge_post_attach,
};

static esp_err_t start_usb_port(const uint8_t base_mac[6],
                                uint8_t bridge_mac[6])
{
    uint8_t ncm_mac[6];
    derive_local_mac(ncm_mac, base_mac, 0xa1);
    derive_local_mac(bridge_mac, base_mac, 0xa2);
    snprintf(s_usb_serial, sizeof(s_usb_serial),
             "%02X%02X%02X%02X%02X%02X",
             base_mac[0], base_mac[1], base_mac[2],
             base_mac[3], base_mac[4], base_mac[5]);
    snprintf(s_usb_mac_string, sizeof(s_usb_mac_string),
             "%02X%02X%02X%02X%02X%02X",
             ncm_mac[0], ncm_mac[1], ncm_mac[2],
             ncm_mac[3], ncm_mac[4], ncm_mac[5]);

    tinyusb_net_config_t ncm_config = {
        .on_recv_callback = usb_receive,
    };
    /* USB host and lwIP bridge are separate L2 peers and require unique MACs. */
    memcpy(ncm_config.mac_addr, ncm_mac, sizeof(ncm_config.mac_addr));
    esp_err_t ret = tinyusb_net_init(&ncm_config);
    if (ret != ESP_OK) {
        return ret;
    }

    tinyusb_config_t usb_config = TINYUSB_DEFAULT_CONFIG(usb_device_event);
    usb_config.descriptor.device = &s_usb_device_descriptor;
    usb_config.descriptor.string = s_usb_strings;
    usb_config.descriptor.string_count =
        sizeof(s_usb_strings) / sizeof(s_usb_strings[0]);
    ret = tinyusb_driver_install(&usb_config);
    if (ret != ESP_OK) {
        tinyusb_net_deinit();
        return ret;
    }

    esp_netif_inherent_config_t usb_base = ESP_NETIF_INHERENT_DEFAULT_ETH();
    usb_base.flags = 0;
    usb_base.ip_info = NULL;
    usb_base.if_key = "USB_BR_PORT";
    usb_base.if_desc = "usb-ncm-br";
    usb_base.route_prio = 10;

    esp_netif_driver_ifconfig_t usb_driver = {
        .handle = &s_usb_driver_token,
        .transmit = usb_transmit,
        .driver_free_rx_buffer = free_rx_buffer,
    };
    struct esp_netif_netstack_config usb_stack = {
        .lwip = {
            .init_fn = ethernetif_init,
            .input_fn = ethernetif_input,
        },
    };
    esp_netif_config_t usb_netif_config = {
        .base = &usb_base,
        .driver = &usb_driver,
        .stack = &usb_stack,
    };
    s_usb_netif = esp_netif_new(&usb_netif_config);
    if (s_usb_netif == NULL) {
        return ESP_ERR_NO_MEM;
    }
    ret = esp_netif_set_mac(s_usb_netif, bridge_mac);
    if (ret != ESP_OK) {
        return ret;
    }
    esp_netif_action_start(s_usb_netif, NULL, 0, NULL);
    esp_netif_action_connected(s_usb_netif, NULL, 0, NULL);
    return ESP_OK;
}

static esp_err_t create_wifi_ap_port(void)
{
    esp_netif_inherent_config_t ap_base = ESP_NETIF_INHERENT_DEFAULT_WIFI_AP();
    ap_base.flags = ESP_NETIF_FLAG_AUTOUP;
    ap_base.ip_info = NULL;
    s_ap_netif = esp_netif_create_wifi(WIFI_IF_AP, &ap_base);
    if (s_ap_netif == NULL) {
        return ESP_ERR_NO_MEM;
    }
    return esp_wifi_set_default_wifi_ap_handlers();
}

static esp_err_t create_bridge(const uint8_t bridge_mac[6])
{
    esp_netif_inherent_config_t bridge_base =
        ESP_NETIF_INHERENT_DEFAULT_BR_DHCPS();
    bridge_base.ip_info = &s_bridge_ip;
    bridge_base.bridge_info = &s_bridge_layout;
    memcpy(bridge_base.mac, bridge_mac, 6);

    esp_netif_config_t bridge_config = {
        .base = &bridge_base,
        .stack = ESP_NETIF_NETSTACK_DEFAULT_BR,
    };
    s_bridge_netif = esp_netif_new(&bridge_config);
    if (s_bridge_netif == NULL) {
        return ESP_ERR_NO_MEM;
    }

    esp_err_t ret = esp_netif_attach(s_bridge_netif, &s_bridge_driver);
    if (ret != ESP_OK) {
        return ret;
    }
    return ESP_OK;
}

static esp_err_t activate_bridge(void)
{
    if (s_bridge_active) {
        return ESP_OK;
    }

    /* The AP lwIP netif only exists after the default AP_START handler runs. */
    esp_netif_action_start(s_bridge_netif, NULL, 0, NULL);
    esp_err_t ret = esp_netif_bridge_add_port(s_bridge_netif, s_usb_netif);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_netif_bridge_add_port(s_bridge_netif, s_ap_netif);
    if (ret != ESP_OK) {
        return ret;
    }
    esp_netif_action_connected(s_bridge_netif, NULL, 0, NULL);

    ret = local_dns_proxy_start();
    if (ret != ESP_OK) {
        return ret;
    }

    local_usb_dhcps_bind_netif(esp_netif_get_netif_impl(s_bridge_netif));
    ret = esp_netif_dhcps_start(s_bridge_netif);
    if (ret == ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) {
        ret = ESP_OK;
    }
    if (ret == ESP_OK) {
        s_bridge_active = true;
    }
    return ret;
}

static void bridge_wifi_event(void *arg, esp_event_base_t base,
                              int32_t event_id, void *event_data)
{
    (void)arg;
    (void)base;
    (void)event_id;
    (void)event_data;
    esp_err_t ret = activate_bridge();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to activate local bridge: %s",
                 esp_err_to_name(ret));
        return;
    }
    ESP_LOGI(TAG, "Local LAN ready: USB NCM + Wi-Fi AP at http://192.168.4.1");
}

esp_err_t local_access_bridge_init(void)
{
    if (s_bridge_netif != NULL) {
        return ESP_OK;
    }

    uint8_t base_mac[6];
    uint8_t bridge_mac[6];
    esp_err_t ret = esp_read_mac(base_mac, ESP_MAC_BASE);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = start_usb_port(base_mac, bridge_mac);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = create_wifi_ap_port();
    if (ret != ESP_OK) {
        return ret;
    }
    ret = create_bridge(bridge_mac);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_AP_START,
                                              bridge_wifi_event, NULL, NULL);
    if (ret != ESP_OK) {
        return ret;
    }

    ESP_LOGI(TAG, "Local USB/Wi-Fi bridge prepared; waiting for SoftAP start");
    return ESP_OK;
}

esp_netif_t *local_access_bridge_ap_netif(void)
{
    return s_ap_netif;
}

bool local_access_bridge_usb_attached(void)
{
    return (bool)s_usb_attached;
}
