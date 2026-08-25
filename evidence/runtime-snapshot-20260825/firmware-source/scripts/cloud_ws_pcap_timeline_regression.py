#!/usr/bin/env python3
"""Regression coverage for the cloud WebSocket pcap timeline analyzer."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import tempfile
import zlib


SCRIPT_DIR = Path(__file__).resolve().parent
ANALYZER_PATH = SCRIPT_DIR / "cloud_ws_pcap_timeline.py"
HEARTBEAT = bytes.fromhex("ff0800000000f5d5")


def websocket_frame(payload: bytes, *, masked: bool, compressed: bool = False,
                    mask: bytes = b"\x11\x22\x33\x44") -> bytes:
    first = 0x82 | (0x40 if compressed else 0)
    length = len(payload)
    assert length < 126
    second = length | (0x80 if masked else 0)
    if not masked:
        return bytes((first, second)) + payload
    encoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return bytes((first, second)) + mask + encoded


def deflate_message(payload: bytes) -> bytes:
    compressor = zlib.compressobj(level=1, wbits=-15)
    encoded = compressor.compress(payload) + compressor.flush(zlib.Z_SYNC_FLUSH)
    assert encoded.endswith(b"\x00\x00\xff\xff")
    return encoded[:-4]


def waveform_envelope(payload: bytes) -> bytes:
    encoded = zlib.compress(payload, level=1)
    return (
        b"WDZ1\x01\x00\x00\x00"
        + len(payload).to_bytes(4, "big")
        + (zlib.crc32(payload) & 0xFFFFFFFF).to_bytes(4, "big")
        + encoded
    )


def tcp_packet(src: tuple[str, int], dst: tuple[str, int], seq: int,
               payload: bytes) -> bytes:
    ethernet = b"\x00" * 12 + b"\x08\x00"
    total_length = 20 + 20 + len(payload)
    ipv4 = struct.pack(
        "!BBHHHBBH4s4s",
        0x45, 0, total_length, 1, 0, 64, 6, 0,
        socket.inet_aton(src[0]), socket.inet_aton(dst[0]),
    )
    tcp = struct.pack(
        "!HHIIBBHHH",
        src[1], dst[1], seq, 0, 0x50, 0x18, 65535, 0, 0,
    )
    return ethernet + ipv4 + tcp + payload


def write_pcap(path: Path) -> None:
    server = ("10.0.0.1", 18089)
    device = ("10.0.0.2", 41000)
    browser = ("10.0.0.3", 51000)
    request = (
        b"GET /ws/device/wd-test HTTP/1.1\r\n"
        b"Host: 10.0.0.1:18089\r\n"
        b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
        b"Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n"
    )
    response = (
        b"HTTP/1.1 101 Switching Protocols\r\n"
        b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
        b"Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n"
    )

    records: list[tuple[float, bytes]] = []
    sequence = {
        (browser, server): 1000,
        (server, browser): 2000,
        (device, server): 3000,
        (server, device): 4000,
    }

    def add(at: float, src: tuple[str, int], dst: tuple[str, int],
            payload: bytes, *, advance: bool = True,
            seq_override: int | None = None) -> None:
        key = (src, dst)
        seq = sequence[key] if seq_override is None else seq_override
        records.append((at, tcp_packet(src, dst, seq, payload)))
        if advance and seq_override is None:
            sequence[key] += len(payload)

    add(1.000, browser, server, request)
    add(1.010, server, browser, response)

    browser_heartbeat = websocket_frame(
        deflate_message(HEARTBEAT), masked=True, compressed=True)
    split = len(browser_heartbeat) // 2
    add(2.000, browser, server, browser_heartbeat[:split])
    add(2.001, browser, server, browser_heartbeat[:split], advance=False,
        seq_override=sequence[(browser, server)] - split)
    add(2.002, browser, server, browser_heartbeat[split:])
    add(2.050, server, device, websocket_frame(HEARTBEAT, masked=False))
    add(2.150, device, server, websocket_frame(
        waveform_envelope(b"wave" + HEARTBEAT + b"tail"), masked=True))
    add(2.180, server, browser, websocket_frame(
        deflate_message(b"wave" + HEARTBEAT + b"tail"),
        masked=False, compressed=True))

    add(3.000, browser, server, websocket_frame(
        deflate_message(HEARTBEAT), masked=True, compressed=True))
    add(3.080, server, device, websocket_frame(HEARTBEAT, masked=False))
    add(3.260, device, server, websocket_frame(
        waveform_envelope(HEARTBEAT), masked=True))
    add(3.300, server, browser, websocket_frame(
        deflate_message(HEARTBEAT), masked=False, compressed=True))

    with path.open("wb") as output:
        output.write(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1))
        for timestamp, packet in sorted(records):
            seconds = int(timestamp)
            micros = round((timestamp - seconds) * 1_000_000)
            output.write(struct.pack("<IIII", seconds, micros, len(packet), len(packet)))
            output.write(packet)


def load_analyzer():
    assert ANALYZER_PATH.exists(), "cloud WebSocket pcap analyzer is missing"
    spec = importlib.util.spec_from_file_location("cloud_ws_pcap_timeline", ANALYZER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    analyzer = load_analyzer()

    mixed_sources = {
        "browser_to_server": [1.000, 2.000],
        "server_to_device": [1.010, 2.010],
        "device_to_server": [0.500, 1.100, 1.500, 2.100],
        "server_to_browser": [0.510, 1.110, 1.510, 2.110],
    }
    assert hasattr(analyzer, "analyze_heartbeat_stages"), (
        "analyzer must distinguish browser heartbeats from extra device-local keepalives"
    )
    mixed = analyzer.analyze_heartbeat_stages(mixed_sources)
    assert mixed["correlation"] == "ambiguous_extra_device_heartbeats"
    assert mixed["complete_paths"] == 0
    assert mixed["paths"] == []
    assert mixed["metrics"]["device_round_trip"]["count"] == 0
    assert mixed["metrics"]["end_to_end"]["count"] == 0
    assert mixed["link_metrics"]["browser_to_device"] == {
        "count": 2,
        "mean_ms": 10.0,
        "p50_ms": 10.0,
        "p95_ms": 10.0,
        "p99_ms": 10.0,
        "max_ms": 10.0,
    }
    assert mixed["link_metrics"]["server_fanout"] == {
        "count": 4,
        "mean_ms": 10.0,
        "p50_ms": 10.0,
        "p95_ms": 10.0,
        "p99_ms": 10.0,
        "max_ms": 10.0,
    }

    with tempfile.TemporaryDirectory() as temporary:
        pcap_path = Path(temporary) / "timeline.pcap"
        write_pcap(pcap_path)
        result = analyzer.analyze_pcap(pcap_path, server_port=18089,
                                       device_id="wd-test")

    heartbeat = result["heartbeat"]
    assert heartbeat["counts"] == {
        "browser_to_server": 2,
        "server_to_device": 2,
        "device_to_server": 2,
        "server_to_browser": 2,
    }, json.dumps(heartbeat, indent=2)
    assert heartbeat["complete_paths"] == 2
    first, second = heartbeat["paths"]
    assert first["browser_to_server_epoch"] == 2.002
    assert first["server_to_device_epoch"] == 2.05
    assert first["device_to_server_epoch"] == 2.15
    assert first["server_to_browser_epoch"] == 2.18
    assert first["browser_to_device_ms"] == 48.0
    assert first["device_round_trip_ms"] == 100.0
    assert first["server_fanout_ms"] == 30.0
    assert first["end_to_end_ms"] == 178.0
    assert second["end_to_end_ms"] == 300.0
    assert result["selected_flows"]["browser"]["path"] == "/ws/device/wd-test"
    assert result["selected_flows"]["device"]["client"] == "10.0.0.2:41000"
    print("cloud websocket pcap timeline regression passed")


if __name__ == "__main__":
    main()
