"""Static contracts for one local 192.168.4.1 over USB NCM and Wi-Fi."""

from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"


class UsbWifiLocalBridgeRegression(unittest.TestCase):
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
            r's_usb_serial,\s*"Wireless Debug NCM",\s*"",',
        )

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
