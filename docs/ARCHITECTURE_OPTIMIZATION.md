# wireless_debug 架构优化建议

## 当前主要问题

`main/main.c` 同时包含 UART、BLE、WiFi、WebSocket、HTTP API、SPIFFS 文件服务、菜单和显示同步逻辑。通信数据平面和配置控制平面混在一起，导致阅读入口不清晰，也让性能优化容易误伤其他功能。

本轮已先处理数据平面里最直接影响可靠性的问题：

- 运行核心状态已抽到 `main/app_core.c`，统一保存通信模式和 UART 波特率。
- UART 到 WiFi 的数据不再被 `FRAME_MAX_LEN` 截断，改为按静态帧池分片入队。
- UART 到 BLE 的数据不再额外 `malloc + memcpy`，改为按连接实际 ATT MTU 分片发送。
- 双模自动切换时，首次触发切换的 UART 帧会继续发送，不再只切换模式后丢帧。
- 静态文件服务修复 404 和内存不足路径的堆内存释放。
- 显示后端保留硬件 SSD1315 默认配置，避免烧录后真实屏幕不亮。
- HTTP JSON、CORS、OPTIONS 响应头已抽到 `main/http_utils.c`，作为后续拆分 Web 控制面的第一步。
- SPIFFS 静态页面和 Excel 文件管理已抽到 `main/web_static.c`，`main.c` 只负责初始化和注册。
- UART 帧到 BLE/WiFi 的路由决策已抽到 `main/router_service.c`，UART 任务只负责组帧。
- UART 驱动初始化、事件队列、软件组帧和波特率切换已抽到 `main/uart_transport.c`。
- UART/Menu/Agent/Display HTTP API 已抽到 `main/web_api.c`，通过回调访问主应用状态。
- WiFi AP/STA 状态、配网 NVS、STA 超时回 AP 和 WiFi 事件处理已抽到 `main/wifi_manager.c`。
- WiFi AP/STA HTTP API 已并入 `main/web_api.c`，HTTP 入口集中注册，底层 WiFi 状态通过回调读取。
- 菜单动作协调已抽到 `main/ui_controller.c`，菜单到 app_core/WiFi/BLE/UART/显示的调度通过回调解耦。
- WebSocket 收发、静态发送帧池和 WiFi 发送队列已抽到 `main/wifi_transport.c`，收到的 WiFi 帧通过回调交回主应用写 UART。
- NimBLE SPP 初始化、GATT、Notify 分片、订阅状态和启动互斥已抽到 `main/ble_transport.c`，对应用层暴露 `ble_spp_transport_*` 接口，避免和 ESP-IDF NimBLE 内部 `ble_transport_init()` 命名冲突。
- 通信健康计数已抽到 `main/comm_stats.c`，UART/BLE/WiFi/router 的收发字节、丢弃、队列满、Notify/WebSocket 失败会汇总到 `/api/agent/status` 的 `comm_stats` 字段。
- 串口健康报告已抽到 `main/health_reporter.c`，每 30 秒通过 ESP_LOG 输出 `HEALTH OK/ALERT`，无需连接 WiFi 也能从 COM7 观察通信计数和 heap。
- OLED 常态标题已显示固件版本和编译时间，烧录后可直接确认镜像新旧。

## 蓝图落地状态

已落地：

- Layered Decoupled Architecture：`app_core`、`comm_stats`、`health_reporter`、`ui_controller`、`uart_transport`、`router_service`、`ble_transport`、`wifi_transport`、`wifi_manager`、`web_api`、`web_static`、`http_utils` 已从 `main.c` 分离。
- Event-Driven Architecture：UART RX、WiFi WebSocket RX、BLE GATT RX 和 WiFi STA 事件均通过回调/队列进入应用层，路由层只处理完整通信帧。
- Protocol-Agnostic Abstraction：UART 上行通过 `router_service` 的 send callbacks 路由到 BLE/WiFi；BLE 和 WiFi 都以统一的 `send(data, len)` 形式暴露给路由层。
- Control/Data Plane 分离：WebSocket 数据面在 `wifi_transport.c`，BLE 数据面在 `ble_transport.c`，WiFi AP/STA 控制面在 `wifi_manager.c`，HTTP 控制入口在 `web_api.c`。

未落地：

- `app_core`：通信模式和 UART 波特率已落地；WiFi/BLE ready 和网络状态目前分布在 `system_menu`、`wifi_manager`、`ble_transport`。
- `message_bus.c`：真正统一消息总线还未引入。目前采用轻量回调式事件驱动，避免在已稳定的数据路径上一次性引入全局 Pub/Sub 风险。
- Kconfig：`CONFIG_ENABLE_BLE`、`CONFIG_ENABLE_WIFI`、`CONFIG_BLE_START_ON_BOOT` 仍是 `main.c` 顶部宏，后续可迁移到 Kconfig。

## 推荐目标架构

建议后续按三层拆分：

1. `app_core`
   - 保存全局运行状态：通信模式、UART 波特率、WiFi AP/STA 状态、BLE ready 状态。
   - 对外提供少量状态变更 API，例如 `app_set_comm_mode()`、`app_set_uart_baud()`。
   - 当前已落地通信模式和 UART 波特率，后续再迁移 WiFi/BLE ready 等状态。

2. `transport`
   - `uart_transport.c`：只负责 UART 初始化、事件读取、软件组帧。（已落地）
   - `ble_transport.c`：只负责 BLE SPP 初始化、订阅管理、MTU/notify 分片、BLE 写入回调。（已落地）
   - `wifi_transport.c`：只负责 WebSocket 连接、静态帧池、异步发送队列、WiFi 写入回调。（已落地）
   - `router_service.c`：只负责按当前模式把 UART 帧路由到 BLE 或 WiFi。（已落地）
   - `wifi_manager.c`：只负责 AP/STA 模式、STA 配网、NVS、WiFi 事件和状态快照。（已落地）

3. `control_plane`
   - `http_utils.c`：HTTP 响应头、JSON 成功响应、OPTIONS 响应等通用工具。
   - `web_api.c`：HTTP API handler、参数解析和业务调度。（已落地，包含 WiFi 配网 API）
   - `web_static.c`：SPIFFS 静态资源和 Excel 文件管理。（已落地）
   - `ui_controller.c`：菜单动作到 app_core 的转换，显示状态同步。（已落地）

这样拆分后，用户阅读时可以从 `app_main()` 看到启动顺序，从 `router.c` 看到通信主逻辑，从各 transport 文件看到具体通道实现。

## 后续性能优化优先级

1. 为 WebSocket RX 使用固定接收缓冲或分块转 UART，减少频繁 malloc。
2. 按 BLE 连接参数继续优化吞吐，例如 connection interval、PHY、Data Length Extension。
3. 将 HTTP JSON 响应统一走一个小工具函数，集中处理转义，避免 SSID/菜单文本里出现引号时破坏 JSON。
4. 基于 `comm_stats` 做更细的诊断页面，当前串口周期摘要已由 `health_reporter` 落地。
5. 将 `CONFIG_ENABLE_BLE`、`CONFIG_ENABLE_WIFI`、显示后端和 UART 参数迁移到 Kconfig，避免在源码里改宏。

## 最近构建验证

- 2026-06-30：ESP-IDF 6.0 Windows 环境构建通过。
- 生成镜像：`D:/Users/sunqi39/Desktop/wireless_debug-main/build/uart_ble_wifi.bin`
- 镜像大小：`0x123ad0`，app 分区剩余 `0x5c530`（24%）。
