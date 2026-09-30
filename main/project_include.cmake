# Make the project DHCP hooks visible while ESP-IDF builds its lwIP component.
idf_build_set_property(
    INCLUDE_DIRECTORIES
    "${CMAKE_CURRENT_LIST_DIR}/lwip_hooks"
    APPEND
)
idf_build_set_property(
    COMPILE_DEFINITIONS
    "ESP_IDF_LWIP_HOOK_FILENAME=\"local_usb_dhcp_hooks.h\""
    APPEND
)
