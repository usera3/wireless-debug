# Windows USB NCM IPv4 conflict experiment

This experiment temporarily places `192.168.4.2/24` on a **new Microsoft
KM-TEST loopback adapter**, before the ESP32 native USB cable is inserted.
No existing Ethernet, WiFi, VPN, or WSL adapter is reconfigured. No gateway
or DNS is configured on the new test adapter. ESP32 firmware is unchanged.

The test can expose cross-interface duplicate IP or overlapping-route behavior
inside Windows. A software loopback does **not** simulate a second physical
device replying to ARP, a particular USB WiFi driver, or a USB descriptor fault.
A successful or unsuccessful result cannot by itself establish the original
computer's root cause.

## Prepare

Disconnect the ESP32 **native USB** cable; its USB-to-UART cable may stay
connected. Run Windows PowerShell **as administrator**, change to this
firmware worktree, and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Prepare
```

`ExecutionPolicy Bypass` applies only to this process, not the machine policy.
The script uses Windows' signed inbox `netloop.inf` through device-scoped SetupAPI;
it does not download drivers, use a force-update flag, or reboot automatically.
If another loopback or a configured `.2` exists, preparation refuses to change
it. A record in `%LOCALAPPDATA%\WirelessDebug\IpConflictTest\state.json`
stores a unique creation token before any device is registered, then pins the
exact PnP ID and interface GUID before configuring IP. The same token is placed
in a secondary hardware ID on the test device, so an interrupted installation
can be recovered even before a network interface exists. Installation refuses
if **any** other `*MSLOOP` PnP device exists, including incomplete installations.
Driver selection is restricted to `netloop.inf`, and `DI_NOWRITE_IDS` keeps the
unique ownership marker during installation. No hardware-ID-wide driver update
is used.

Only `READY` means the test adapter is Up and `.2` reached `Preferred` state.
Do not treat a created adapter, `Tentative`, `Duplicate`, or a failed script as
successful address occupation. Prepare is idempotent for its own ready adapter.

Dry run (no elevation or network changes):

```powershell
.\scripts\usb_ip_conflict_test.ps1 -Action Prepare -WhatIf
```

## Insert the ESP32 and collect observations

After `READY`, insert native USB into the PC port under test. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Status
```

Status is also the default action and does not change network settings. It
prints NCM link state, IPv4 addresses and address states, DHCP settings,
routes to `192.168.4.0/24`, recent Windows conflict events (4199), and the
owned adapter record. Screenshot or copy the output before restoring.

- NCM missing/Disconnected: investigate device/driver/link first.
- NCM Up with no usable IPv4: inspect DHCP traffic and conflict events.
- NCM `.2` marked Duplicate: Windows rejected that address; DHCP recovery
  still needs an actual packet trace to verify DECLINE and retries.
- NCM `.3` or another Preferred lease: allocation continued; check HTTP
  separately, because two `192.168.4.0/24` interface routes may still exist.

Do not disable Windows duplicate-address detection to make this test pass.

## Restore

Use administrator PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test.ps1 -Action Restore
```

Restore validates the unique ownership token and loopback hardware ID, plus
the saved PnP ID and interface GUID whenever those identities are available.
It can recover its own interrupted creation without adopting an existing
loopback. It removes **only the new owned test device** and
its IP/routes. The small state record remains with `Status: Restored` for
audit/reuse. It never deletes firmware files or changes existing adapters.

Restore even if the experiment succeeded. Reboot does not replace Restore:
the ActiveStore IP is temporary, but the installed test device can persist.
If recovery fails, keep the state file; do not remove devices by a broad name
pattern or delete the state before its exact device is resolved.
If Windows requests a restart to complete removal, the script reports it and
keeps `RestorePending`; restart when convenient and run Restore again. It
never reboots the PC automatically or reports pending removal as complete.

## Non-mutating regression

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\usb_ip_conflict_test_regression.ps1
```

The regression exercises real guard/identity/readiness functions using input
fixtures, compiles the native binding structures, and exercises recovery
orchestration with an in-memory device inventory and a stubbed native boundary.
It does not write any network configuration. Actual elevated
Prepare/Restore is a separate integration test.

## References

- [Microsoft DevCon Install](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/devcon-install)
- [Microsoft device console sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/device-console-devcon-tool/)
- [DHCP conflict handling, RFC 2131 section 4.3.3](https://www.rfc-editor.org/rfc/rfc2131.html#section-4.3.3)
