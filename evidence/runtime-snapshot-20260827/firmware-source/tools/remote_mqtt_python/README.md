# Wireless Debug Python Cloud Console

这是 Python 版云端多设备观测台，先用于公司内部调试演示。它用 Flask 提供页面和 API，用 paho-mqtt 接入 MQTT，用 PostgreSQL 保存设备状态、历史事件、命令回执和备注。

## 功能边界

提供：

- 多设备在线、离线、未知状态查看。
- 网络模式、AP IP、STA IP、STA 连接状态、UART 波特率、固件版本查看。
- 设备备注。
- 安全诊断命令 `query_status`。
- 消息中心：云平台向指定设备发送 `notify` 消息，设备通过 inbox 接收并回 `bus-ack`。
- 订阅机制基础表和 API：设备后续可向云端 `pub`，云端按订阅关系转发给其他设备或云平台。
- `status`、`availability`、`ack` 历史记录。

不提供 AP/STA/APSTA 远程切换，不提供网页配网、清除 WiFi、修改 MQTT 地址、OTA、重启等可能让设备失联的功能。消息中心第一版只开放 `notify`，不远程写 UART/BLE/WebSocket。

## 本机运行

默认使用本机已经存在的 Mosquitto `127.0.0.1:1883` 和 PostgreSQL `127.0.0.1:5432`：

```bash
cd tools/remote_mqtt_python
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

如果 pip 慢，可以换源：

```bash
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

打开：

```text
http://localhost:18088/cloud
```

## 配置

常用环境变量：

```text
APP_PORT=18088
DATABASE_URL=postgresql://wireless_debug:wireless_debug@127.0.0.1:5432/wireless_debug
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_NAMESPACE=wireless-debug
CLOUD_HTTP_USER=
CLOUD_HTTP_PASSWORD=
CLOUD_SESSION_SECRET=
CLOUD_WS_PORT=18089
CLOUD_WS_PUBLIC_URL=
CLOUD_WS_BROWSER_QUEUE_FRAMES=16
```

设置 `CLOUD_HTTP_USER` 和 `CLOUD_HTTP_PASSWORD` 后会启用云端登录页。登录成功后服务端写入签名 Session Cookie；未登录访问云端页面、远程设备页面和控制接口时会跳转到 `/login` 或返回 401 JSON。`CLOUD_SESSION_SECRET` 可选，用于固定 Session 签名密钥。

云端版 ESP32 原网页使用浏览器到云平台的 WebSocket，再由云平台桥接 MQTT 到 ESP32。默认 WebSocket 地址自动按访问主机生成，端口为 `CLOUD_WS_PORT`。如果前面有 Nginx 或 HTTPS 代理，可以设置 `CLOUD_WS_PUBLIC_URL`，例如：

```text
CLOUD_WS_PUBLIC_URL=wss://example.com
```

每个浏览器连接使用独立的有界实时发送队列。`CLOUD_WS_BROWSER_QUEUE_FRAMES` 控制队列深度；慢客户端队列满时丢弃最旧波形帧，避免拖慢同设备的其他浏览器和 ESP32 上行连接。

### Unified React frontend

The cloud service serves the same Vite + React bundle used by ESP32 local mode.

- `/cloud.html` runs the bundle in `cloud-platform` mode.
- `/remote/<device_id>/orig/i.html` runs the bundle in `cloud-device` mode.
- `/legacy-cloud.html` is kept temporarily for rollback during the migration.

Build assets in `wireless_debug_web` with `npm run build:firmware-assets`, then deploy the updated `dist/orig` directory with the cloud service.

## MQTT Topics

ESP32 上报：

```text
wireless-debug/{deviceId}/status
wireless-debug/{deviceId}/availability
wireless-debug/{deviceId}/ack
wireless-debug/{deviceId}/pub
wireless-debug/{deviceId}/bus-ack
```

云端下发：

```text
wireless-debug/{deviceId}/cmd
wireless-debug/{deviceId}/inbox
```

安全诊断下发：

```json
{"type":"query_status","args":{}}
```

消息中心下发：

```json
{"message_id":"bus-...","source_type":"cloud","source_id":"cloud","target_type":"device","target_id":"ESP32-001","channel":"notify","payload_type":"text","payload_text":"hello","payload":"hello","ttl":1}
```

## Docker Compose 部署

Ubuntu 云服务器安装 Docker 和 Docker Compose 插件后：

```bash
cd tools/remote_mqtt_python
cp .env.example .env
```

编辑 `.env`，至少修改：

```text
POSTGRES_PASSWORD
```

启动：

```bash
docker compose up -d --build
```

打开：

```text
http://<server-ip>:18088/cloud
```

如果服务器 pip 或 Docker Hub 慢，可以在 `.env` 里设置：

```text
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
POSTGRES_IMAGE=postgres:18-alpine
MOSQUITTO_IMAGE=eclipse-mosquitto:2
PYTHON_IMAGE=python:3.12-slim
```

云服务器安全组需要放行：

```text
18088/tcp  Python cloud UI
18089/tcp  Cloud WebSocket bridge
1883/tcp   MQTT
```

生产网络中建议把 `18088` 放到 Nginx、内网或 VPN 后面。
