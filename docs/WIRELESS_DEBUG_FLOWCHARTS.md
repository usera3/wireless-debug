# wireless_debug 程序流程图说明

本文档基于当前源码整理，入口函数 `app_main()` 位于 `main/main.c`；README 中“全部业务逻辑在 main.c”的结构说明已不是当前实际拆分状态。项目是 ESP32-S3 固件，用 UART1 与外部设备通信，并通过 BLE SPP 或 WiFi WebSocket 转发数据，同时提供 HTTP API、SPIFFS 静态页面、OLED 状态显示和电机诊断帧生成。

## 可导入流程图文件

这些文件是 Mermaid 语法，可直接导入支持 Mermaid 的流程图工具，或粘贴到 <https://mermaid.live/> 查看：

- `docs/flowcharts/01_boot_sequence.mmd`：启动初始化流程。
- `docs/flowcharts/02_data_plane.mmd`：UART/BLE/WiFi 双向透传数据流。
- `docs/flowcharts/03_wifi_ble_state.mmd`：WiFi AP/STA 和 BLE SPP 状态机。
- `docs/flowcharts/04_http_control_plane.mmd`：HTTP API、静态文件、Excel、电机诊断控制流。
- `docs/flowcharts/05_display_health_stats.mmd`：OLED 显示、菜单、统计、健康报告流。
- `docs/flowcharts/06_module_relationship.mmd`：模块关系总图。

本目录还提供 `docs/flowcharts/index.html`，在浏览器中打开即可预览启动流程和模块关系两张总览图；更详细的图请导入对应 `.mmd` 文件。

## 程序主干

启动顺序是：

1. 初始化 NVS；如果页满或版本不兼容，就擦除后重试。
2. 初始化 `app_core`，保存全局通信模式 `AUTO` 和默认 UART 波特率 `2000000`。
3. 初始化 BLE transport 配置、UI controller 配置。
4. 初始化 WiFi 网络栈。
5. 启动 `uart_transport`：UART1、TX GPIO10、RX GPIO9、32KB 驱动缓冲、64KB 软件组帧缓冲。
6. 初始化 `display_port` 和 `display_lvgl`：SSD1315 OLED 默认 SCL GPIO19、SDA GPIO20，LVGL 每 20ms 刷新。
7. 挂载 SPIFFS，初始化 `wifi_manager`，启动 AP 或 APSTA，并启动 HTTP/WebSocket server。
8. 按配置启动 BLE NimBLE SPP。
9. 启动 `health_reporter`，周期输出串口健康摘要。

启动后主函数返回，FreeRTOS 任务继续工作：UART RX 任务、WiFi 发送任务、HTTP server、NimBLE host、LVGL 刷新任务、健康报告任务和 WiFi event loop。

## 数据面

UART 上行路径：

1. 外部串口设备发送字节到 UART1。
2. `uart_transport_task` 从 UART 事件队列读取数据，追加到 64KB 组帧缓冲。
3. 遇到硬件 timeout、2ms 软件空闲超时或缓冲满，就提交完整帧。
4. `app_uart_frame_received` 先识别 AT 控制命令：`AT+HELP`、`AT+WIFI?`、`AT+WIFI=STA`、`AT+WIFI=AP`。
5. 普通数据交给 `router_service`。
6. 路由规则：当前模式为 WiFi 就发 WebSocket；当前模式为 BLE 就发 BLE Notify；AUTO/IDLE 时优先选择已连接 WebSocket，其次选择有订阅者的 BLE；都没有就丢弃并计数。

WiFi 下行路径：

1. 浏览器或上位机通过 `/ws` 发二进制帧。
2. `wifi_transport` 读取 WebSocket payload。
3. `app_wifi_frame_received` 必要时把通信模式切到 WiFi，并 flush UART 输入。
4. 调用 `uart_transport_write` 发给外部串口设备。

BLE 下行路径：

1. BLE 客户端写 SPP 特征值 `0xABF1`。
2. `ble_svc_gatt_handler` 复制数据并计数。
3. `app_ble_frame_received` 必要时把通信模式切到 BLE，并 flush UART 输入。
4. 调用 `uart_transport_write` 发给外部串口设备。

## 控制面

HTTP API 通过 `web_api_context_t` 回调回主程序和各模块，典型路径是：

`HTTP handler -> 解析/校验 JSON -> web_api_context_t 回调 -> app_core / uart_transport / wifi_manager / ble_transport / ui_controller / display_lvgl / motor_diag -> JSON 响应`

重要 API：

- `/api/uart/baud`：查询或设置 UART 波特率，范围 `1200..5000000`。
- `/api/uart/tx`：通过 HTTP 直接发送 text/hex 到 UART。
- `/api/comm/mode`：设置 `auto|wifi|ble`。
- `/api/comm/stats`：读取或清零通信统计。
- `/api/wifi/status`、`/api/wifi/sta`、`/api/wifi/mode`：WiFi 状态、STA 配网、AP/STA 切换。
- `/api/ble/status`、`/api/ble/start`、`/api/ble/tx`：BLE 状态、启动、直接 Notify 发送。
- `/api/input/key`、`/api/menu/status`：远程菜单按键和状态。
- `/api/display/text`、`/api/display/scroll`、`/api/display/status`、`/api/display/framebuffer`：OLED 文本覆盖、状态和 framebuffer。
- `/api/motor/...`：构造电机诊断、示波器和参数表相关帧，可选择直接发送到 UART 或仅返回 hex。
- `/api/excel/...`：SPIFFS 中 Excel 文件列表、上传、删除。

## 状态与容错

- `comm_stats` 统计 UART、BLE、WiFi 和 router 的收发量、丢弃、失败、队列满和溢出。
- `health_reporter` 每 30 秒或错误数变化时通过日志输出 `HEALTH OK/ALERT`。
- WiFi STA 连接 10 秒超时或断线会自动调度回 AP。
- WiFi WebSocket 发送使用 32 个静态 512B 帧槽，避免大块动态内存。
- BLE Notify 按 ATT MTU 分片；失败时会降到 20B 安全分片重试。
- OLED 初始化失败不会阻塞主程序，仍保留 framebuffer/stats 供 API 查询。
