# GMCC · 设备调试台

## 本次修改

云平台和 ESP32 网页采用深蓝侧栏、浅灰底色、白色卡片与青色操作按钮。Logo 为 GMCC，产品名称为设备调试台。

保留仪表盘、地址示波器、参数示波器、参数编辑、固件烧录和连接设置；云平台保留全部栏目及登录流程。修改不涉及通信协议、状态存储、参数地址或固件控制逻辑。

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

## 验证

- 两套 React 前端分别构建通过。
- 设备页在本地、云端设备两种入口下，分别验证 1440×1024、1024×768、390×844，共 36 项页面/尺寸组合。
- 验证导航、XLSX 参数表导入与搜索、参数表选择弹窗、CSV 波形导入、手机端停止按钮触控区域。
- 云平台验证全部 8 个栏目、设备搜索与状态筛选、控制台链接、用户菜单、移动端抽屉。
- 登录页验证表单、密码显隐、错误信息转义和跳转参数；加载失败页与备用云平台页完成浏览器检查。
- 网页资源打包回归通过，8 个产物及 gzip 内容一致。
- 本次测试使用本机 HTTP 测试数据，未连接真实设备，未部署云端、未烧录、未推送 Git。

浏览器测试在 `frontend` 目录运行：

```sh
node scripts/console-ui-playwright.mjs
node scripts/unified-site-smoke.mjs
```

脚本使用现有 Playwright 环境；其他电脑可通过 `PLAYWRIGHT_MODULE` 指定已安装 Playwright 的 `index.js` 绝对路径。截图目录分别由 `CONSOLE_SCREENSHOTS` 和 `CLOUD_SCREENSHOTS` 指定。

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
