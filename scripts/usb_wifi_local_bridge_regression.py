"""Static contracts for one local 192.168.4.1 over USB NCM and Wi-Fi."""

from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"


class UsbWifiLocalBridgeRegression(unittest.TestCase):
    def test_dhcp_hooks_scope_android_gateway_to_the_usb_ingress_mac(self):
        for path in (
            MAIN / "project_include.cmake",
            MAIN / "lwip_hooks" / "local_usb_dhcp_hooks.h",
            MAIN / "local_usb_dhcp_hooks.c",
        ):
            self.assertTrue(path.is_file(), f"missing {path.relative_to(MAIN)}")
        cmake = (MAIN / "CMakeLists.txt").read_text(encoding="utf-8")
        project_hook = (MAIN / "project_include.cmake").read_text(encoding="utf-8")
        hook_header = (MAIN / "lwip_hooks" / "local_usb_dhcp_hooks.h").read_text(
            encoding="utf-8"
        )
        hook_source = (MAIN / "local_usb_dhcp_hooks.c").read_text(encoding="utf-8")
        bridge = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")

        for source in ("local_usb_dhcp_policy.c", "local_usb_dhcp_hooks.c"):
            self.assertIn(source, cmake)
        self.assertIn("WHOLE_ARCHIVE", cmake)
        self.assertIn("ESP_IDF_LWIP_HOOK_FILENAME", project_hook)
        self.assertIn("local_usb_dhcp_hooks.h", project_hook)
        self.assertIn("LWIP_HOOK_DHCPS_POST_STATE", hook_header)
        self.assertIn("LWIP_HOOK_DHCPS_POST_APPEND_OPTS", hook_header)
        self.assertIn("local_usb_dhcp_policy_should_offer_router", hook_source)
        self.assertIn("DHCP_OPTION_ROUTER", hook_source)
        self.assertIn("local_usb_dhcp_policy_note_frame(buffer, len)", bridge)
        self.assertIn("local_usb_dhcp_policy_reset()", bridge)
        self.assertRegex(bridge, r"\.gw\s*=\s*\{\.addr\s*=\s*0\}")

    def test_android_gateway_policy_uses_aosp_dhcp_fingerprint_on_usb(self):
        module = MAIN / "local_usb_dhcp_policy.c"
        checker = r'''
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "local_usb_dhcp_policy.h"

static void make_frame(uint8_t frame[14], const uint8_t source[6]) {
    memset(frame, 0, 14);
    memcpy(frame + 6, source, 6);
}

int main(void) {
    const uint8_t usb_android[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
    const uint8_t wifi_android[6] = {0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee};
    uint8_t frame[14];
    const uint8_t android_options[] = {
        0, 53, 1, 1,
        60, 15, 'a','n','d','r','o','i','d','-','d','h','c','p','-','1','6',
        255
    };
    const uint8_t windows_options[] = {
        53, 1, 1, 60, 8, 'M','S','F','T',' ','5','.','0', 255
    };
    const uint8_t observed_android_options[] = {
        53, 1, 1,
        60, 9, 'd','h','c','p','c','d','-','1','6',
        12, 7, 'p','h','o','n','e','-','1',
        55, 10, 1, 3, 6, 15, 26, 28, 51, 58, 59, 108,
        255
    };
    const uint8_t older_aosp_options[] = {
        53, 1, 1,
        55, 10, 1, 3, 6, 15, 26, 28, 51, 58, 59, 43,
        255
    };
    const uint8_t current_aosp_options[] = {
        53, 1, 1,
        55, 12, 1, 3, 6, 15, 26, 28, 51, 58, 59, 43, 114, 108,
        255
    };
    const uint8_t linux_dhcpcd_options[] = {
        53, 1, 1,
        60, 9, 'd','h','c','p','c','d','-','1','6',
        55, 13, 1, 121, 33, 3, 6, 15, 28, 51, 54, 58, 59, 119, 26,
        255
    };
    const uint8_t aosp_prefix_without_android_marker[] = {
        53, 1, 1,
        55, 10, 1, 3, 6, 15, 26, 28, 51, 58, 59, 12,
        255
    };
    const uint8_t malformed_options[] = {60, 20, 'a', 'n', 'd', 255};

    local_usb_dhcp_policy_reset();
    make_frame(frame, usb_android);
    local_usb_dhcp_policy_note_frame(frame, sizeof(frame));

    if (!local_usb_dhcp_policy_should_offer_router(
            usb_android, android_options, sizeof(android_options))) return 1;
    if (local_usb_dhcp_policy_should_offer_router(
            wifi_android, android_options, sizeof(android_options))) return 2;
    if (local_usb_dhcp_policy_should_offer_router(
            usb_android, windows_options, sizeof(windows_options))) return 3;
    if (local_usb_dhcp_policy_should_offer_router(
            usb_android, malformed_options, sizeof(malformed_options))) return 4;
    if (!local_usb_dhcp_policy_should_offer_router(
            usb_android, observed_android_options,
            sizeof(observed_android_options))) return 6;
    if (!local_usb_dhcp_policy_should_offer_router(
            usb_android, older_aosp_options,
            sizeof(older_aosp_options))) return 7;
    if (!local_usb_dhcp_policy_should_offer_router(
            usb_android, current_aosp_options,
            sizeof(current_aosp_options))) return 8;
    if (local_usb_dhcp_policy_should_offer_router(
            usb_android, linux_dhcpcd_options,
            sizeof(linux_dhcpcd_options))) return 9;
    if (local_usb_dhcp_policy_should_offer_router(
            usb_android, aosp_prefix_without_android_marker,
            sizeof(aosp_prefix_without_android_marker))) return 10;

    local_usb_dhcp_policy_reset();
    if (local_usb_dhcp_policy_should_offer_router(
            usb_android, android_options, sizeof(android_options))) return 5;
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "android_gateway_policy_check"
            compiled = subprocess.run(
                [
                    "gcc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(MAIN), "-x", "c", "-", "-x", "none",
                    str(module), "-o", str(executable),
                ],
                input=checker,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run(
                [str(executable)], capture_output=True, text=True, check=False
            )
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_component_and_build_configuration_enable_ncm_bridge(self):
        cmake = (MAIN / "CMakeLists.txt").read_text(encoding="utf-8")
        manifest = (MAIN / "idf_component.yml").read_text(encoding="utf-8")
        sdkconfig = (ROOT / "sdkconfig").read_text(encoding="utf-8")

        for source in ("local_access_bridge.c", "usb_ncm_windows.c"):
            self.assertIn(source, cmake)
        for component in ("esp_eth", "lwip"):
            self.assertIn(component, cmake)
        self.assertIn("espressif/esp_tinyusb", manifest)
        for setting in (
            "CONFIG_ESP_NETIF_BRIDGE_EN=y",
            "CONFIG_LWIP_NUM_NETIF_CLIENT_DATA=1",
            "CONFIG_TINYUSB_NET_MODE_NCM=y",
            "CONFIG_ESP_CONSOLE_SECONDARY_NONE=y",
        ):
            with self.subTest(setting=setting):
                self.assertIn(setting, sdkconfig)

    def test_bridge_is_the_only_owner_of_local_ip_and_dhcp(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        for symbol in (
            "ESP_IP4TOADDR(192, 168, 4, 1)",
            "ESP_NETIF_INHERENT_DEFAULT_BR_DHCPS()",
            "ESP_NETIF_NETSTACK_DEFAULT_BR",
            "ESP_NETIF_INHERENT_DEFAULT_WIFI_AP()",
            "ap_base.flags = ESP_NETIF_FLAG_AUTOUP",
            "ap_base.ip_info = NULL",
            "usb_base.flags = 0",
            "usb_base.ip_info = NULL",
            "esp_netif_bridge_add_port(s_bridge_netif, s_usb_netif)",
            "esp_netif_bridge_add_port(s_bridge_netif, s_ap_netif)",
            "esp_netif_dhcps_start(s_bridge_netif)",
        ):
            with self.subTest(symbol=symbol):
                self.assertIn(symbol, source)
        self.assertNotIn("esp_netif_dhcps_start(s_usb_netif)", source)
        self.assertNotIn("esp_netif_dhcps_start(s_ap_netif)", source)
        self.assertNotIn("esp_netif_init()", source)

    def test_bridge_ports_are_added_only_after_wifi_ap_starts(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        self.assertIn("WIFI_EVENT_AP_START", source)
        self.assertIn("activate_bridge", source)
        init_body = source.split("esp_err_t local_access_bridge_init(void)", 1)[1]
        self.assertNotIn("esp_netif_bridge_add_port", init_body)

    def test_usb_port_stays_alive_across_cable_detach(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        for symbol in (
            "tinyusb_driver_install",
            "tinyusb_net_init",
            "tinyusb_net_send_sync",
            "esp_netif_receive",
            "tud_mounted()",
            "TINYUSB_EVENT_ATTACHED",
            "TINYUSB_EVENT_DETACHED",
            "esp_read_mac",
            "s_usb_serial",
        ):
            with self.subTest(symbol=symbol):
                self.assertIn(symbol, source)
        self.assertNotIn("esp_netif_destroy", source)

    def test_usb_string_table_covers_ncm_interface_and_mac_indices(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        table = source.split("static const char *s_usb_strings[] = {", 1)[1]
        table = table.split("};", 1)[0]
        self.assertIn('"Wireless Debug NCM"', table)
        self.assertRegex(
            table,
            r's_usb_serial,\s*"Wireless Debug NCM",\s*s_usb_mac_string,',
        )

    def test_usb_identity_is_complete_before_the_device_connects(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        start_usb = source.split("static esp_err_t start_usb_port", 1)[1]
        start_usb = start_usb.split("static esp_err_t create_wifi_ap_port", 1)[0]

        self.assertIn("static char s_usb_mac_string[USB_MAC_STRING_LENGTH]", source)
        self.assertIn("snprintf(s_usb_mac_string", start_usb)
        self.assertLess(start_usb.index("snprintf(s_usb_mac_string"),
                        start_usb.index("tinyusb_driver_install"))

    def test_ncm_state_is_initialized_before_tinyusb_exposes_descriptors(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        start_usb = source.split("static esp_err_t start_usb_port", 1)[1]
        start_usb = start_usb.split("static esp_err_t create_wifi_ap_port", 1)[0]
        self.assertLess(start_usb.index("tinyusb_net_init"),
                        start_usb.index("tinyusb_driver_install"))

    def test_usb_uses_tinyusb_standard_attach_without_forced_reenumeration(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        start_usb = source.split("static esp_err_t start_usb_port", 1)[1]
        start_usb = start_usb.split("static esp_err_t create_wifi_ap_port", 1)[0]

        for symbol in ("USB_REENUMERATE_DELAY_MS", "tud_disconnect()",
                       "tud_connect()"):
            with self.subTest(symbol=symbol):
                self.assertNotIn(symbol, source)

    def test_ncm_device_descriptor_uses_iad_class_and_new_revision(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        descriptor = source.split(
            "static const tusb_desc_device_t s_usb_device_descriptor", 1
        )[1].split("};", 1)[0]
        for field in (
            ".bDeviceClass = TUSB_CLASS_MISC",
            ".bDeviceSubClass = MISC_SUBCLASS_COMMON",
            ".bDeviceProtocol = MISC_PROTOCOL_IAD",
            ".bcdDevice = 0x0201",
        ):
            with self.subTest(field=field):
                self.assertIn(field, descriptor)

    def test_usb_stack_initializes_in_normal_application_sequence(self):
        main = (MAIN / "main.c").read_text(encoding="utf-8")
        app_main = main.split("void app_main(void)", 1)[1]
        self.assertLess(app_main.index("app_core_init("),
                        app_main.index("local_access_bridge_init()"))
        self.assertLess(app_main.index("ble_spp_transport_init("),
                        app_main.index("local_access_bridge_init()"))
        self.assertLess(app_main.index("ui_controller_init("),
                        app_main.index("local_access_bridge_init()"))

    def test_wifi_initialization_preserves_the_usb_phy(self):
        sdkconfig = (ROOT / "sdkconfig").read_text(encoding="utf-8")
        self.assertIn("CONFIG_ESP_PHY_ENABLE_USB=y", sdkconfig)

    def test_usb_host_and_bridge_use_distinct_locally_administered_macs(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        self.assertIn("uint8_t ncm_mac[6]", source)
        self.assertIn("derive_local_mac(ncm_mac, base_mac, 0xa1)", source)
        self.assertIn("derive_local_mac(bridge_mac, base_mac, 0xa2)", source)
        self.assertIn("memcpy(ncm_config.mac_addr, ncm_mac", source)

    def test_dhcp_advertised_dns_has_a_responder(self):
        source = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        proxy = (MAIN / "local_dns_proxy.c").read_text(encoding="utf-8")
        cmake = (MAIN / "CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn("local_dns_proxy.c", cmake)
        self.assertIn("local_dns_proxy_start()", source)
        self.assertNotIn("esp_netif_set_dns_info", source)
        self.assertIn("esp_netif_is_netif_up(sta)", proxy)
        self.assertIn("esp_netif_get_ip_info(sta, &sta_ip)", proxy)
        self.assertIn("sta_ip.ip.addr == 0", proxy)

    def test_wifi_manager_uses_bridge_ap_and_main_starts_bridge_first(self):
        manager = (MAIN / "wifi_manager.c").read_text(encoding="utf-8")
        main = (MAIN / "main.c").read_text(encoding="utf-8")
        self.assertIn("local_access_bridge_ap_netif()", manager)
        self.assertNotIn("esp_netif_create_default_wifi_ap()", manager)
        self.assertNotIn("configure_ap_netif_no_gateway", manager)
        self.assertIn("local_access_bridge_init()", main)
        self.assertLess(main.index("local_access_bridge_init()"),
                        main.index("wifi_manager_init(&wifi_manager_config)"))

    def test_local_ap_remains_running_in_reported_sta_mode(self):
        manager = (MAIN / "wifi_manager.c").read_text(encoding="utf-8")
        start_sta = manager.split("static esp_err_t start_sta_locked(void)", 1)[1]
        start_sta = start_sta.split("static esp_err_t start_apsta_locked(void)", 1)[0]
        self.assertIn("esp_wifi_set_mode(WIFI_MODE_APSTA)", start_sta)
        self.assertIn("configure_ap_locked()", start_sta)
        self.assertNotIn("esp_wifi_set_mode(WIFI_MODE_STA)", manager)

    def test_oled_moves_off_native_usb_pins(self):
        header = (MAIN / "display_port.h").read_text(encoding="utf-8")
        self.assertIn("#define DISPLAY_SSD1315_SCL_GPIO 4", header)
        self.assertIn("#define DISPLAY_SSD1315_SDA_GPIO 5", header)
        self.assertNotIn("#define DISPLAY_SSD1315_SCL_GPIO 19", header)
        self.assertNotIn("#define DISPLAY_SSD1315_SDA_GPIO 20", header)

    def test_windows_ncm_descriptor_bytes_and_request_dispatch(self):
        module = MAIN / "usb_ncm_windows.c"
        self.assertTrue(module.is_file(), "Windows NCM descriptor module is missing")
        checker = r'''
#include <stdint.h>
#include <string.h>
#include "usb_ncm_windows.h"

int main(void) {
    const uint8_t *data = 0;
    uint16_t length = 0;
    if (sizeof(usb_ncm_bos_descriptor) != 33 ||
        memcmp(usb_ncm_ms_os_20_descriptor + 30, "WINNCM", 6) != 0) return 1;
    if (!usb_ncm_windows_get_descriptor(0xc0, USB_NCM_MS_VENDOR_CODE, 7,
                                        &data, &length)) return 2;
    if (data != usb_ncm_ms_os_20_descriptor ||
        length != USB_NCM_MS_OS_20_LENGTH) return 3;
    if (usb_ncm_windows_get_descriptor(0x40, USB_NCM_MS_VENDOR_CODE, 7,
                                       &data, &length)) return 4;
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "descriptor_check"
            compiled = subprocess.run(
                [
                    "gcc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(MAIN), "-x", "c", "-", "-x", "none",
                    str(module), "-o", str(executable),
                ],
                input=checker,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run(
                [str(executable)], capture_output=True, text=True, check=False
            )
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
