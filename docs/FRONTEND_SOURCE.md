# USB 网络修复版的前端源码

## 代码版本

| 部分 | 来源仓库与分支 | 提交 |
| --- | --- | --- |
| ESP32-S3 固件基线 | `wireless_debug`，`fix/usb-dhcp-recovery` | `9d1900a96626fdf101515e116b8ea4a6674cc16e` |
| 配套 React 工程 | `wireless_debug_web`，`feature/team-monorepo-usb-wifi` | `5ddbefe801d68cb8eae9e89427eea4b7be07e4a1` |

前端来源仓库：`https://git.midea.com/DEP-MITBG/dep-mt/public-group/wireless_debug_web.git`。

本次将上述前端的 `frontend/src/`、依赖锁文件、Vite/TypeScript 配置、协议参考、模拟服务及测试脚本纳入本仓库。共恢复 79 个 `src/` 文件，导入来源的源码树为 `7990cda1e01aae8ad98e9d22507e90006e7427f1`。只清理了 `DashboardPage.tsx` 中两处空行的行尾空格，以及协议参考文件中三处行尾空格，未调整前端业务逻辑。固件的 USB 网络、DHCP 恢复、引脚和分区配置保持基线内容。

生产构建中原 `.env.production` 的 `VITE_WS_URL=ws://192.168.4.1/ws` 移入 Vite 默认配置；无需提交环境文件。已有本地 `VITE_WS_URL` 配置仍可覆盖该默认值。开发模式保留原来的地址选择行为。

根目录 `.gitattributes` 将设备网页的 HTML、JS、CSS 固定为 LF 换行，避免 Windows Git 检出时将原始文件转成 CRLF，导致它们与 gzip 解压内容不一致。

## 目录

```text
wireless_debug-main/
├── frontend/
│   ├── src/                    React 页面、状态管理与通信协议
│   ├── scripts/                前端回归脚本
│   ├── mock-server/            本地软件模拟服务
│   ├── fixtures/               波形回放测试数据
│   ├── reference/              协议说明、参数表示例及 MCU 协议参考
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.ts
├── scripts/
│   └── prepare_web_assets.mjs  网页资源校验、入口改名和复制
├── dist/                       ESP-IDF SPIFFS 的输入
│   ├── index.html
│   ├── wifi.html
│   └── orig/                   配套网页构建结果
├── main/                       ESP32-S3 固件
└── CMakeLists.txt
```

## Windows 操作

使用 Node.js 22.x，至少为 22.13.0。在 VS Code 打开包含本目录结构的固件工程后，在 CMD 进入 `frontend`：

```text
cd frontend
npm ci
npm run dev -- --host 127.0.0.1 --port 5679
```

在浏览器打开 `http://127.0.0.1:5679/index.html`。结束预览时按 Ctrl+C。需要模拟下位机时，另开 CMD 并在 `frontend` 执行 `node mock-server/server.mjs`。

修改网页后生成固件资源：

```text
npm run build:firmware-assets
```

命令不依赖额外安装 Python。它先执行 TypeScript/Vite 构建，再检查 HTML、JS、CSS 与各自 gzip 的内容是否配对。校验通过后，用新资源替换根目录 `dist/orig`，原有其他网页不变。临时目录位于 SPIFFS 输入之外，不会被烧入设备。

然后进入固件根目录，加载实际安装位置的 ESP-IDF 6.0 环境：

```text
cd ..
call C:\esp\v6.0\esp-idf\export.bat
idf.py reconfigure
```

首次下载组件后，按根目录 README 的 Build 一节应用 WebSocket 补丁，再执行 `ninja -C build -j4`。编译成功后，按主板实际串口烧录；本次源码补齐工作不包含硬件烧录。

## 检查与提交

- `npm run test:firmware-assets`：入口改名、gzip 配对、旧文件清理和其他设备网页保留。
- `npm run test:osc-pipeline-replay`：用固定采集数据检查示波器分帧、样本顺序及历史缓存。
- `npm run test:ws-client-reconnect`：连接代次、重连及请求清理。
- 根目录 `python scripts/repository_hygiene_check.py` 及对应回归：检查提交文件、大小和凭据特征。

提交前重新构建并准备网页，同时提交 `frontend` 源码改动和根目录 `dist/orig` 更新。不要提交 `node_modules`、`frontend/dist`、本地环境文件、构建缓存或固件二进制。

## 本次验证（2026-10-26）

- Windows：Node.js 22.23.1、npm 10.9.8；依赖安装、TypeScript/Vite 构建和固件网页资源准备通过。
- 44 项前端离线回归通过，其中资源准备脚本覆盖 4 个用例；另在 Linux 运行 MCU 发送缓冲区 C 回归，通过。该 C 参考代码在 64 位主机编译时仍有指针位宽及未使用变量告警。
- 按 Windows `core.autocrlf=true` 检出全部提交文件后，79 个源码文件、两份回放数据和 gzip 配对检查通过；在该独立目录再次安装依赖并构建通过。
- 构建后的未压缩 HTML、JS、CSS 与固件基线逐字节一致；本次未修改固件业务源码，也未执行硬件烧录。
- 仓库规范检查、对应回归和提交空白检查通过。两项依赖浏览器的测试没有运行；软件测试不代替实机验证。
- 沿用来源工程的锁定依赖。`npm ci` 审计报告 13 项风险（1 低、3 中、9 高），此次未升级依赖版本。
