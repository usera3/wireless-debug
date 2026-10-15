# USB DHCP 地址恢复

## 问题和证据

2026-10-09 使用 Windows 专属 KM-TEST 回环占用 `192.168.4.2/24`，再接入原生
USB NCM。USB 设备和网络接口识别正常，Windows DHCP Admin 记录 50068
“地址已存在”和 50034 初始化失败 `0x1392`；NCM 最终只有 APIPA 地址，网页超时。

UART 的有效 90 秒观察窗记录了同一个客户端的如下交互：

```text
REQUEST .2 (xid=8CDC0908) -> ACK .2
约 6 秒后：DISCOVER 请求 .2 (xid=D8409FF5) -> OFFER .2 -> REQUEST .2 -> ACK .2
```

该窗口没有捕获到 DECLINE，不代表所有 Windows 或其他系统都不发送 DECLINE。
移除测试网卡后，对 NCM 定向续租得到 `.2`，通过该源地址访问网页 HTTP 200。
问题在本轮样本中是地址安装/恢复阶段，而不是 USB 枚举阶段。

服务端原本已经使用动态地址池，不是把所有客户端硬编码成 `.2`；但同 MAC
重新申请时复用旧租约，因而在这个失败流程中反复给出 `.2`。

## 新行为

网页仍为 `http://192.168.4.1`，网桥、默认地址池和 Android 网关例外不变。
仅物理 USB 入口学到的客户端、当前 bridge DHCP 服务可触发恢复。

| 情况 | 行为 |
| --- | --- |
| 有效 USB DECLINE 的请求地址和服务器匹配当前租约 | 隔离该地址 5 分钟；原 DHCP 释放路径删除这个客户端的租约 |
| 未确认使用的 ACK 后 1–60 秒，USB 客户端发起新 xid 的 DISCOVER，再请求同一地址 | 启发式隔离旧候选地址，仅移除此客户端的租约，再由共享池选址 |
| 同 xid 重发、距 ACK 不在窗口内、已观察到地址使用、普通续租 | 不触发启发式换址 |
| 延迟 REQUEST 请求之前隔离的地址，而同 MAC 已有不同的新候选租约 | 在修改租约之前忽略；保护 OFFER 阶段和 ACK 后的新租约 |
| USB DECLINE 的地址/服务器与现有租约不匹配，或现有 USB 租约收到畸形报文 | 忽略，不进入上游按 MAC 删除租约的路径 |
| 有效 option-overload 报文 | 不启用早期换址启发式；已解析的主选项仍执行延迟请求保护、匹配 DECLINE 隔离与正常续租确认 |
| 地址池内没有未租出、未隔离的候选地址 | 不提供非法或重复地址；保留其他用户的租约，不重启 DHCP |

早期重启申请只是一种疑似失败信号，不是确定的冲突检测。每次 USB 连接最多
4 次启发式换址，客户端 MAC 变化不重置预算。隔离表最多 8 个地址，满表不
驱逐未到期条目；到期条目可复用。重复拒绝不延长已记录的隔离时间。

USB attach/detach 清除本次客户端状态和换址预算，但不清空未到期隔离表。
设备重启会清空所有恢复状态；这是 RAM 状态，不写 NVS。

“已使用”依据正常续租的 `ciaddr` 或物理 USB 入站非 DHCP IPv4 数据的源 MAC/IP。
它用于避免健康连接跳 IP，不表示校验了主机全部网络配置或完成了身份认证。
IPv4 帧观察检查头部和长度，忽略分片，不验证 IP/传输层校验和；不处理 VLAN
或 IPv6。原 DHCP trace 的解析、日志和返回值契约不变。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `main/local_usb_dhcp_recovery.c/.h` | BOOTP/TLV 有界解析、单 USB 客户端 ACK 状态、有限换址与隔离表 |
| `main/local_usb_dhcp_hooks.c` | 绑定 bridge netif、网络序转换、接入 DHCP 生命周期；保留 Android router option |
| `main/local_usb_dhcp_policy.c` | 判断 DHCP MAC 是否来自当前物理 USB 入口；原手机指纹策略保留 |
| `main/local_access_bridge.c` | 绑定 netif、USB 连接状态复位、USB IPv4 使用观察 |
| `scripts/prepare_usb_dhcp_recovery.py` | 校验上游源文件后生成包含恢复 hook 的 build-only 编译单元 |
| `cmake/usb_dhcp_recovery.cmake` | 让 lwIP 编译这个生成单元，替换唯一的原 DHCP source |
| `scripts/usb_dhcp_recovery_regression.py` | 编译真实恢复模块、真实 hook adapter 和上游 allocator 函数做主机回归 |

状态使用固定大小内存和短临界区；锁内不做网络发送、日志或动态分配。
共享 DHCP 的租约链表只在 lwIP 处理请求时操作，不从 TinyUSB 回调修改。
时间使用 `esp_timer_get_time()` 转成 64 位毫秒，避免 32 位毫秒计时约 49.7 天
回绕后，已过期的隔离记录短暂重新生效。

## 构建可复现性

不修改 `C:\esp\v6.0\esp-idf` 的公共安装，不提交完整 SDK 源码副本。
顶层 CMake 在 `project()` 之后生成 `build/usb_dhcp_recovery/dhcpserver.c`；生成文件
保留上游许可证，只在三个位置增加 hook：复用租约前的保护/恢复、候选过滤、ACK 决策。

上游 `components/lwip/apps/dhcpserver/dhcpserver.c`（统一 LF 后）的 SHA-256：

```text
b202508a105f4f4536fd75027ccbc797c44b8e46a7a396ea23c5ee205ed3d67a
```

SDK 源码改变或替换锚点不唯一时，构建应明确失败。升级 ESP-IDF 时需要重新核对
hook 时机与实际 allocator，再更新校验值；不能删掉检查使功能静默失效。
生成文件和编译/烧录产物仍由 `build/` 的忽略规则排除。

```sh
export USB_DHCP_TEST_IDF=/path/to/esp-idf
python3 scripts/usb_dhcp_recovery_regression.py
USB_DHCP_RECOVERY_SANITIZE=1 python3 scripts/usb_dhcp_recovery_regression.py
python3 scripts/usb_wifi_local_bridge_regression.py
python3 scripts/usb_dhcp_trace_regression.py
```

主机回归需要 Python 3 和 gcc，可在 Linux 或 WSL 中运行。
`USB_DHCP_TEST_IDF` 必须指向与上面源哈希匹配的 ESP-IDF 6.0 安装目录。

主机测试提取并编译 SDK 的原租约分配函数，不重新实现一个假的 allocator。
实际 hook adapter 通过轻量 lwIP/日志头部 fixture 执行；完整 SDK 链接通过 ESP-IDF
构建另验。ASan/UBSan 不是实机线程、栈余量或 Windows 成功配置地址的证明。

回归覆盖真实 allocator 的延迟旧请求、连续换址、Wi-Fi 既有租约、混合
占用/隔离的池耗尽及隔离到期。实际 adapter 测试覆盖 bridge/USB 限定、
畸形 DECLINE 与 620 字节合法报文。每次发布应重新运行普通及 ASan/UBSan
回归，并完成 ESP-IDF 构建；测试输出和二进制不放入源码仓库。

## 历史实机验证（2026-10-09）

开发阶段已在一台 Windows 电脑和一块 ESP32-S3 实验板上完成下列验证。
这些是当时的记录，不代表每次源码发布都会重新烧录或执行占址实验。

无人工占址条件下，USB NCM 获得 `192.168.4.2/24`（Dhcp、Preferred）；
以该 USB 源地址访问 `/orig/i.html`、
`/orig/a.js`、`/orig/a.css`、`/api/device/status`、`/api/system/health` 均为
HTTP 200。health 返回 `ok: true`，UART 观察到正常 `health: OK`。

占址实验先拔掉原生 USB、保留 UART 供电，确认专属 KM-TEST 接口的 `.2/24`
为 Manual / Preferred，随后插回原生 USB。没有手动续租、重置开发板或
关闭 Windows 地址冲突检测。

UART 序列：

1. 初次 REQUEST / ACK `.2`，xid `1DA3675B`。
2. 约 6 秒后新的 DISCOVER（xid `CB8EE52A`，仍请求 `.2`），固件记录
   `reason=early-restart-heuristic`，隔离 `.2`，改为 OFFER `.3`。
3. 同 xid 的重传继续 OFFER `.3`，没有再次换址；约 19 秒时收到 REQUEST
   `.3` 并 ACK `.3`。本轮未观察到 DECLINE，因此验证的是早期重启恢复分支。

Windows NCM 接口最终为 `.3/24`（Dhcp / Preferred），连续观察
至少 10 秒保持稳定。测试网卡仍占用 `.2` 时，以 USB 源地址 `.3` 访问
`/orig/i.html` 和 `/api/system/health` 均为 HTTP 200。Windows DHCP Admin
事件 50068 明确记录 `.2` 已存在，同时有 50034 / 1003（`0x1392`）。

结束后脚本仅移除本轮 token 所属测试网卡，复核 state 为 Restored、
原 PnP 节点和网卡均不存在、`.2` 已无接口占用，串口已释放。USB 保持
`.3/24`；清理后默认路由及绑定 `.3` 的健康请求均返回 HTTP 200 / `ok: true`。

原始 UART、地址快照、事件、HTTP 结果和清理记录留在 Git 外，未随源码发布。
这是一次同机虚拟网卡占址实验，不等同于其他电脑、实体 USB Wi-Fi 网卡或
两个候选地址同时冲突的验收。冲突期间 HTTP 采用源地址绑定，不能据此保证
任意重叠网段下浏览器默认路由都正确。

## 实机验收和边界

软件回放、烧录启动与本机 `.2` 占址恢复已分别完成。占址只创建并清理专属
测试网卡，没有重配置现有网卡。完整实机验收项目仍按
[占址实验说明](USB_IP_CONFLICT_TEST.md) 保留 UART 和主机状态逐项执行；
本轮覆盖第 2 项与启动 HTTP 基线，并非所有项目都已完成：

1. 无冲突基线：正常分配、续租、网页与 WebSocket，不反复变更 IP。
2. 占用 `.2`：观察 `reason=early-restart-heuristic` 或 `reason=decline`，确认下次
   OFFER/ACK 改址，Windows 地址为 Preferred Dhcp；使用该 USB 源地址验证 HTTP 200。
3. 扩展占用 `.2/.3`：需要扩展实验脚本及明确恢复清单，当前 Prepare 脚本只占 `.2`，
   不能冒充多地址占用已做过。若主机停止重试，必要时定向续租，记录此人工步骤。
4. USB 与两个 Wi-Fi 客户端共用：其他租约和正在进行的业务连接不受影响。
5. Android/iOS 及正常续租回归：网关行为、网页、USB 拔插后恢复分别验证。
6. 结束后 Restore 专属测试网卡，核对主机恢复；不要关闭 Windows 地址冲突检测。

ESP32 无法直接获知 Windows 其他接口占用的地址。如果主机不报告冲突，也不
再启动新申请，服务端无法仅靠该策略主动知道隐藏失败。相同网段的其他接口
仍可能造成路由歧义：换到 `.3` 并不保证电脑一定通过 USB 到达 `.1`。本方案
不解决地址 `.1` 本身被另一个网络占用、跨网段路由或全部手机/操作系统兼容性。
