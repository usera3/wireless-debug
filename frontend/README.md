# USB 网络版 React 前端

本目录是 ESP32-S3 USB 网络修复版配套的 React 工程。安装依赖、修改界面及构建网页都在本目录操作。

## 环境

使用 Node.js 22.x，至少为 22.13.0；npm 随 Node.js 安装。首次安装依赖需要访问锁文件中的公司 npm 服务。

## 修改和预览网页

在 VS Code 打开本目录，再在 CMD 中执行：

```text
npm ci
npm run dev -- --host 127.0.0.1 --port 5679
```

浏览器打开 `http://127.0.0.1:5679/index.html`。端口变化时替换 5679，保留 `/index.html`。修改 `src/` 并保存，页面会自动更新。

需要软件模拟数据时，另开 CMD，进入本目录执行：

```text
node mock-server/server.mjs
```

模拟服务使用 HTTP 8766、WebSocket 8765，开发网页已配置代理。模拟结果用于软件验证；真实参数、波形和升级仍需连接下位机验证。

## 生成固件使用的网页

```text
npm run build:firmware-assets
```

命令先构建 `frontend/dist/`，再校验 gzip 文件并更新仓库根目录 `dist/orig/`。入口自动改名为 `i.html`、`i.html.gz`，其他文件保持原名，根目录的配网页和跳转页保持不变。准备失败时不要继续烧录。

只查看构建产物、不复制到固件时，执行：

```text
npm run build
```

网页准备完成后，在固件根目录加载 ESP-IDF 环境，再编译和烧录。`frontend/dist/`、`node_modules/` 和 TypeScript 缓存均不提交；设备实际使用的根目录 `dist/orig/` 仍受 Git 管理，修改网页后与源码一起提交。

## 检查

```text
npm run test:firmware-assets
npm run test:frame-router
npm run test:ws-client-reconnect
npm run test:osc-pipeline-replay
```

更多协议、参数、连接及示波器回归命令见 `package.json` 中的 `test:*`。需要浏览器、云服务或真实硬件的测试应另行准备环境。

源码来源及目录说明见 [`../docs/FRONTEND_SOURCE.md`](../docs/FRONTEND_SOURCE.md)。
