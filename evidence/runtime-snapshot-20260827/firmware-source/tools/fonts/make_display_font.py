#!/usr/bin/env python3
"""Generate the OLED Chinese font used by the LVGL UI.

The source font is Fusion Pixel Font, OFL licensed:
https://github.com/TakWolf/fusion-pixel-font
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path


RELEASE = "2026.07.01"
ZIP_NAME = f"fusion-pixel-font-12px-monospaced-ttf-v{RELEASE}.zip"
ZIP_URL = (
    "https://github.com/TakWolf/fusion-pixel-font/releases/download/"
    f"{RELEASE}/{ZIP_NAME}"
)
FONT_NAME = "fusion-pixel-12px-monospaced-zh_hans.ttf"
OUTPUT_NAME = "display_font_fusion_12_zh.c"
LV_FONT_NAME = "display_font_fusion_12_zh"


def gb2312_level1() -> str:
    chars: list[str] = []
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                chars.append(bytes([high, low]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return "".join(chars)


def charset() -> str:
    punctuation = "，。！？：；、（）【】《》“”‘’—…·￥"
    technical = (
        "大模型回复乱码拍照检查原因字体库合适授权生成固件烧录运行显示屏幕"
        "蓝牙串口端口设备驱动渲染编码解码缓存刷新下载联网接口状态中文英文"
        "常用简体繁体字形占位符问答请求响应错误超时连接配置系统菜单模式"
        "虚拟真实数据网络服务路由传输接收发送任务内存堆栈空间压缩编译构建验证"
    )
    return "".join(dict.fromkeys(punctuation + technical + gb2312_level1()))


def download(url: str, path: Path) -> None:
    if path.exists():
        return
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as response:
        path.write_bytes(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path(tempfile.gettempdir()) / "wireless_debug_fonts",
        help="download/extract cache",
    )
    args = parser.parse_args()

    repo = args.repo.resolve()
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)

    zip_path = cache / ZIP_NAME
    download(ZIP_URL, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extract(FONT_NAME, cache)
        zf.extract("OFL.txt", cache)

    output = repo / "main" / OUTPUT_NAME
    symbols = charset()
    subprocess.run(
        [
            "npx",
            "--yes",
            "lv_font_conv@latest",
            "--no-compress",
            "--no-prefilter",
            "--no-kerning",
            "--bpp",
            "1",
            "--size",
            "12",
            "--font",
            str(cache / FONT_NAME),
            "--range",
            "0x20-0x7E",
            "--symbols",
            symbols,
            "--format",
            "lvgl",
            "--lv-include",
            "lvgl.h",
            "--lv-font-name",
            LV_FONT_NAME,
            "--output",
            str(output),
        ],
        check=True,
    )

    license_out = repo / "tools" / "fonts" / "FUSION_PIXEL_FONT_OFL.txt"
    license_out.write_bytes((cache / "OFL.txt").read_bytes())
    print(f"wrote {output}")
    print(f"wrote {license_out}")


if __name__ == "__main__":
    main()
