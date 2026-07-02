# wireless_debug

基于 **ESP32-S3** 的 UART ↔ BLE / WiFi 双向透传固件，支持通过 BLE（NimBLE SPP）或 WiFi（WebSocket）与上位机进行实时串口数据转发，并内置 Web 界面用于数据可视化与文件管理。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **UART 透传** | UART1，默认波特率 2 Mbps，TX=GPIO10，RX=GPIO9 |
| **BLE SPP 服务** | 基于 NimBLE，自定义 UUID `0xABF0/0xABF1`，支持 Notify 推送 |
| **WiFi AP 模式** | SSID 自动生成为 `ESP32-S3_AP_XXXX`，密码 `12345678` |
| **WebSocket 服务** | `ws://192.168.4.1/ws`，二进制帧双向透传 |
| **Web 界面** | 静态页面托管于 SPIFFS，访问 `http://192.168.4.1` |
| **Excel 文件管理** | 支持通过 HTTP API 上传 / 列举 / 删除 Excel 文件 |
| **动态波特率** | 运行时通过 HTTP API 热更新 UART 波特率，无需重启 |
| **双模自动切换** | BLE 与 WiFi 同时启用时，根据最后活跃连接自动切换数据通路 |
| **虚拟显示端口** | 无屏阶段默认使用轻量虚拟屏，验证显示/状态代码是否被触发 |
| **条件编译** | 可独立开关 BLE / WiFi，至少启用其中一个 |

---

## 硬件要求

- **芯片**：ESP32-S3
- **开发框架**：ESP-IDF 6.0.0
- **Flash 大小**：8MB（默认分区占用约 1.6 MB App + 6.5 MB SPIFFS）

---

## 引脚定义

| 信号 | GPIO | 说明 |
|------|------|------|
| UART TX | GPIO 10 | 内部上拉，发送至外设 |
| UART RX | GPIO 9  | 内部上拉，从外设接收 |
| SSD1315 OLED SCL | GPIO 19 | 原理图 P6 候选屏幕接口，默认仅虚拟显示 |
| SSD1315 OLED SDA | GPIO 20 | 原理图 P6 候选屏幕接口，默认仅虚拟显示 |

> UART 外设编号为 `UART_NUM_1`。

---

## 软件依赖

项目基于 ESP-IDF 构建，所需组件均为 IDF 内置：

- `nvs_flash`
- `esp_driver_uart` / `esp_driver_gpio`
- `bt` + `nimble_peripheral_utils`（NimBLE BLE 栈）
- `esp_wifi` / `esp_http_server`
- `spiffs`

---

## 项目结构

```
uart_ble_wifi/
├── main/
│   ├── main.c               # 全部业务逻辑（UART、BLE、WiFi）
│   ├── ble_spp_server.h     # BLE SPP 服务 UUID 定义
│   └── CMakeLists.txt       # 组件注册 & SPIFFS 镜像生成
├── dist/                    # 前端构建产物，烧录到 SPIFFS
│   ├── index.html
│   └── assets/
├── partitions.csv           # 自定义分区表
├── CMakeLists.txt           # 顶层 CMake
└── sdkconfig                # IDF 配置快照
```

---

## 编译配置

在 `main/main.c` 顶部通过宏开关控制功能：

```c
#define CONFIG_ENABLE_BLE  1   /* BLE 功能开关：1=开启, 0=关闭 */
#define CONFIG_ENABLE_WIFI 1   /* WiFi 功能开关：1=开启, 0=关闭 */
```

| `BLE` | `WiFi` | 工作模式 |
|:---:|:---:|------|
| 1 | 0 | 纯 BLE 透传 |
| 0 | 1 | 纯 WiFi 透传 |
| 1 | 1 | 双模，最后活跃连接优先 |

> **注意**：两者不可同时为 0，否则编译报错。

### 其他可调参数（`main.c`）

| 宏 | 默认值 | 说明 |
|----|--------|------|
| `UART_BAUD_RATE` | `2000000` | UART 波特率（bps） |
| `UART_BUF_SIZE` | `32 KB` | UART 驱动环形缓冲区 |
| `UART_ASSEMBLE_BUF_SIZE` | `64 KB` | 帧组装缓冲区 |
| `UART_FRAME_IDLE_MS` | `2 ms` | 帧间隔超时（软件帧结束判定） |
| `WIFI_PASS` | `12345678` | WiFi AP 密码 |
| `WIFI_CHANNEL` | `1` | WiFi 信道 |
| `MAX_STA_CONN` | `4` | WiFi 最大连接客户端数 |
| `FRAME_MAX_LEN` | `512 B` | 单帧最大字节数 |
| `FRAME_POOL_SIZE` | `32` | 静态帧池槽位数 |
| `EXCEL_MAX_SIZE` | `512 KB` | 单个 Excel 文件大小上限 |

### 显示端口配置

项目新增了 `main/display_port.c` 和 `main/display_port.h`，默认启用轻量虚拟显示后端：

```c
#define CONFIG_ENABLE_DISPLAY 1
#define CONFIG_DISPLAY_BACKEND_VIRTUAL 1
#define CONFIG_DISPLAY_BACKEND_SSD1315 0
#define DISPLAY_WIDTH 128
#define DISPLAY_HEIGHT 64
#define DISPLAY_SSD1315_SCL_GPIO 19
#define DISPLAY_SSD1315_SDA_GPIO 20
#define DISPLAY_SSD1315_I2C_ADDR 0x3C
```

虚拟后端不会初始化 I2C，也不会占用 P6 屏幕引脚，只记录刷新次数、刷新区域、当前状态，方便无屏阶段验证显示相关代码是否生效。

原理图上 P6 更像 SSD1315 OLED 的 4Pin 接口，目前按 `GPIO19/GPIO20 + 3.3V + GND` 预留。等屏幕到手后，把 `CONFIG_DISPLAY_BACKEND_SSD1315` 改为 `1` 即可启用轻量 I2C SSD1315 后端；如实测 SCL/SDA 与图纸相反，只需要互换 `DISPLAY_SSD1315_SCL_GPIO` 和 `DISPLAY_SSD1315_SDA_GPIO`。后端未引入 LVGL/u8g2，避免明显增加固件体积和运行负担。

---

## 分区表

| 名称 | 类型 | 偏移 | 大小 | 用途 |
|------|------|------|------|------|
| `nvs` | data/nvs | 0x9000 | 24 KB | NVS 存储 |
| `phy_init` | data/phy | 0xF000 | 4 KB | PHY 校准 |
| `factory` | app/factory | 0x10000 | 1.5 MB | 应用固件 |
| `storage` | data/spiffs | 0x190000 | 6.4 MB | Web 静态资源 & Excel 文件 |

---

## HTTP API 接口

> 基地址：`http://192.168.4.1`

### WebSocket

| 端点 | 协议 | 说明 |
|------|------|------|
| `/ws` | WebSocket | 二进制双向透传，连接后自动切换至 WiFi 模式 |

### 静态资源

| 端点 | 方法 | 说明 |
|------|------|------|
| `/*` | GET | 从 SPIFFS 读取并返回 Web 静态文件 |

### Excel 文件管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/excel/list` | GET | 返回 Excel 文件列表（JSON 数组） |
| `/api/excel/upload` | POST | 上传文件，Header `X-Filename` 指定文件名 |
| `/api/excel/upload` | OPTIONS | CORS 预检（浏览器自动发起） |
| `/api/excel/delete?name=<文件名>` | DELETE | 删除指定 Excel 文件 |

### UART 波特率

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/uart/baud` | GET | 查询当前波特率，响应 `{"baud": 2000000}` |
| `/api/uart/baud` | POST | 修改波特率，Body `{"baud": 115200}`，范围 1200 ~ 5000000 bps |
| `/api/uart/baud` | OPTIONS | CORS 预检（浏览器自动发起） |

### 显示端口状态

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/display/status` | GET | 查询虚拟/真实显示后端状态、刷新次数、最后刷新区域 |

响应示例：

```json
{
  "enabled": true,
  "backend": "virtual",
  "status": "mode_wifi",
  "width": 128,
  "height": 64,
  "scl_gpio": 19,
  "sda_gpio": 20,
  "i2c_addr": "0x3c",
  "flush_count": 3,
  "status_update_count": 2,
  "last_flush_bytes": 256,
  "last_area": {"x1": 0, "y1": 0, "x2": 127, "y2": 15}
}
```
