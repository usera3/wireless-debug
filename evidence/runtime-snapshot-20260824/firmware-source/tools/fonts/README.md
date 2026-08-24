# OLED Display Font

The firmware uses a generated LVGL C font for Chinese text on the 128x64 OLED.

Source font:

- Fusion Pixel Font
- Release: `2026.07.01`
- Source: <https://github.com/TakWolf/fusion-pixel-font>
- License: SIL Open Font License 1.1, copied in `FUSION_PIXEL_FONT_OFL.txt`

Regenerate from the repository root:

```sh
python3 tools/fonts/make_display_font.py
```

The generated output is `main/display_font_fusion_12_zh.c`. It uses 12px,
1bpp glyphs and includes printable ASCII, Chinese punctuation, technical UI
terms, and GB2312 level-1 simplified Chinese characters.
