# USB 修复版补齐 React 工程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is already authorized for inline execution; keep the result local and do not push.

**Goal:** 在 `9d1900a` 的 USB 修复版上补齐可构建的 React 工程，单仓库完成网页修改、打包及固件资源准备。

**Architecture:** 固件仍位于仓库根目录，React 工程放在 `frontend/`。恢复团队仓库 `5ddbefe` 中对应的源码及测试；构建结果通过独立脚本更新根目录 `dist/orig`，保留其他设备网页。

**Tech Stack:** React 18、TypeScript 5.6、Vite 5.4、Node.js 22、Python 3（仓库检查）、ESP-IDF 6.0。

## Global Constraints

- 固件基线：`fix/usb-dhcp-recovery`，`9d1900a96626fdf101515e116b8ea4a6674cc16e`。
- 前端来源：`feature/team-monorepo-usb-wifi`，`5ddbefe801d68cb8eae9e89427eea4b7be07e4a1`。
- Node.js 新安装使用 22.x，至少 22.13.0；保留原依赖锁文件。
- 不修改 `main/`、`cmake/`、`sdkconfig`、分区表和已有硬件配置。
- 不纳入 node_modules、构建缓存、安装包、固件二进制或账号凭据。
- 本次在独立本地分支提交，不推送，不操作硬件。

## Task 1: 恢复可构建前端

**Files:** `frontend/src/`、配置文件、`frontend/scripts/`、`frontend/mock-server/`、`frontend/reference/`、`frontend/fixtures/`。

- [x] 基线检查：运行现有仓库规范检查及其回归，确认工作目录干净。
- [x] 从指定 Git 提交恢复前端，排除 `frontend/dist` 和 `.env.production`。
- [x] 在 Vite 生产配置中保留原有 `ws://192.168.4.1/ws` 默认值；开发模式保持原行为。
- [x] 修改 `build:firmware-assets`，调用本仓库的资源准备脚本，使用 Node.js 运行以兼容 Windows。
- [x] 增补忽略规则；两份波形回放数据按准确文件路径加入 gzip 测试数据允许清单，其余归档限制保持不变。

## Task 2: 连接前端构建与固件资源

**Files:** `scripts/prepare_web_assets.mjs`、`scripts/prepare_web_assets_regression.mjs`、仓库规范回归。

**Interfaces:** `stageWebAssets(frontendDist: string, firmwareDist: string): string`。使用 Node.js 打包资源，Windows 不额外依赖 PATH 中的 Python。

- [x] 先写回归：验证 `index.html`/gzip 改名、其他网页不变、旧资源清理、错误 gzip 输入不改变现有资源。
- [x] 先运行回归，确认因资源准备脚本缺失而失败。
- [x] 实现暂存与目录替换；输入完整且 gzip 配对通过后才替换 `dist/orig`。
- [x] 为允许的两份数据及仍应拒绝的其他 gzip 路径增加规范回归，先确认允许用例失败，再调整准确路径清单。
- [x] 运行上述回归，确认通过。

## Task 3: 验证与说明

**Files:** `README.md`、`frontend/README.md`、`docs/FRONTEND_SOURCE.md`、`docs/REPOSITORY_POLICY.md`。

- [x] 写明前端来源、单仓库的安装与构建命令、预览入口 `/index.html`、资源改名规则。
- [x] Windows Node.js 执行 `npm ci`、`npm run build`、`npm run build:firmware-assets`。
- [x] 运行恢复工程中不依赖外部硬件/服务的协议、参数、连接和示波器回归。
- [x] 验证 gzip 配对、固件源文件未改动、忽略规则和仓库规范；执行 `git diff --check`。
- [x] 提交前自查；提交本地 `fix/usb-react-source` 并确认状态干净。远端分支保持原提交。
