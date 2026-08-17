# Firmware Build Identity

Source base:

```text
branch: wifi-provisioning-fix-20260803
commit: 9be8d1b4ec0f216f10cb2cabb010fc6917bb15f6
cloud uplink schema: 7
```

The source includes the four runtime frontend overlay files now committed under
the repository root's `dist/orig/` directory.

An incremental ESP-IDF 6.0 build was rerun on 2026-08-17 and completed
successfully. Its two variable payloads match the 2026-08-07 package:

```text
347ae447ad4dcf25e5db55fd30cb77d9030a0d71dacca3d69fe00e167de0e562  uart_ble_wifi.bin
1f415c162cdfddcfc7ecfefb6d205fd5e1f7a1cf45d41568c9b92f7544e946fa  storage.bin
```

Use `flash_args` or `flasher_args.json` for split-image flashing. The complete
single-image package is retained separately under `../flash-20260807/`.

