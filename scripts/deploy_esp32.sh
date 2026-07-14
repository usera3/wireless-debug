#!/bin/bash
# ESP32 部署脚本：构建前端产物并预 gzip，产物放在 dist/
# 由 ESPAsyncWebServer 直接服务 .gz 文件

set -e

cd "$(dirname "$0")/.."

echo "==> 构建前端产物并同步到 ESP-IDF 项目..."
npm run build:firmware-assets

echo ""
echo "==> 产物大小："
du -sh dist/
echo ""
echo "==> 各文件 gzip 前后对比："
find dist -maxdepth 1 -type f ! -name "*.gz" ! -name "*.zip" | sort | while read -r f; do
  orig=$(wc -c < "$f")
  gz="${f}.gz"
  if [ -f "$gz" ]; then
    comp=$(wc -c < "$gz")
    ratio=$(awk "BEGIN { printf \"%.0f\", (1 - $comp/$orig) * 100 }")
    printf "    %-50s %6d B -> %6d B (-%s%%)\n" "$f" "$orig" "$comp" "$ratio"
  fi
done

echo ""
echo "==> 完成。固件 SPIFFS 产物已同步到 ../wireless_debug-main/dist/orig"
echo "    下一步在 ESP-IDF 项目中构建 storage.bin 并烧录。"
