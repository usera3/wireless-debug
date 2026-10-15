# USB DHCP 只读观察

该只读诊断用于补齐 USB NCM DHCP 证据。诊断本身只观察，不改帧或分配策略，
保留 `192.168.4.1/24`、Android 网关策略与 USB 描述符；不能把诊断可用视为
Windows 地址冲突已经修复。后续新增的恢复策略另见
[USB_DHCP_RECOVERY.md](USB_DHCP_RECOVERY.md)。

## 日志字段及边界

INFO 级别启用时，UART 中的 tag 为 `usb_dhcp_trace`。示例：

```text
usb_dhcp_trace: RX submit_result=0 type=DECLINE xid=12345678 mac=AE:A7:04:31:89:F1 ciaddr=0.0.0.0 yiaddr=0.0.0.0 requested=192.168.4.2 server=192.168.4.1
```

`RX` 表示 TinyUSB 已把帧交给 USB 接收回调，`submit_result=0` 是观察点元数据，
不能据此断言 lwIP 已接收或处理成功。`TX` 在 `tinyusb_net_send_sync()` 返回后记录，
`submit_result` 是其原始返回值；`0` 仅表示驱动提交成功，不证明帧已到达主机，
更不证明 Windows 安装了 IPv4 地址。未挂载时的原有发送分支不会调用发送驱动，
因此也不会产生 TX 提交记录。发送超时仍为 100 ms，返回值保持原样。

| 字段 | 含义 |
| --- | --- |
| `type` | DHCP 1–8：DISCOVER、OFFER、REQUEST、DECLINE、ACK、NAK、RELEASE、INFORM |
| `xid` | BOOTP 事务 ID，按网络字节顺序输出八位十六进制，用于关联交互 |
| `mac` | BOOTP `chaddr` 中的客户端 MAC，不是 Ethernet 源 MAC |
| `ciaddr` / `yiaddr` | BOOTP 客户端当前地址 / 服务端提供的地址，零地址仍显示为 `0.0.0.0` |
| `requested` | option 50 请求地址；缺失为 `-` |
| `server` | option 54 服务端标识；缺失为 `-` |

观察器只接受 Ethernet IPv4 UDP `68→67` / `67→68`，按 IHL、IP total length
和 UDP length 限定解析范围。IPv4 分片、截断、无效 BOOTP/cookie、缺失或非法
message type、重复或长度错误的关键选项、缺少 END 的选项区均不输出日志。
PAD 和 END 正常处理，END 后内容不解析；不记录 hostname、vendor 或原始帧。
不进行 IP/UDP 校验和验证，不处理 VLAN、IPv6、DHCP relay `67→67` 或 option
overload 区域。这些限制意味着没有摘要不能单独证明链路没有任何 DHCP 数据。
INFO 被禁用时直接返回。所有解析及格式化使用有界字节读取和栈缓冲区，
不额外分配堆内存，不修改、丢弃或重建收发帧。

只读并不表示没有性能成本：INFO 摘要会增加回调的栈占用、执行时间和 UART
输出时间。原有驱动超时仍为 100 ms，但整个回调并不因此保证在 100 ms 内完成。
实机验证还应观察带业务流量时的栈余量和时序，不能只凭主机测试认定这些已验证。

## 如何解读流程

通常可看到同一客户端的 `RX DISCOVER → TX OFFER → RX REQUEST → TX ACK`。
重用租约或重试时序可能不同，应按 MAC、xid、地址和 UART 时间戳关联，
不能要求所有客户端都必须出现完整四步。Windows 的实际地址状态还需 Status 验证。

若客户端发现冲突且通过链路报告，可能看到 `RX DECLINE`，option 50/54
提供被拒地址及服务端信息，随后可能出现新的 DISCOVER/REQUEST。看到 DECLINE
只证明报文到达回调；是否隔离/换址需核对恢复模块日志和后续 OFFER/ACK，
不能仅凭该诊断日志认定恢复已经发生。

早期两轮 Windows 实验已复现本机跨接口重复 `192.168.4.2` 引起的 NCM 地址插入
失败，但当时 Windows 抓包不完整。2026-10-09 的有效 UART 实验补齐了交互：
REQUEST/ACK `.2` 后约 6 秒，客户端以新 xid DISCOVER 再申请 `.2`，服务端仍
OFFER/ACK `.2`；90 秒观察窗未捕获 DECLINE。主机对应 50068/50034、APIPA
和网页超时。清理占址设备并定向续租后，恢复 `.2` 和 HTTP 200。
首次诊断实验因插入时间晚于自动清理时间，不能作为冲突样本；上述结果来自
随后重新开展的有效实验。缺少 DECLINE 不能推断所有系统必定不会发送它。

服务端只能看到链路上的报文，无法直接读取 Windows 其他网卡的 IP 配置。
若 Windows 仅在本机拒绝安装地址，且没有发出 DECLINE 或重试，服务端仅靠
分配算法不能自动获知这个隐藏冲突。即便成功改配 `.3` 等不同地址，两张网卡
同时拥有 `192.168.4.0/24` 路由仍可能造成选路歧义，HTTP 可达性需要另外验证。
本实验结果不代表所有操作系统、网卡或网络环境均兼容。

## 下一次实机实验

只读诊断固件已在上述有效实验中烧录并取证；后续恢复策略的同机占址结果见
[历史实机验证](USB_DHCP_RECOVERY.md#历史实机验证2026-10-09)。以下步骤用于
复验或扩展验证，不表示已对所有设备和网络环境完成验收。
现有冲突实验脚本说明见 [USB_IP_CONFLICT_TEST.md](USB_IP_CONFLICT_TEST.md)。

1. 在已确认运行含该诊断的固件后，用现有 UART 通道保存带时间戳的完整日志；
   从插入原生 USB 前开始，覆盖挂载、DHCP 和 Status。保持 `usb_dhcp_trace`
   INFO 可用，避免其他程序争用同一个串口。先做无冲突基线，确认日志能看到 DHCP。
2. 拔掉 ESP32 原生 USB，USB-to-UART 可以保留；在该 worktree 中用管理员
   Windows PowerShell 执行 Prepare，只有 `READY` 且 `.2` 为 `Preferred`
   才表示占用完成。脚本创建专属 KM-TEST 回环，不更改已有网卡。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Prepare
   ```

3. 插入待测原生 USB，保留完整 UART 输出，然后运行只读 Status。
   Status 汇总 NCM Link/IPv4 AddressState、DHCP 设置、`192.168.4.0/24` 路由
   及最近的 System 4199 事件，不包含 DHCP Admin 日志。还需在 Windows 事件
   查看器中另行保存 DHCP Client 的 Admin 日志，关注 50068/50034/1003；
   不能只等待 4199，或把 Status 没有输出 DHCP 事件理解为没有发生冲突。
   如另有抓包，也保留原文件和相同时间窗。根据日志核对 OFFER/ACK 地址、
   TX 提交结果、是否收到 DECLINE 及后续请求。主机 Up、TX 成功和地址 Preferred
   是三个不同观察结果。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Status
   ```

4. 在成功、失败或中断后都用管理员 PowerShell 执行 Restore，保存输出和 UART
   日志，并再次核对主机状态。Restore 仅移除脚本自己创建并核验身份的设备。
   若显示 RestorePending，按现有脚本说明处理，不能把待恢复状态当作已恢复。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Restore
   ```

不要关闭 Windows 地址冲突检测来使实验通过。KM-TEST 模拟的是本机跨接口占址，
并非外部设备响应 ARP；保留这一条件与实际物理网卡故障的区别。

## 主机回归

```sh
python3 scripts/usb_dhcp_trace_regression.py
USB_DHCP_TRACE_SANITIZE=1 python3 scripts/usb_dhcp_trace_regression.py
python3 scripts/usb_wifi_local_bridge_regression.py
```

新回归通过 gcc 调用真实格式化器，覆盖八种消息、缺失可选字段、IP options、
逐字节截断、关键 TLV、分片、BOOTP/cookie、PAD/END、非 DHCP、非对齐输入、
输出容量和 4096 轮确定性随机帧。另以临时 ESP 日志边界 fixture 检查 INFO
关闭时不访问帧、无效帧不打印和 RX/TX 元数据；完整 ESP-IDF 构建仍需单独运行。

发布时应运行普通及 ASan/UBSan 模式的 3 项诊断回归、既有 USB/Wi-Fi 回归，
并完成 ESP-IDF 构建。这些检查不代替实机地址分配、栈余量和链路时序验证。
