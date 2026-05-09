#!/bin/bash
# ESP32 部署脚本：构建前端产物并预 gzip，产物放在 dist/
# 由 ESPAsyncWebServer 直接服务 .gz 文件

set -e

cd "$(dirname "$0")/.."

echo "==> 构建前端产物..."
npm run build

echo ""
echo "==> 预 gzip 所有静态文件..."
find dist -type f ! -name "*.gz" | while read -r f; do
  gzip -9 -k "$f"
  echo "    压缩: $f -> $f.gz"
done

echo ""
echo "==> 产物大小："
du -sh dist/
echo ""
echo "==> 各文件 gzip 前后对比："
find dist/assets -type f ! -name "*.gz" | sort | while read -r f; do
  orig=$(wc -c < "$f")
  gz="${f}.gz"
  if [ -f "$gz" ]; then
    comp=$(wc -c < "$gz")
    ratio=$(awk "BEGIN { printf \"%.0f\", (1 - $comp/$orig) * 100 }")
    printf "    %-50s %6d B -> %6d B (-%s%%)\n" "$f" "$orig" "$comp" "$ratio"
  fi
done

echo ""
echo "==> 完成。将 dist/ 下的文件上传到 ESP32 LittleFS /www/ 目录"
echo "    推荐使用: arduino-cli upload --fqbn esp32:esp32:esp32 --port /dev/ttyUSB0"
echo "    或 PlatformIO: pio run --target uploadfs"
