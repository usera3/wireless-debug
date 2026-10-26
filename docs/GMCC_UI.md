# GMCC · 设备调试台

## 本次修改

Logo 为 GMCC，产品名称为设备调试台。本地设备、云端设备和云端设备列表共用深蓝侧栏、浅灰底色、白色卡片与青色操作按钮。

设备页保留仪表盘、地址示波器、参数示波器、参数编辑、固件烧录和连接设置。云端未选择设备时默认显示设备列表，设备操作导航禁用；点击控制台入口后沿用 `/remote/<device-id>/orig/i.html`，重载并初始化对应设备连接。远程控制台中的设备列表标签保留当前设备上下文，退出登录位于共享页头。目录仅保留搜索筛选、刷新和连接入口，不恢复统计、诊断、备注、消息、历史、能力或设置栏目。后端接口、历史数据、通信协议、状态存储、参数地址和固件控制逻辑不变。

云端 Flask 服务以 `/index.html` 为正式入口，并注入 `cloud-platform` 运行模式。`/`、`/cloud`、`/cloud.html` 重定向到此入口，查询参数保留，浏览器沿用 URL 片段。身份校验和旧远程设备地址保持兼容。远程目录使用 `/platform/api/devices`，避免 `/api/*` 的设备代理重写；云端主页使用 `/api/devices`。目录标签离开时停止自身轮询。本地 ESP32 `/index.html` 和 `/orig/i.html` 保留直连模式，不显示设备目录及退出登录，不轮询云端目录；固件 `dist/index.html` 的设备页重定向不变。

## 版本

| 项目 | 起始提交 | 本地分支 |
| --- | --- | --- |
| 云平台及前端 | `5ddbefe` | `feature/gmcc-style-ui` |
| USB 固件及前端 | `9df4761` | `feature/gmcc-style-ui` |

原工作目录保持不变，改动位于各仓库的 `.worktrees/gmcc-style-ui`。

## 本地预览

在任一新工作目录的 `frontend` 文件夹打开终端：

```sh
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port 5688 --strictPort
```

- 设备页：<http://127.0.0.1:5688/index.html>
- 云平台：<http://127.0.0.1:5688/cloud>

此命令只启动静态网页。未连接后台或设备时，页面显示未连接或接口请求失败；实际数据和操作需接入原后台与设备。

静态预览的 `/index.html` 是本地设备入口，`/cloud` 可预览统一侧栏内的设备列表。正式云端 `/index.html` 的列表模式由 Flask 注入，静态预览不会模拟该注入。备用 `/legacy-cloud.html` 仍作为应急入口。

## 验证

- 两套 React 前端分别构建通过。
- 设备页在本地、云端设备两种入口下，分别验证 1440×1024、1024×768、390×844，共 36 项页面/尺寸组合。
- 验证导航、XLSX 参数表导入与搜索、参数表选择弹窗、CSV 波形导入、手机端停止按钮触控区域。
- 云平台验证设备搜索、在线/离线/未知状态筛选、控制台链接、退出登录、刷新、空列表、请求失败和未登录跳转；确认不再请求详情、历史及消息接口。
- 登录页验证表单、密码显隐、错误信息转义和跳转参数；加载失败页与备用云平台页完成浏览器检查。
- 网页资源打包回归通过，8 个产物及 gzip 内容一致。
- USB 固件 ESP-IDF 6.0 构建通过，生成 `build/uart_ble_wifi.bin` 和 `build/storage.bin`。应用镜像 0x1a91b0 字节，应用分区剩余 34%；网页资源写入 0x570000 字节 SPIFFS 分区。
- 首次并行构建遇到 ldgen 解析错误；原参数独立复测通过，随后 `ninja -C build -j1` 增量构建完成，未修改 SDK 或固件控制源码。
- 本次测试使用本机 HTTP 测试数据，未连接真实设备，未部署云端、未烧录、未推送 Git。

浏览器测试在 `frontend` 目录运行：

```sh
node scripts/console-ui-playwright.mjs
node scripts/unified-site-smoke.mjs
python3 scripts/backend-entry-regression.py
```

脚本使用现有 Playwright 环境；其他电脑可通过 `PLAYWRIGHT_MODULE` 指定已安装 Playwright 的 `index.js` 绝对路径。截图目录分别由 `CONSOLE_SCREENSHOTS` 和 `CLOUD_SCREENSHOTS` 指定。

统一入口浏览器测试和后端入口测试还需要 Python 3 与 Flask（已有云端依赖）。测试通过 AST 抽取当前仓库真实 Flask 入口、身份校验和远程重写函数，在隔离环境验证，既不导入启动 MQTT/数据库的模块顶层，也不连接外部服务。浏览器测试覆盖三种尺寸的共享布局、未选设备禁用操作、目录→设备→目录→另一设备、连接目标保持与新设备重置、生产重写脚本、查询参数/片段、错误/空列表/未登录、XSS 安全链接，以及本地页面等待超过一次轮询周期后仍无目录请求。

统一入口更新已分别通过两端前端构建与上述浏览器测试、运行模式、云端组件/API、连接面板、HTML 外壳及后端入口测试；两端共享源码和生成网页内容一致。独立验证完成 ESP-IDF 6.0 `ninja -C build -j1` 增量打包（5/5 步，重新生成 `storage.bin`），应用镜像仍为 `0x1a91b0`、应用分区剩余 34%，bootloader `0x5240`、分区剩余 36%；固件网页资源回归 4/4 通过。未修改固件控制源码、SDK 配置或本地入口重定向。本次无云端部署、推送或硬件烧录。

## 固件网页资源

USB 固件仓库在项目根目录运行：

```sh
node scripts/prepare_web_assets.mjs
```

云平台单仓库在项目根目录运行：

```sh
python scripts/prepare_web_assets.py
```

前者生成 `dist/orig`，后者生成 `firmware/dist/orig`。均将构建入口映射为 `i.html`，不改变设备页面地址。
