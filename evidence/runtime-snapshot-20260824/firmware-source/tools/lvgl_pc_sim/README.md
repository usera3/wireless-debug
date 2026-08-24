# LVGL OLED PC Simulator

This simulator runs the same LVGL page code used by the ESP32-S3 firmware:

- Shared UI: `main/display_ui.c`
- LVGL version: `managed_components/lvgl__lvgl`
- Display size: `128x64`
- Font: `UNSCII 8`
- Backend: LVGL SDL driver under WSL

## VS Code

Open this repository in VS Code and run:

`Terminal > Run Task... > LVGL OLED Simulator: run`

The task uses WSL Ubuntu, builds the simulator, and opens an SDL window scaled to a readable size.

Keyboard controls: `N` or any arrow key cycles the selected item, `Enter` confirms, and `Esc`/`Backspace` returns.

## Manual Commands

From PowerShell:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /mnt/c/Users/mozi/Documents/Codex/2026-06-27/new-chat/work/wireless_debug-main/tools/lvgl_pc_sim && cmake -S . -B build && cmake --build build -j && ./build/lvgl_oled_pc_sim"
```

Close the SDL window to stop the simulator.
