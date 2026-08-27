# Wireless Debug Node-RED Cloud Console

这是给公司内部调试人员使用的云端多设备观测台。它使用 Node-RED 接入 MQTT，使用 PostgreSQL 保存设备状态、历史事件、命令回执和备注。

## Scope

云端只做观测和低风险诊断：

- 查看多设备在线、疑似离线、离线状态。
- 查看网络模式、AP IP、STA IP、STA 连接状态、UART 波特率、固件版本。
- 保存设备备注，方便区分样机和现场设备。
- 发送安全诊断命令 `query_status`。
- 记录 `status`、`availability`、`ack` 历史。

云端不提供 AP/STA/APSTA 远程切换，不提供网页配网、清除 WiFi、修改 MQTT 地址、OTA、重启等可能让设备失联的功能。

## MQTT Topics

ESP32 上报：

```text
wireless-debug/{deviceId}/status
wireless-debug/{deviceId}/availability
wireless-debug/{deviceId}/ack
```

云端下发：

```text
wireless-debug/{deviceId}/cmd
```

第一版只下发：

```json
{"type":"query_status","args":{}}
```

## Ubuntu Deployment

在 Ubuntu 云服务器安装 Docker 和 Docker Compose 插件后：

```bash
cd tools/remote_mqtt_nodered
cp .env.example .env
```

编辑 `.env`，至少修改：

```text
POSTGRES_PASSWORD
NODE_RED_CREDENTIAL_SECRET
```

如果 Docker Hub 拉取慢，可以在 `.env` 里替换镜像来源，不需要改 compose：

```text
POSTGRES_IMAGE=postgres:18-alpine
MOSQUITTO_IMAGE=eclipse-mosquitto:2
NODERED_BASE_IMAGE=nodered/node-red:latest
NPM_REGISTRY=
```

本机已有这些镜像时会直接复用。云服务器如果走公司镜像仓库或云厂商同步仓库，把这三项改成对应的完整镜像名即可。
如果构建 Node-RED 时安装 `pg` 很慢，可以设置 npm 镜像，例如：

```text
NPM_REGISTRY=https://registry.npmmirror.com
```

启动：

```bash
docker compose up -d
```

打开：

```text
http://<server-ip>:1880/cloud
```

云服务器安全组需要放行：

```text
1883/tcp  MQTT
1880/tcp  Node-RED cloud UI
```

生产网络中建议把 1880 放到 Nginx/内网/VPN 后面。Node-RED HTTP Basic Auth 可选配置：

```bash
docker compose run --rm nodered node-red admin hash-pw
```

把生成的 bcrypt hash 填入 `.env`：

```text
CLOUD_HTTP_USER=debug
CLOUD_HTTP_PASSWORD_HASH=<bcrypt-hash>
```

然后重启：

```bash
docker compose up -d
```

## Database

PostgreSQL 会通过 `postgres/init/001_schema.sql` 初始化：

- `devices`: 最新设备状态。
- `device_status_events`: status、availability、ack 历史事件。
- `device_commands`: 云端发出的安全诊断命令和 ack 结果。
- `device_notes`: 内部人员备注历史。

数据保存在 Docker volume `pgdata` 中，重启容器不会丢失。

## Local Test

启动后可以用现有 Mosquitto 工具模拟设备：

```bash
docker compose exec mosquitto mosquitto_pub -h localhost -t wireless-debug/demo-001/availability -m online -q 1
docker compose exec mosquitto mosquitto_pub -h localhost -t wireless-debug/demo-001/status -m '{"net_mode":"apsta","ap_ip":"192.168.4.1","sta_ip":"10.0.0.23","sta_connected":true,"uart_baud":2000000,"fw":"demo"}' -q 1
```

然后打开：

```text
http://localhost:1880/cloud
```

## Stop

```bash
docker compose down
```

保留数据库数据。若要清空：

```bash
docker compose down -v
```
