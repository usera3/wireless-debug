cmake_minimum_required(VERSION 3.16)

project(lvgl_oled_pc_sim C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(PROJECT_ROOT ${CMAKE_CURRENT_LIST_DIR}/../..)
set(LVGL_ROOT ${PROJECT_ROOT}/managed_components/lvgl__lvgl)

set(LV_BUILD_CONF_DIR ${CMAKE_CURRENT_LIST_DIR})
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)

add_subdirectory(${LVGL_ROOT} ${CMAKE_BINARY_DIR}/lvgl)

add_executable(lvgl_oled_pc_sim
    main.c
    ${PROJECT_ROOT}/main/display_ui.c
    ${PROJECT_ROOT}/main/system_menu.c
)

target_include_directories(lvgl_oled_pc_sim PRIVATE
    ${PROJECT_ROOT}/main
    ${SDL2_INCLUDE_DIRS}
)

target_compile_options(lvgl_oled_pc_sim PRIVATE ${SDL2_CFLAGS_OTHER})

target_compile_definitions(lvgl_oled_pc_sim PRIVATE SYSTEM_MENU_NO_FREERTOS=1)

target_link_libraries(lvgl_oled_pc_sim PRIVATE
    lvgl
    ${SDL2_LIBRARIES}
    m
)
