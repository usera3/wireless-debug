idf_component_register(SRCS "input_buttons.c" "system_menu.c" "motor_diag.c" "display_font_fusion_12_zh.c" "health_reporter.c" "comm_stats.c" "ble_transport.c" "wifi_manager.c" "local_access_bridge.c" "local_dns_proxy.c" "local_usb_dhcp_policy.c" "local_usb_dhcp_hooks.c" "usb_ncm_windows.c" "ui_controller.c" "app_core.c" "wifi_transport.c" "wifi_status_ws.c" "web_api.c" "uart_transport.c" "router_service.c" "web_static.c" "http_utils.c" "cloud_mqtt.c" "cloud_osc_keepalive.c" "cloud_ws_uplink.c" "cloud_ws_batch_policy.c" "cloud_ws_socket.c" "cloud_waveform_codec.c" "main.c" "display_port.c" "display_lvgl.c" "display_ui.c" "display_ui_motion.c"
                    INCLUDE_DIRS "."
                    REQUIRES nvs_flash esp_driver_uart esp_driver_gpio esp_driver_i2c bt nimble_peripheral_utils esp_wifi esp_http_server esp_eth lwip spiffs esp_timer esp_psram esp_app_format esp_rom lvgl__lvgl mqtt cjson
                    WHOLE_ARCHIVE)

spiffs_create_partition_image(storage ../dist FLASH_IN_PROJECT)                    
