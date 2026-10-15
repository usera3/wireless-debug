# The installed ESP-IDF is never edited. Select one generated build-only source.
idf_component_get_property(lwip_lib lwip COMPONENT_LIB)
idf_build_get_property(idf_path IDF_PATH)
set(dhcps_original "${idf_path}/components/lwip/apps/dhcpserver/dhcpserver.c")
set(dhcps_generator "${CMAKE_CURRENT_LIST_DIR}/../scripts/prepare_usb_dhcp_recovery.py")
set(dhcps_generated "${CMAKE_BINARY_DIR}/usb_dhcp_recovery/dhcpserver.c")

execute_process(
    COMMAND "${PYTHON}" "${dhcps_generator}" "${dhcps_original}" "${dhcps_generated}"
    RESULT_VARIABLE dhcps_result
    OUTPUT_VARIABLE dhcps_stdout
    ERROR_VARIABLE dhcps_stderr
)
if(NOT dhcps_result EQUAL 0)
    message(FATAL_ERROR "USB DHCP recovery generation failed: ${dhcps_stderr}")
endif()

get_target_property(dhcps_sources ${lwip_lib} SOURCES)
set(dhcps_replaced 0)
set(dhcps_new_sources "")
foreach(dhcps_source IN LISTS dhcps_sources)
    if(dhcps_source MATCHES "(^|/)apps/dhcpserver/dhcpserver\\.c$")
        list(APPEND dhcps_new_sources "${dhcps_generated}")
        math(EXPR dhcps_replaced "${dhcps_replaced} + 1")
    else()
        list(APPEND dhcps_new_sources "${dhcps_source}")
    endif()
endforeach()
if(NOT dhcps_replaced EQUAL 1)
    message(FATAL_ERROR "Expected exactly one ESP-IDF DHCP source, found ${dhcps_replaced}")
endif()
set_property(TARGET ${lwip_lib} PROPERTY SOURCES ${dhcps_new_sources})
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${dhcps_original}" "${dhcps_generator}"
)
message(STATUS "USB DHCP recovery: using project-local generated DHCP source")
