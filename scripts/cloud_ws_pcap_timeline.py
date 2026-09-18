#!/usr/bin/env python3
"""Reconstruct cloud oscilloscope heartbeat timing from a server-side pcap."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import socket
import struct
from typing import Any, Iterable
import zlib


HEARTBEAT = bytes.fromhex("ff0800000000f5d5")
WAVEFORM_MAGIC = b"WDZ1"
WAVEFORM_HEADER = struct.Struct("!4sB3sII")
MAX_WEBSOCKET_MESSAGE = 4 * 1024 * 1024


Endpoint = tuple[str, int]


def endpoint_text(endpoint: Endpoint) -> str:
    return f"{endpoint[0]}:{endpoint[1]}"


@dataclass
class TcpSegment:
    sequence: int
    data: bytes
    timestamp: float


@dataclass
class ReassembledSection:
    data: bytes
    timestamp_ranges: list[tuple[int, int, float]]
    start_sequence: int

    def completion_timestamp(self, start: int, end: int) -> float:
        timestamps = [
            timestamp
            for range_start, range_end, timestamp in self.timestamp_ranges
            if range_start < end and range_end > start
        ]
        return max(timestamps) if timestamps else 0.0


@dataclass
class TcpFlow:
    client: Endpoint
    server: Endpoint
    client_segments: list[TcpSegment] = field(default_factory=list)
    server_segments: list[TcpSegment] = field(default_factory=list)
    client_payload_bytes: int = 0
    server_payload_bytes: int = 0
    path: str | None = None
    permessage_deflate: bool = False
    client_sections: list[ReassembledSection] = field(default_factory=list)
    server_sections: list[ReassembledSection] = field(default_factory=list)


def read_pcap(path: Path, server_port: int) -> tuple[dict[tuple[Endpoint, Endpoint], TcpFlow], dict[str, Any]]:
    raw = path.read_bytes()
    if len(raw) < 24:
        raise ValueError("pcap header is truncated")
    magic = raw[:4]
    formats = {
        b"\xd4\xc3\xb2\xa1": ("<", 1_000_000),
        b"\xa1\xb2\xc3\xd4": (">", 1_000_000),
        b"\x4d\x3c\xb2\xa1": ("<", 1_000_000_000),
        b"\xa1\xb2\x3c\x4d": (">", 1_000_000_000),
    }
    if magic not in formats:
        raise ValueError("unsupported pcap format")
    endian, timestamp_scale = formats[magic]
    _, _, _, _, _, _, link_type = struct.unpack_from(endian + "IHHIIII", raw, 0)
    if link_type != 1:
        raise ValueError(f"unsupported pcap link type: {link_type}")

    flows: dict[tuple[Endpoint, Endpoint], TcpFlow] = {}
    packet_count = 0
    tcp_payload_packets = 0
    first_timestamp: float | None = None
    last_timestamp: float | None = None
    offset = 24
    while offset + 16 <= len(raw):
        seconds, fraction, captured_len, _ = struct.unpack_from(
            endian + "IIII", raw, offset)
        offset += 16
        if offset + captured_len > len(raw):
            raise ValueError("pcap packet is truncated")
        packet = raw[offset:offset + captured_len]
        offset += captured_len
        packet_count += 1
        timestamp = seconds + fraction / timestamp_scale
        first_timestamp = timestamp if first_timestamp is None else min(first_timestamp, timestamp)
        last_timestamp = timestamp if last_timestamp is None else max(last_timestamp, timestamp)

        parsed = parse_tcp_packet(packet)
        if parsed is None:
            continue
        source, destination, sequence, payload = parsed
        if not payload or (source[1] != server_port and destination[1] != server_port):
            continue
        tcp_payload_packets += 1
        if destination[1] == server_port:
            client, server, from_client = source, destination, True
        else:
            client, server, from_client = destination, source, False
        key = (client, server)
        flow = flows.setdefault(key, TcpFlow(client=client, server=server))
        segment = TcpSegment(sequence=sequence, data=payload, timestamp=timestamp)
        if from_client:
            flow.client_segments.append(segment)
            flow.client_payload_bytes += len(payload)
        else:
            flow.server_segments.append(segment)
            flow.server_payload_bytes += len(payload)

    return flows, {
        "path": str(path),
        "bytes": len(raw),
        "packets": packet_count,
        "tcp_payload_packets": tcp_payload_packets,
        "first_epoch": first_timestamp,
        "last_epoch": last_timestamp,
        "duration_seconds": round((last_timestamp or 0) - (first_timestamp or 0), 6),
    }


def parse_tcp_packet(packet: bytes) -> tuple[Endpoint, Endpoint, int, bytes] | None:
    if len(packet) < 14:
        return None
    ethernet_type = struct.unpack_from("!H", packet, 12)[0]
    ip_offset = 14
    if ethernet_type == 0x8100 and len(packet) >= 18:
        ethernet_type = struct.unpack_from("!H", packet, 16)[0]
        ip_offset = 18
    if ethernet_type != 0x0800 or len(packet) < ip_offset + 20:
        return None
    version_ihl = packet[ip_offset]
    if version_ihl >> 4 != 4:
        return None
    ip_header_len = (version_ihl & 0x0F) * 4
    if ip_header_len < 20 or len(packet) < ip_offset + ip_header_len + 20:
        return None
    if packet[ip_offset + 9] != 6:
        return None
    total_length = struct.unpack_from("!H", packet, ip_offset + 2)[0]
    packet_end = min(len(packet), ip_offset + total_length)
    tcp_offset = ip_offset + ip_header_len
    source_port, destination_port, sequence = struct.unpack_from(
        "!HHI", packet, tcp_offset)
    tcp_header_len = (packet[tcp_offset + 12] >> 4) * 4
    payload_offset = tcp_offset + tcp_header_len
    if tcp_header_len < 20 or payload_offset > packet_end:
        return None
    source = (socket.inet_ntoa(packet[ip_offset + 12:ip_offset + 16]), source_port)
    destination = (
        socket.inet_ntoa(packet[ip_offset + 16:ip_offset + 20]), destination_port)
    return source, destination, sequence, packet[payload_offset:packet_end]


def reassemble(segments: Iterable[TcpSegment]) -> list[ReassembledSection]:
    ordered = sorted(segments, key=lambda item: (item.sequence, item.timestamp))
    sections: list[ReassembledSection] = []
    data = bytearray()
    ranges: list[tuple[int, int, float]] = []
    section_sequence: int | None = None
    expected_sequence: int | None = None

    def finish() -> None:
        nonlocal data, ranges, section_sequence
        if section_sequence is not None and data:
            sections.append(ReassembledSection(
                data=bytes(data),
                timestamp_ranges=ranges,
                start_sequence=section_sequence,
            ))
        data = bytearray()
        ranges = []
        section_sequence = None

    for segment in ordered:
        start = segment.sequence
        end = start + len(segment.data)
        if expected_sequence is None or start > expected_sequence:
            if expected_sequence is not None:
                finish()
            section_sequence = start
            expected_sequence = start
        if end <= expected_sequence:
            continue
        overlap = max(0, expected_sequence - start)
        chunk = segment.data[overlap:]
        range_start = len(data)
        data.extend(chunk)
        ranges.append((range_start, len(data), segment.timestamp))
        expected_sequence += len(chunk)
    finish()
    return sections


def inspect_handshake(flow: TcpFlow) -> None:
    flow.client_sections = reassemble(flow.client_segments)
    flow.server_sections = reassemble(flow.server_segments)
    if flow.client_sections:
        head = flow.client_sections[0].data[:8192]
        if head.startswith(b"GET ") and b"\r\n\r\n" in head:
            request = head[:head.index(b"\r\n\r\n") + 4]
            first_line = request.split(b"\r\n", 1)[0].decode("latin1", "replace")
            parts = first_line.split(" ")
            if len(parts) >= 2:
                flow.path = parts[1]
            flow.permessage_deflate = b"permessage-deflate" in request.lower()
    if flow.server_sections:
        head = flow.server_sections[0].data[:8192]
        if head.startswith(b"HTTP/1.1 101") and b"\r\n\r\n" in head:
            response = head[:head.index(b"\r\n\r\n") + 4]
            flow.permessage_deflate = (
                flow.permessage_deflate or b"permessage-deflate" in response.lower())


def websocket_offset(section: ReassembledSection) -> int:
    if (section.data.startswith(b"GET ") or
            section.data.startswith(b"HTTP/1.1 101")):
        marker = section.data.find(b"\r\n\r\n")
        return marker + 4 if marker >= 0 else len(section.data)
    return 0


class WebSocketDecoder:
    def __init__(self, permessage_deflate: bool, expect_mask: bool) -> None:
        self.permessage_deflate = permessage_deflate
        self.expect_mask = expect_mask
        self.inflater = zlib.decompressobj(wbits=-15) if permessage_deflate else None
        self.fragment_opcode: int | None = None
        self.fragment_compressed = False
        self.fragments = bytearray()
        self.errors: dict[str, int] = {}

    def note_error(self, reason: str) -> None:
        self.errors[reason] = self.errors.get(reason, 0) + 1

    def decode_sections(self, sections: Iterable[ReassembledSection]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for section in sections:
            messages.extend(self.decode_section(section, websocket_offset(section)))
        return messages

    def decode_section(self, section: ReassembledSection, offset: int) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        data = section.data
        while offset + 2 <= len(data):
            frame_start = offset
            first, second = data[offset], data[offset + 1]
            fin = bool(first & 0x80)
            rsv1 = bool(first & 0x40)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            if (first & 0x30 or opcode not in (0, 1, 2, 8, 9, 10) or
                    masked != self.expect_mask or
                    (rsv1 and not self.permessage_deflate)):
                offset += 1
                self.note_error("resync_byte")
                continue
            length = second & 0x7F
            offset += 2
            if length == 126:
                if offset + 2 > len(data):
                    break
                length = struct.unpack_from("!H", data, offset)[0]
                offset += 2
            elif length == 127:
                if offset + 8 > len(data):
                    break
                length = struct.unpack_from("!Q", data, offset)[0]
                offset += 8
            if length > MAX_WEBSOCKET_MESSAGE:
                offset = frame_start + 1
                self.note_error("oversize_frame")
                continue
            mask = b""
            if masked:
                if offset + 4 > len(data):
                    break
                mask = data[offset:offset + 4]
                offset += 4
            frame_end = offset + length
            if frame_end > len(data):
                break
            payload = data[offset:frame_end]
            if masked:
                payload = bytes(
                    value ^ mask[index % 4] for index, value in enumerate(payload))
            offset = frame_end
            timestamp = section.completion_timestamp(frame_start, frame_end)

            if opcode in (8, 9, 10):
                continue
            if opcode in (1, 2):
                if self.fragment_opcode is not None:
                    self.note_error("fragment_restart")
                    self.fragments.clear()
                self.fragment_opcode = opcode
                self.fragment_compressed = rsv1
                self.fragments = bytearray(payload)
            elif opcode == 0:
                if self.fragment_opcode is None:
                    self.note_error("orphan_continuation")
                    continue
                self.fragments.extend(payload)
            if not fin:
                continue
            encoded = bytes(self.fragments)
            compressed = self.fragment_compressed
            message_opcode = self.fragment_opcode
            self.fragments.clear()
            self.fragment_opcode = None
            self.fragment_compressed = False
            if message_opcode is None:
                continue
            if compressed:
                try:
                    assert self.inflater is not None
                    encoded = self.inflater.decompress(encoded + b"\x00\x00\xff\xff")
                except zlib.error:
                    self.note_error("permessage_deflate")
                    self.inflater = zlib.decompressobj(wbits=-15)
                    continue
            messages.append({
                "timestamp": timestamp,
                "opcode": message_opcode,
                "payload": encoded,
            })
        return messages


def decode_waveform_envelope(message: bytes) -> bytes:
    if not message.startswith(WAVEFORM_MAGIC):
        return message
    if len(message) < WAVEFORM_HEADER.size:
        raise ValueError("short waveform envelope")
    magic, codec, reserved, raw_len, checksum = WAVEFORM_HEADER.unpack(
        message[:WAVEFORM_HEADER.size])
    if magic != WAVEFORM_MAGIC or reserved != b"\x00\x00\x00":
        raise ValueError("invalid waveform envelope")
    encoded = message[WAVEFORM_HEADER.size:]
    if codec == 0:
        raw = encoded
    elif codec == 1:
        raw = zlib.decompress(encoded)
    else:
        raise ValueError("unknown waveform codec")
    if len(raw) != raw_len or (zlib.crc32(raw) & 0xFFFFFFFF) != checksum:
        raise ValueError("invalid waveform payload")
    return raw


def heartbeat_events(messages: Iterable[dict[str, Any]], decode_envelope: bool) -> list[float]:
    events: list[float] = []
    for message in messages:
        payload = message["payload"]
        if decode_envelope:
            try:
                payload = decode_waveform_envelope(payload)
            except ValueError:
                continue
        count = payload.count(HEARTBEAT)
        events.extend([float(message["timestamp"])] * count)
    return sorted(events)


def flow_summary(flow: TcpFlow) -> dict[str, Any]:
    return {
        "client": endpoint_text(flow.client),
        "server": endpoint_text(flow.server),
        "path": flow.path,
        "permessage_deflate": flow.permessage_deflate,
        "client_payload_bytes": flow.client_payload_bytes,
        "server_payload_bytes": flow.server_payload_bytes,
        "client_tcp_sections": len(flow.client_sections),
        "server_tcp_sections": len(flow.server_sections),
    }


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def metric_summary(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "mean_ms": round(sum(values) / len(values), 3) if values else 0.0,
        "p50_ms": round(percentile(values, 0.50), 3),
        "p95_ms": round(percentile(values, 0.95), 3),
        "p99_ms": round(percentile(values, 0.99), 3),
        "max_ms": round(max(values), 3) if values else 0.0,
    }


def pair_heartbeat_paths(stages: dict[str, list[float]]) -> list[dict[str, Any]]:
    names = (
        "browser_to_server",
        "server_to_device",
        "device_to_server",
        "server_to_browser",
    )
    counts = [len(stages[name]) for name in names]
    if len(set(counts)) != 1:
        return []
    count = counts[0] if counts else 0
    paths: list[dict[str, Any]] = []
    for index in range(count):
        browser, downlink, uplink, fanout = (
            stages[name][index] for name in names)
        if not browser <= downlink <= uplink <= fanout:
            return []
        paths.append({
            "sequence": index + 1,
            "browser_to_server_epoch": round(browser, 6),
            "server_to_device_epoch": round(downlink, 6),
            "device_to_server_epoch": round(uplink, 6),
            "server_to_browser_epoch": round(fanout, 6),
            "browser_to_device_ms": round((downlink - browser) * 1000, 3),
            "device_round_trip_ms": round((uplink - downlink) * 1000, 3),
            "server_fanout_ms": round((fanout - uplink) * 1000, 3),
            "end_to_end_ms": round((fanout - browser) * 1000, 3),
        })
    return paths


def paired_stage_durations(source: list[float], destination: list[float]) -> list[float]:
    if len(source) != len(destination):
        return []
    durations = [
        (completed - started) * 1000
        for started, completed in zip(source, destination)
    ]
    return durations if all(duration >= 0 for duration in durations) else []


def analyze_heartbeat_stages(stages: dict[str, list[float]]) -> dict[str, Any]:
    browser = stages["browser_to_server"]
    downlink = stages["server_to_device"]
    uplink = stages["device_to_server"]
    fanout = stages["server_to_browser"]
    paths = pair_heartbeat_paths(stages)

    if paths and len(paths) == len(browser):
        correlation = "exact"
    elif (len(browser) == len(downlink) and len(uplink) == len(fanout) and
          len(uplink) > len(browser)):
        correlation = "ambiguous_extra_device_heartbeats"
    else:
        correlation = "ambiguous_stage_counts_or_order"

    return {
        "correlation": correlation,
        "complete_paths": len(paths),
        "metrics": {
            "browser_to_device": metric_summary([
                path["browser_to_device_ms"] for path in paths]),
            "device_round_trip": metric_summary([
                path["device_round_trip_ms"] for path in paths]),
            "server_fanout": metric_summary([
                path["server_fanout_ms"] for path in paths]),
            "end_to_end": metric_summary([
                path["end_to_end_ms"] for path in paths]),
        },
        "link_metrics": {
            "browser_to_device": metric_summary(
                paired_stage_durations(browser, downlink)),
            "server_fanout": metric_summary(
                paired_stage_durations(uplink, fanout)),
        },
        "paths": paths,
    }


def analyze_pcap(path: Path, server_port: int = 18089,
                 device_id: str = "") -> dict[str, Any]:
    flows, capture = read_pcap(path, server_port)
    for flow in flows.values():
        inspect_handshake(flow)
    expected_path = f"/ws/device/{device_id}" if device_id else "/ws/device/"
    browser_candidates = [
        flow for flow in flows.values()
        if flow.path and (
            flow.path == expected_path if device_id else flow.path.startswith(expected_path))
    ]
    if not browser_candidates:
        raise ValueError("browser WebSocket flow was not found")
    browser = max(browser_candidates, key=lambda flow: flow.server_payload_bytes)

    uplink_path = f"/ws/uplink/{device_id}" if device_id else "/ws/uplink/"
    device_candidates = [
        flow for flow in flows.values()
        if flow is not browser and (
            flow.path == uplink_path if device_id else bool(
                flow.path and flow.path.startswith(uplink_path)))
    ]
    if not device_candidates:
        browser_set = set(id(flow) for flow in browser_candidates)
        device_candidates = [
            flow for flow in flows.values()
            if id(flow) not in browser_set and not (
                flow.path and flow.path.startswith("/ws/device/"))
        ]
    if not device_candidates:
        raise ValueError("device uplink WebSocket flow was not found")
    device = max(device_candidates, key=lambda flow: flow.client_payload_bytes)

    decoders = {
        "browser_to_server": WebSocketDecoder(browser.permessage_deflate, True),
        "server_to_browser": WebSocketDecoder(browser.permessage_deflate, False),
        "device_to_server": WebSocketDecoder(device.permessage_deflate, True),
        "server_to_device": WebSocketDecoder(device.permessage_deflate, False),
    }
    messages = {
        "browser_to_server": decoders["browser_to_server"].decode_sections(
            browser.client_sections),
        "server_to_browser": decoders["server_to_browser"].decode_sections(
            browser.server_sections),
        "device_to_server": decoders["device_to_server"].decode_sections(
            device.client_sections),
        "server_to_device": decoders["server_to_device"].decode_sections(
            device.server_sections),
    }
    stages = {
        name: heartbeat_events(stage_messages, decode_envelope=(name == "device_to_server"))
        for name, stage_messages in messages.items()
    }
    heartbeat = analyze_heartbeat_stages(stages)
    heartbeat["counts"] = {name: len(events) for name, events in stages.items()}
    return {
        "capture": capture,
        "flow_count": len(flows),
        "flows": [flow_summary(flow) for flow in flows.values()],
        "selected_flows": {
            "browser": flow_summary(browser),
            "device": flow_summary(device),
        },
        "websocket": {
            name: {
                "messages": len(messages[name]),
                "errors": decoder.errors,
            }
            for name, decoder in decoders.items()
        },
        "heartbeat": heartbeat,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--server-port", type=int, default=18089)
    parser.add_argument("--device-id", default="")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = analyze_pcap(args.input, args.server_port, args.device_id)
    rendered = json.dumps(result, ensure_ascii=True, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
