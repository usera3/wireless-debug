# 云电脑 Codex 使用说明

这份说明给云电脑上的 VS Code/Codex 使用。云电脑主要负责改代码、写文档、提交和推送；本地电脑负责拉取、构建、烧录和连板验证。

## 第一次打开仓库

在云电脑上克隆固件仓库：

```bash
git clone https://git.midea.com/DEP-MITBG/dep-mt/public-group/wireless_debug.git
cd wireless_debug
git checkout stable-osc-ui-20260707
```

如果仓库已经存在，每次开工前先更新：

```bash
git checkout stable-osc-ui-20260707
git pull --ff-only origin stable-osc-ui-20260707
```

打开 VS Code 时，工作区根目录应当是仓库根目录，也就是能看到 `README.md`、`main/`、`dist/`、`docs/`、`scripts/` 的那一层。

## 给 Codex 的开场提示

每次在云电脑新开 Codex 会话，可以先把下面这段发给 Codex：

```text
这是 wireless_debug 固件仓库。请先阅读 README.md、docs/CLOUD_LOCAL_WORKFLOW.md、docs/CLOUD_CODEX_USAGE.md。

当前主要开发分支是 stable-osc-ui-20260707，远端仓库是：
https://git.midea.com/DEP-MITBG/dep-mt/public-group/wireless_debug.git

本项目是 ESP32-S3 + ESP-IDF 6.0 固件。主页面是 /orig/i.html，WiFi 配网页面是 /wifi.html。OLED 是 SSD1315 128x64，SCL GPIO19，SDA GPIO20，S4 GPIO17，S5 GPIO18。

云电脑不直接烧录设备。修改完成后请提交并推送到 stable-osc-ui-20260707；本地电脑会拉取后构建、烧录、实测。

做代码改动前先看现有结构，优先保持 main/ 里的模块边界：
app_core、uart_transport、router_service、wifi_transport、wifi_manager、ble_transport、web_api、web_static、ui_controller、display_*、system_menu、input_buttons、comm_stats、health_reporter。

不要把账号、密码、token 写进仓库。不要随意改 OLED 引脚、UART 引脚、分区表和网页入口。需要改这些内容时先说明原因。

如果改了 dist/orig/ 的 Web UI 静态资源，要说明它来自哪个前端构建。改完至少运行相关脚本；如果云电脑没有 ESP-IDF 环境，不要说固件构建通过，只说明未在云电脑构建，交给本地电脑验证。
```

## Codex 做事前先检查

让 Codex 先跑：

```bash
git status --short
git branch --show-current
git log --oneline --decorate -5
```

正常情况下应当在：

```text
stable-osc-ui-20260707
```

如果云电脑因为某些原因在 `main` 分支，也可以推送到远端稳定分支，但提交前要说清楚：

```bash
git push origin HEAD:refs/heads/stable-osc-ui-20260707
```

不要在有未确认改动时执行 `git reset --hard`、`git checkout -- .` 这类命令。

## 常见任务怎么交给 Codex

修固件问题时，说清楚现象、入口和期望结果。例如：

```text
修一下 /wifi.html 扫描后状态提示不清楚的问题。先查 main/web_api.c、main/wifi_manager.c、dist/wifi.html，再改代码。需要加回归脚本。
```

改 OLED 菜单时，提醒 Codex：

```text
OLED 只有 128x64。每页只显示同级菜单，不要把父菜单和子菜单放在同一页。长文本用单行裁剪和横向滚动。
```

改网页示波器时，提醒 Codex：

```text
示波器要保留暂停、拖动、鼠标滚轮缩放、跳到最新、隐藏通道后 Y 轴自适应。隐藏通道不能在缩放后自动恢复显示。
```

改前端静态资源时，提醒 Codex：

```text
主 Web UI 源码通常在 D:\Users\sunqi39\Desktop\wireless_debug_web。构建后同步到固件仓库 dist/orig/，再提交固件仓库。
```

写文档时，提醒 Codex：

```text
文档写成工程操作手册，不写空话，不写心理描写，不写 AI 生成痕迹。命令、路径、分支、注意事项要明确。
```

## 云电脑能跑的检查

如果云电脑装了 Node，可以跑：

```bash
node scripts/wifi_page_regression.mjs
node scripts/wifi_scan_restore_regression.mjs
node scripts/wifi_scan_timing_regression.mjs
git diff --check
```

如果云电脑也装了 ESP-IDF 6.0，可以跑：

```bash
idf.py build
```

如果云电脑没有 ESP-IDF，不要让 Codex 编造构建结果。提交说明里写清楚：

```text
云电脑未运行 ESP-IDF 构建；需本地电脑拉取后构建烧录验证。
```

## 提交和推送

提交前先看 diff：

```bash
git status --short
git diff
```

如果改动合理：

```bash
git add README.md docs main dist scripts
git commit -m "简短说明这次改动"
git push origin HEAD:refs/heads/stable-osc-ui-20260707
```

如果远端名不是 `origin`：

```bash
git remote -v
git push <远端名> HEAD:refs/heads/stable-osc-ui-20260707
```

这个仓库有同名 tag `stable-osc-ui-20260707`。只有在明确需要让 GitLab 的同名 tag 也指向新稳定版本时，才更新 tag：

```bash
git tag -f -a stable-osc-ui-20260707 -m "Stable osc UI 20260707" HEAD
git push --force origin refs/tags/stable-osc-ui-20260707
```

平时只推分支即可。

## 本地电脑接手

云电脑推送后，本地电脑执行：

```bash
cd D:\Users\sunqi39\Desktop\wireless_debug-main
git fetch midea
git checkout stable-osc-ui-20260707
git pull --ff-only midea stable-osc-ui-20260707
```

然后本地构建：

```bash
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\wireless_debug-main && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

烧录后记得拔掉 bootloader 跳线帽并按复位。

## 需要特别小心的地方

- `dist/orig/` 是烧进 SPIFFS 的 Web UI 静态资源。只改前端源码但不同步这里，本地烧录后看不到新页面。
- `dist/wifi.html` 是独立 WiFi 配网页，不在 React 主前端里。
- `/orig/i.html` 是主页面入口，不要改回 `/index.html`。
- WiFi 扫描或 STA 连接会让 ESP32 AP 短暂不可用。页面要给用户明确提示，不要只显示 `Failed to fetch`。
- AP 逻辑状态下底层 WiFi 保持 `WIFI_MODE_APSTA`，这是为了减少扫描前切模式导致的 AP 抖动。
- 当前屏幕引脚是 SCL GPIO19、SDA GPIO20，不要按旧板子的 GPIO5/GPIO4 改回去。
- 这块板子没有自动下载电路。烧录流程要考虑 bootloader 跳线帽。
