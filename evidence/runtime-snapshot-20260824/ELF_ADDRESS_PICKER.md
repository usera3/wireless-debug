# 地址示波器变量名解析原理

这份说明记录 2026-08-24 版本中 `.out/.elf` 变量地址选择功能的实现，作为后续维护时的上下文依据。

## 一句话概括

`.out` 文件只在用户浏览器内解析。浏览器从 ELF 的符号表和 DWARF 调试信息建立“变量名 -> 地址/类型”索引；用户在通道地址框中输入变量名前缀，选择严格前缀匹配的提示项后，前端把变量表达式计算成 16 位十六进制地址，再沿原有 Modbus 示波器协议发送给设备。ESP32 和 183 云端不需要理解 ELF。

## 版本关系

- 网页功能最终源码：`f8de108`（`feature/elf-address-on-aug21`）
- 固件中嵌入的同一份网页产物：`2c548ac`（`feature/elf-address-on-aug21-fw`）
- 183 云端部署的同一份静态网页产物：`cloud-183/source/dist/orig/`
- 8.24 快照中的源码位置：`web-source/source/src/lib/elfAddressParser.ts`、`web-source/source/src/lib/elfParser/`、`web-source/source/src/components/OscChannelConfig.tsx`

## 运行链路

```text
选择 .out/.elf
      |
      v
File/Blob --(size check + arrayBuffer)--> parseElfBinary
                                      |
                   +------------------+------------------+
                   |                                     |
             ELF .symtab/.strtab                  DWARF .debug_*
                   |                                     |
                   +------------> AddressParser <--------+
                                      |
                         getVariableNames() 建索引
                                      |
输入前缀 --startsWith--> 提示列表 --点击--> resolve(expression)
                                      |
                       BigInt 地址 + 结构体/数组偏移
                                      |
                         0000..FFFF 写回通道地址框
                                      |
              buildSetChannel(0x75) -> 原有示波器启动流程
```

### 1. 文件加载和浏览器内解析

`OscChannelConfig` 的隐藏文件选择器接受 `.out`、`.elf` 和通用二进制类型。选择文件后：

1. 清掉上一次解析器、变量名和错误状态。
2. `createElfAddressParser(file)` 先检查文件大小，再调用 `file.arrayBuffer()`。
3. `AddressParser.fromBinary()` 调用二进制 ELF 解析器，并把解析结果封装成只暴露 `getVariableNames()` 和 `resolve()` 的接口。

整个过程没有 `fetch`、上传 API 或 WebSocket 传输；原始 `.out` 不会离开浏览器，也不会写入 ESP32 SPIFFS 或 183 服务器。

### 2. ELF 和 DWARF 解析

解析器是针对当前 C2000 工具链产物实现的轻量 ELF32 little-endian 读取器：

- 先检查 ELF magic `0x7f 'E' 'L' 'F'`。
- 读取 ELF32 的 section header，解析 section 名称。
- 从 `.symtab` + `.strtab` 读取符号名称和地址。
- 从 `.debug_info`、`.debug_types`，配合 `.debug_abbrev`、`.debug_str`、`.debug_line_str`，读取 DWARF DIE 和类型引用。
- 符号表只保留 `STT_OBJECT` 和工具链常见的 `STT_NOTYPE` 数据符号，过滤函数/section 符号、零地址和重复名称，避免把无关内容塞进提示列表。
- DWARF 只保留变量、成员、结构体/联合体、数组、基础类型、typedef、限定类型、指针、枚举等与地址计算有关的 DIE；编译单元、函数和词法块仍会被读取以便正确走过编码，但不保留为对象。

解析后会把符号地址与 DWARF 变量 DIE 按地址或名称关联。这样既能处理普通全局变量，也能取得结构体和数组所需的类型信息。

### 3. 严格前缀搜索

提示逻辑在 `filterElfVariableNames()` 中完成：

```ts
const normalized = query.trim().toLocaleLowerCase();
return names
  .filter((name) => name.toLocaleLowerCase().startsWith(normalized))
  .slice(0, 50);
```

因此：

- 输入 `c` 只显示以 `c` 或 `C` 开头的名称。
- 输入 `cnt` 只显示以 `cnt` 开头的名称。
- 名称中间或结尾包含 `c`，但不是以它开头的，不会出现。
- 最多显示 50 项，避免大 ELF 文件导致下拉框和 DOM 膨胀。
- 查询为空时不显示提示；大小写不敏感，但匹配位置严格从第一个字符开始。

这正是后来修复“输入一个字母却索引出无关变量”的改动：从模糊包含匹配改成了 `startsWith`。

### 4. 变量表达式如何变成地址

点击提示项后调用 `AddressParser.resolve(expression)`：

- `cnt_tbs`：直接返回 ELF 符号表中的根地址。
- `McStatus1.Pu.Ia`：先取 `McStatus1` 根地址，再沿 DWARF 类型引用找到结构体成员 `Pu`、`Ia`，逐级加上 `DW_AT_data_member_location` 偏移。
- `iRtMcBoardList[0]`：找到数组类型，按“下标 × 元素字节大小”计算偏移。
- 支持 typedef、const、volatile、pointer 等类型包装的解包；DWARF type signature 会通过 `.debug_types` 的签名表解析。
- 地址和偏移使用 `bigint`，避免在解析阶段因 JavaScript 普通 number 精度而损坏地址。

示例回归值：

```text
cnt_tbs             -> 0xC42C
McStatus1.Pu.Ia     -> 0xC534
iRtMcBoardList[0]   -> 0xC938
```

### 5. 写回通道和启动示波器

`OscChannelConfig` 收到解析结果后会：

1. 拒绝小于 `0` 或大于 `0xFFFF` 的结果，因为设备的 `0x75` 通道配置帧只有 16 位地址字段。
2. 使用 `formatElfAddress()` 格式化成大写、至少四位的字符串，例如 `C42C`。
3. 写入当前行的 `varAddrHex`；如果该行仍是默认标签 `CHn`，同时把标签改成所选表达式，便于看图时识别变量。
4. 清除该行错误并关闭提示列表。

点击“开始”时，`buildChannelConfigs()` 将地址文本转换成数字，`validateOscChannelConfigs()` 再检查地址范围、通道编号连续性和槽位占用。随后沿原有流程生成：

```text
[FF, 75, channelNo, paramType, address_high, address_low] + CRC
```

局域网连接逐通道等待确认，云端连接按当前云端策略连续配置；变量名功能没有改变设备协议，也没有在固件中增加 ELF 解析代码。

## 内存和大文件处理

这是这次实现中特别处理的部分：

1. **入口硬上限**：`MAX_ELF_FILE_BYTES = 64 MiB`。超过上限立即报错，且不会调用 `arrayBuffer()`；这样不会先把超大文件读进浏览器内存。
2. **避免 section 复制**：二进制解析使用 `Uint8Array.subarray()` 建立视图，而不是对每个 ELF section 再复制一份完整字节数组。
3. **裁剪 DWARF 对象图**：只保留地址解析所需的 DIE 标签，不保留函数、编译单元和词法块对象。
4. **限制搜索结果**：提示最多 50 项，不为每次按键重新创建全量索引。
5. **不走网络和设备存储**：文件不会被上传、转发或写入 SPIFFS，因此不会占用 ESP32 的存储/堆内存。

需要明确：浏览器仍然需要一个与文件大小相当的临时 `ArrayBuffer`，所以 64 MiB 是安全预算，不是说任意大小文件都能无成本解析。当前实现还明确不支持 ELF64 和大端 ELF；文件必须保留符号表/DWARF 调试信息，strip 后的文件通常无法解析变量类型。

## 网页为何本地和云端都能用

这是“同一份前端产物，多处承载”：

1. `npm run build` 生成 `a.js`、`a.css`、`x.js` 等静态资源。
2. `sync-firmware-dist.mjs` 把构建结果同步到固件 `dist/orig/`，ESP-IDF 的 `spiffs_create_partition_image(storage ../dist ...)` 将其打入 `storage.bin`。
3. 183 云端部署同一组 `dist/orig` 文件，Flask 的 `/cloud.html`、`/remote/<device_id>/orig/` 路由提供这些资源。

所以本地 ESP32 页面和 183 页面执行同样的 ELF 解析 JavaScript；差别只在示波器数据的传输目标（本地 WebSocket 或云端设备 WebSocket），不在变量解析功能本身。

## 回归验证

`scripts/elf-address-parser-regression.ts` 覆盖了：

- 顶层变量、结构体成员、数组元素地址。
- 严格前缀查询：`CNT` 只得到 `cnt_tbc`、`cnt_tbs`，不会得到 `prefix_cnt` 或 `$C$FSL8`。
- 手工十六进制地址格式化和非法输入。
- 超过 64 MiB 时拒绝，并验证不会读取文件内容。
- 非 ELF 文件报错。

对应命令：

```bash
npm run test:elf-address-parser
```
