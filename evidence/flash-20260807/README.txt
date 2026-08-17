Wireless Debug ESP32-S3 new-board full flash package
Build date: 2026-08-07
Target: ESP32-S3, 8 MB flash

Recommended method
1. Connect the new board and put it into download mode.
2. Double-click flash_new_board.bat for COM4.
3. For another port, run from Command Prompt:
   flash_new_board.bat COM7
4. Success must include: Hash of data verified.
5. Remove the download-mode jumper if fitted, then reset the board.

Single-image layout
  full_flash_0x0.bin -> flash at offset 0x0

Split-image layout
  0x000000  bootloader.bin
  0x008000  partition-table.bin
  0x010000  uart_ble_wifi.bin
  0x290000  storage.bin

Flash settings
  mode: dio
  frequency: 80m
  size: 8MB
  baud: 460800

SHA-256
  8928721efe3d95eab4b67d7112d0bba1a5e88021359d06228ccea409f8b6b27e  bootloader.bin
  b97d38a2ea6ab2a2d4763e8ece2a01f267e935ac67a4a8dbf67bf3728b78f61d  partition-table.bin
  347ae447ad4dcf25e5db55fd30cb77d9030a0d71dacca3d69fe00e167de0e562  uart_ble_wifi.bin
  1f415c162cdfddcfc7ecfefb6d205fd5e1f7a1cf45d41568c9b92f7544e946fa  storage.bin
  e36592178f0668c6fccf66dbca299a3deca09e5f02c31f95249128cd7a932cab  full_flash_0x0.bin

The package contains the current application firmware and the latest local web UI.
