# 地址示波器变量名解析原理

这份说明记录 2026-08-25 版本的 `.out/.elf` 变量地址选择功能。实现以
2026-08-24 快照为唯一基线，并沿用 `elf_addr_tool_ts-master.zip` 的 ELF32
符号表和 DWARF 类型解析逻辑。

## 一句话概括

`.out/.elf` 文件只在用户浏览器内解析。用户在每个通道右侧的变量名框中
输入严格前缀，逐级选择结构体成员或数组下标；选中最终标量后，完整表达式
保留在变量名框中，计算出的 16 位十六进制地址写入同一行左侧地址框。
ESP32 和 183 云端都不接收文件，也不负责解析 ELF。

## 版本关系

- Web 源码：`22fb25a`（`feature/elf-struct-array-index-20260825`）
- 固件源码和嵌入网页：`4148575`（`feature/elf-struct-array-index-20260825-fw`）
- 183 静态网页：`cloud-183/source/dist/orig/`
- 2026-08-24 基线：Web `f8de108`，Firmware `2c548ac`

## 运行链路

```text
选择 .out/.elf
      |
      v
File/Blob --(64 MiB 检查 + arrayBuffer)--> parseElfBinary
                                             |
                         +-------------------+------------------+
                         |                                      |
                   ELF .symtab/.strtab                    DWARF .debug_*
                         |                                      |
                         +------------> AddressParser <---------+
                                             |
变量名框输入 animal.d --严格 startsWith--> animal.dog / animal.dogs
                                             |
       结构体继续 "."，数组继续 "["，只在当前层惰性生成最多 50 项
                                             |
                     选中标量 -> resolve(完整表达式)
                                             |
                      变量名框保留表达式，地址框写入 0000..FFFF
                                             |
                         原有 0x75 示波器通道配置流程
```

## ELF 与 DWARF 解析

解析器读取 ELF32 little-endian 文件：

1. 验证 ELF magic、位数和字节序。
2. 从 `.symtab` 和 `.strtab` 读取全局数据符号名称、根地址和大小。
3. 从 `.debug_info`、`.debug_types`、`.debug_abbrev`、`.debug_str` 和
   `.debug_line_str` 读取变量与类型关系。
4. 只保留地址计算需要的变量、成员、结构体、联合体、数组、数组范围、
   基础类型和类型包装 DIE，不保留函数、编译单元或词法块对象。
5. 使用符号地址或名称把 ELF 符号与 DWARF 变量关联起来。

数组范围来自 `DW_TAG_subrange_type` 的 `DW_AT_lower_bound`、
`DW_AT_upper_bound` 或 `DW_AT_count`。这让索引提示和最终求址使用同一组
边界，越界下标不会被提示，手工输入越界表达式也会报错。

## 结构体和数组索引

`AddressParser.getSuggestions()` 根据当前表达式只检查下一层：

- 根变量：`ani` 可以提示 `animal`。
- 结构体：`animal.d` 可以提示 `animal.dog`、`animal.dogs`。
- 多级结构体：`animal.dog.a` 可以提示 `animal.dog.age`。
- 结构体数组：`animal.dogs[` 按 DWARF 边界提示 `[0]`、`[1]`、`[2]`。
- 混合表达式：`animal.dogs[2].age` 可以解析为最终标量地址。
- 多维数组：`animal.matrix[1][2]` 逐维提示并按行优先步长计算偏移。
- 真实 C2000 示例：`iRtMcBoardList[0].PwmSampleCmp[2] -> 0xC93D`。

建议项包含 `kind` 和 `continuation`：结构体/联合体返回 `.`，数组返回
`[`，标量返回空字符串。页面点击聚合项时只补上继续符号并保持下拉框；
只有点击标量时才调用 `resolve()` 并写回地址。因此 `animal.dog` 如果本身
是标量会直接写回，如果它还是一个结构体，则继续显示 `animal.dog.` 供用户
选择更深成员。

## 地址计算

`AddressParser.resolve(expression)` 从根符号地址开始逐段遍历：

- 结构体/类成员加 `DW_AT_data_member_location`。
- 联合体成员通常加同一个零偏移，但仍沿成员类型继续解析。
- 数组下标先验证 DWARF 上下界，再加
  `(index - lower_bound) * current_dimension_stride`。
- 多维数组步长等于元素字节数乘以后续各维长度。
- typedef、const、volatile 和引用类型在求址时自动解包。
- 地址和偏移使用 `bigint`，避免 JavaScript 普通 `number` 的精度损失。

当前示波器协议的地址字段仍为 16 位，所以最终标量地址必须位于
`0x0000..0xFFFF`。选中后 `buildElfChannelPatch()` 同时返回完整变量表达式
和不带 `0x` 的大写地址，例如：

```text
McStatus1.Pu.Ia                         -> C534
iRtMcBoardList[0].PwmSampleCmp[2]       -> C93D
animal.dogs[2].age                      -> 100C（合成回归类型）
animal.matrix[1][2]                     -> 101A（合成回归类型）
```

地址框仍可直接手工编辑十六进制值；手工编辑不会打开变量提示。变量名搜索只
发生在右侧变量名框，选中标量后表达式始终留在该框中，便于对应波形。

## 严格搜索和内存控制

- 每一层均使用大小写不敏感的 `startsWith`。输入 `c` 只显示以 `c/C`
  开头的同层名称，不做包含匹配。
- 每次最多返回 50 项，调用者传入更大的 limit 也会被截断。
- 根变量名只排序并缓存一次，不在每次按键时重建完整数组。
- 大数组不在文件加载时预展开。输入 `array[` 时只生成前 50 个有效下标；
  输入 `array[199` 时直接计算匹配的数字区间。
- ELF section、字符串和小块读取使用 `Uint8Array.subarray()` 视图，避免
  复制完整 section。
- 文件上限固定为 `64 * 1024 * 1024` 字节，并在调用 `arrayBuffer()` 前
  拒绝超限文件。
- 原始文件不通过 HTTP、WebSocket 或设备 API 发送，也不写入 SPIFFS。

浏览器仍需要一个与文件大小相当的临时 `ArrayBuffer`。当前只支持 ELF32
little-endian；被 strip、缺少符号表或缺少所需 DWARF 类型信息的文件无法
提供完整的结构体/数组索引。

## 本地固件与 183 为什么一致

Web 构建只生成一组静态资源。完全相同的 `a.js`、`a.css` 和 `x.js` 被：

1. 放入固件 `dist/orig/`，再由 ESP-IDF 打入 `storage.bin`；
2. 放入 183 的 `/apps/svr/wireless-debug-cloud/dist/orig/`；
3. 归档到本快照的固件、云端和 Web 源码目录。

两处页面执行同一份浏览器解析代码，差别只在示波器数据走本地 WebSocket
还是云端设备 WebSocket。

## 回归验证

`scripts/elf-address-parser-regression.ts` 同时使用 TI C2000、IAR 和合成
`animal` 类型，覆盖结构体、数组、多维数组、边界、严格前缀、64 MiB
上限与零复制约束。`scripts/elf-address-picker-ui-regression.ts` 检查输入框
职责和写回行为，`scripts/elf-address-picker-playwright.mjs` 检查桌面/手机
布局、真实点击链路、浏览器堆占用，以及 `.out/.elf` 没有网络上传。

```bash
npm run test:elf-address-parser
npm run test:elf-address-picker-ui
npm run test:osc-channel-types
npm run test:elf-address-picker-browser
npm run lint
npm run build
```
