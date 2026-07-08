# 云电脑开发和本地烧录流程

本文档记录当前项目的推荐协作方式：云电脑负责日常改代码和提交，本地电脑负责拉取、构建、烧录和连板验证。

云电脑上使用 VS Code/Codex 时，先读：

```text
docs/CLOUD_CODEX_USAGE.md
```

## 仓库和分支

固件仓库：

```text
https://git.midea.com/DEP-MITBG/dep-mt/public-group/wireless_debug.git
```

当前稳定开发分支：

```text
stable-osc-ui-20260707
```

本地默认远端名：

```text
midea
```

以后如果只说“推送到远端”，默认就是推到上面的 Midea Git 仓库。当前这套固件以 `stable-osc-ui-20260707` 分支作为主要同步位置。

## 云电脑开发

第一次在云电脑上准备工程：

```bash
git clone https://git.midea.com/DEP-MITBG/dep-mt/public-group/wireless_debug.git
cd wireless_debug
git checkout stable-osc-ui-20260707
```

每次开始改代码前：

```bash
git checkout stable-osc-ui-20260707
git pull --ff-only origin stable-osc-ui-20260707
```

改完后先看改动：

```bash
git status
git diff
```

提交并推送：

```bash
git add README.md docs main dist scripts
git commit -m "描述这次改动"
git push origin HEAD:stable-osc-ui-20260707
```

如果云电脑的远端名不是 `origin`，用 `git remote -v` 先确认实际名称。

## 本地电脑同步

本地工程路径：

```text
D:\Users\sunqi39\Desktop\wireless_debug-main
```

从本地电脑拉取云电脑提交：

```bash
git fetch midea
git checkout stable-osc-ui-20260707
git pull --ff-only midea stable-osc-ui-20260707
```

如果本地还停在 `main` 分支，也可以直接重置到远端稳定分支。这个命令会覆盖本地未提交修改，执行前必须确认 `git status` 是干净的：

```bash
git fetch midea
git checkout -B stable-osc-ui-20260707 midea/stable-osc-ui-20260707
```

## 构建

本地电脑使用 ESP-IDF 6.0。推荐在 WSL/Codex 中调用 Windows ESP-IDF 环境：

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

构建成功时会看到：

```text
Project build complete.
Generated D:/Users/sunqi39/Desktop/wireless_debug-main/build/uart_ble_wifi.bin
```

## 烧录

在 Windows ESP-IDF 终端中进入工程目录，然后烧录：

```bash
idf.py -p PORT flash
```

也可以使用构建输出中的 `build/flash_args`：

```bash
cd D:\Users\sunqi39\Desktop\wireless_debug-main\build
python -m esptool --chip esp32s3 -b 460800 --before default-reset --after hard-reset write-flash "@flash_args"
```

这块开发板没有自动下载电路。烧录时需要按板子的下载方式插好 bootloader 跳线帽；烧录完成后要拔掉 bootloader 跳线帽，再按复位，让应用正常启动。

## 烧录后检查

设备启动后连接 ESP32 热点，打开：

```text
http://192.168.4.1/orig/i.html
```

WiFi 配网页面：

```text
http://192.168.4.1/wifi.html
```

OLED 当前硬件配置：

```text
SCL GPIO19
SDA GPIO20
I2C address 0x3C
S4 GPIO17
S5 GPIO18
```

如果网页打不开，先确认电脑是否还连在 ESP32 热点上。WiFi 扫描或 STA 连接时，ESP32 热点可能短暂不可用，重新连回热点后页面会继续刷新。

## Remote MQTT MVP

远程访问 MVP 位于：

```text
tools/remote_mqtt/
```

本地验证使用 Docker Compose：

```bash
cd tools/remote_mqtt
docker compose up
```

浏览器打开：

```text
http://localhost:3000
```

ESP32 实机测试时，把固件 MQTT URI 设置为电脑局域网地址：

```text
mqtt://<PC_LAN_IP>:1883
```

后续部署到 Ubuntu 云服务器时，把 `tools/remote_mqtt/` 复制到服务器，运行 `docker compose up -d`，开放 `1883` 和 `3000` 端口，再把固件 MQTT URI 改成云服务器 IP 或域名。

## 前端静态资源

主 Web UI 的源码通常在另一个仓库：

```text
D:\Users\sunqi39\Desktop\wireless_debug_web
```

如果改了 React 前端，需要先构建前端，再把生成文件同步到固件仓库的：

```text
dist/orig/
```

`dist/index.html` 保持为跳转入口，主页面固定为：

```text
/orig/i.html
```

同步静态资源后必须重新构建固件，这样 SPIFFS 镜像才会包含新页面。

## 提交前检查

至少跑这几项：

```bash
node scripts/wifi_page_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
node scripts/wifi_scan_timing_regression.mjs
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

如果改的是网页示波器，还要在浏览器里实际打开 `http://192.168.4.1/orig/i.html`，检查通道显示、暂停、拖动、缩放、跳到最新和参数表加载。

## 常见问题

`git pull --ff-only` 失败：

说明本地和远端都有新提交。先不要强推，运行 `git status` 和 `git log --oneline --graph --decorate --all -20` 看分叉情况。

构建提示找不到 ESP-IDF：

确认本地路径是：

```text
C:\esp\v6.0\esp-idf
```

烧录后屏幕不亮：

先确认 bootloader 跳线帽已经拔掉并按过复位。再检查 OLED 线序是否是 SCL GPIO19、SDA GPIO20。

WiFi 扫描时网页断开：

这是 ESP32-S3 单 WiFi 射频在 APSTA 模式下的正常限制。当前页面会等待热点恢复，并显示扫描耗时。扫描完成后重新连回 ESP32 热点即可继续操作。
