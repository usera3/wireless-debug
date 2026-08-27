#!/usr/bin/env python3
"""BLE SPP smoke test for the ESP32-S3 wireless_debug firmware.

The firmware exposes a custom NimBLE service:
  service        0000abf0-0000-1000-8000-00805f9b34fb
  characteristic 0000abf1-0000-1000-8000-00805f9b34fb

This script verifies advertising, connection, service discovery, notify
subscription, and characteristic writes. Notification data is optional because
the firmware sends notifications when UART data arrives, not as a write echo.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner


DEFAULT_SERVICE_UUID = "0000abf0-0000-1000-8000-00805f9b34fb"
DEFAULT_CHAR_UUID = "0000abf1-0000-1000-8000-00805f9b34fb"
DEFAULT_NAMES = ("WirelessDBG", "NimBLE")


@dataclass
class ScanMatch:
    address: str
    name: str
    rssi: int | None
    service_uuids: list[str]


def _adv_name(device, adv_data) -> str:
    return (
        getattr(adv_data, "local_name", None)
        or getattr(device, "name", None)
        or ""
    )


def _adv_rssi(device, adv_data) -> int | None:
    rssi = getattr(adv_data, "rssi", None)
    if rssi is None:
        rssi = getattr(device, "rssi", None)
    return rssi


def _adv_service_uuids(adv_data) -> list[str]:
    return [uuid.lower() for uuid in (getattr(adv_data, "service_uuids", None) or [])]


async def scan_target(args: argparse.Namespace) -> ScanMatch:
    service_uuid = args.service_uuid.lower()
    names = tuple(name.strip() for name in args.name if name.strip())
    deadline = time.monotonic() + args.scan_timeout
    best: ScanMatch | None = None

    print(f"Scanning BLE for {args.scan_timeout:.1f}s ...")
    while time.monotonic() < deadline:
        remaining = max(1.0, min(3.0, deadline - time.monotonic()))
        found = await BleakScanner.discover(timeout=remaining, return_adv=True)

        for _, item in found.items():
            if isinstance(item, tuple):
                device, adv_data = item
            else:
                device, adv_data = item, None

            name = _adv_name(device, adv_data)
            service_uuids = _adv_service_uuids(adv_data)
            rssi = _adv_rssi(device, adv_data)
            address = getattr(device, "address", "")
            name_hit = any(token in name for token in names)
            service_hit = service_uuid in service_uuids

            if name or service_uuids:
                print(
                    f"  seen {address} name={name or '-'} "
                    f"rssi={rssi if rssi is not None else '-'} "
                    f"services={','.join(service_uuids) or '-'}"
                )

            if name_hit or service_hit:
                best = ScanMatch(address, name, rssi, service_uuids)
                print(
                    f"Matched target: address={best.address} "
                    f"name={best.name or '-'} rssi={best.rssi if best.rssi is not None else '-'}"
                )
                return best

    raise RuntimeError(
        "Target BLE device not found. Keep the board powered, make sure BLE is "
        "advertising, and check Windows Bluetooth is enabled."
    )


async def run_test(args: argparse.Namespace) -> int:
    target = await scan_target(args)
    notify_event = asyncio.Event()
    notifications: list[bytes] = []

    def on_notify(_: int, data: bytearray) -> None:
        payload = bytes(data)
        notifications.append(payload)
        print(f"Notify: {payload.hex()} ({payload!r})")
        notify_event.set()

    print(f"Connecting to {target.address} ...")
    async with BleakClient(target.address, timeout=args.connect_timeout) as client:
        if not client.is_connected:
            raise RuntimeError("BLE client did not report connected")
        print("Connected.")

        if hasattr(client, "get_services"):
            services = await client.get_services()
        else:
            services = client.services
        service = services.get_service(args.service_uuid)
        if service is None:
            available = [svc.uuid for svc in services]
            raise RuntimeError(f"Custom service not found. Available services: {available}")
        print(f"Found service {service.uuid}")

        char = service.get_characteristic(args.char_uuid)
        if char is None:
            available = [chr_.uuid for chr_ in service.characteristics]
            raise RuntimeError(f"Custom characteristic not found. Available: {available}")
        print(f"Found characteristic {char.uuid}; properties={','.join(char.properties)}")

        if "notify" in char.properties:
            await client.start_notify(char.uuid, on_notify)
            print("Notify subscribed.")
        else:
            print("Characteristic has no notify property; skipping notify subscription.")

        payload = args.payload.encode("utf-8")
        for idx in range(args.repeat):
            data = payload if args.repeat == 1 else payload + f"#{idx + 1}".encode("ascii")
            await client.write_gatt_char(char.uuid, data, response=args.write_with_response)
            print(f"Wrote {len(data)} bytes: {data!r}")
            if args.interval_ms > 0:
                await asyncio.sleep(args.interval_ms / 1000)

        if args.expect_notify:
            try:
                await asyncio.wait_for(notify_event.wait(), timeout=args.notify_timeout)
            except asyncio.TimeoutError as exc:
                raise RuntimeError(
                    "No notification received. This is expected unless UART RX data is "
                    "fed into the board or TX/RX are looped back."
                ) from exc
        elif "notify" in char.properties:
            await asyncio.sleep(args.notify_timeout)

        if "notify" in char.properties:
            await client.stop_notify(char.uuid)
            print("Notify unsubscribed.")

    print("BLE smoke test passed.")
    if notifications:
        print(f"Received {len(notifications)} notification(s).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test ESP32-S3 wireless_debug BLE SPP.")
    parser.add_argument(
        "--name",
        action="append",
        default=list(DEFAULT_NAMES),
        help="Target name token. Can be repeated. Defaults: WirelessDBG and NimBLE.",
    )
    parser.add_argument("--service-uuid", default=DEFAULT_SERVICE_UUID)
    parser.add_argument("--char-uuid", default=DEFAULT_CHAR_UUID)
    parser.add_argument("--scan-timeout", type=float, default=12.0)
    parser.add_argument("--connect-timeout", type=float, default=12.0)
    parser.add_argument("--payload", default="ble-smoke-test")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--interval-ms", type=int, default=100)
    parser.add_argument("--notify-timeout", type=float, default=1.0)
    parser.add_argument(
        "--write-with-response",
        action="store_true",
        help="Use Write Request instead of Write Command.",
    )
    parser.add_argument(
        "--expect-notify",
        action="store_true",
        help="Fail if no notification arrives after writing.",
    )
    return parser.parse_args()


def main() -> int:
    try:
        return asyncio.run(run_test(parse_args()))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
