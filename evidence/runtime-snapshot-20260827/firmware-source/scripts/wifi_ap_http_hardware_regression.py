#!/usr/bin/env python3

import argparse
import ctypes
import datetime
import json
import os
import pathlib
import re
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import serial


class HttpStageError(Exception):
    def __init__(self, stage, elapsed_ms, cause, stages=None):
        super().__init__(f"{stage} after {elapsed_ms:.2f} ms: {cause!r}")
        self.stage = stage
        self.elapsed_ms = elapsed_ms
        self.stages = stages or {}


class TimelineRecorder:
    def __init__(self, started_at, output_path=None):
        self.started_at = started_at
        self._lock = threading.Lock()
        self._output_path = pathlib.Path(output_path) if output_path else None
        self._events = []
        if output_path:
            self._output_path.parent.mkdir(parents=True, exist_ok=True)

    def elapsed_s(self):
        return time.monotonic() - self.started_at

    def record(self, kind, **fields):
        if self._output_path is None:
            return
        event = {
            "t_s": round(self.elapsed_s(), 6),
            "wall_time": datetime.datetime.now().astimezone().isoformat(
                timespec="milliseconds"
            ),
            "kind": kind,
            **fields,
        }
        with self._lock:
            self._events.append(event)

    def close(self):
        with self._lock:
            path = self._output_path
            events = self._events
            self._output_path = None
            self._events = []
        if path is None:
            return
        events.sort(key=lambda event: event["t_s"])
        with path.open("w", encoding="utf-8") as stream:
            for event in events:
                stream.write(
                    json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    + "\n"
                )


class SerialMonitor(threading.Thread):
    def __init__(self, uart, stop_event, timeline):
        super().__init__(name="serial-monitor", daemon=True)
        self.uart = uart
        self.stop_event = stop_event
        self.timeline = timeline
        self.serial_data = bytearray()

    def _record_complete_lines(self, pending):
        while b"\n" in pending:
            raw_line, pending = pending.split(b"\n", 1)
            self.timeline.record(
                "serial_line", text=raw_line.rstrip(b"\r").decode("utf-8", "replace")
            )
        return pending

    def run(self):
        pending = b""
        while not self.stop_event.is_set():
            try:
                waiting = self.uart.in_waiting
                chunk = self.uart.read(max(1, waiting))
            except Exception as exc:
                self.timeline.record("serial_error", error=repr(exc))
                break
            if not chunk:
                continue
            self.serial_data.extend(chunk)
            pending += chunk
            pending = self._record_complete_lines(pending)
        if pending:
            self.timeline.record(
                "serial_partial", text=pending.decode("utf-8", "replace")
            )


class IpOptionInformation(ctypes.Structure):
    _fields_ = [
        ("ttl", ctypes.c_ubyte),
        ("tos", ctypes.c_ubyte),
        ("flags", ctypes.c_ubyte),
        ("options_size", ctypes.c_ubyte),
        ("options_data", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class IcmpEchoReply(ctypes.Structure):
    _fields_ = [
        ("address", ctypes.c_ulong),
        ("status", ctypes.c_ulong),
        ("round_trip_time", ctypes.c_ulong),
        ("data_size", ctypes.c_ushort),
        ("reserved", ctypes.c_ushort),
        ("data", ctypes.c_void_p),
        ("options", IpOptionInformation),
    ]


class WindowsIcmpProbe:
    def __init__(self, host):
        self.api = ctypes.WinDLL("iphlpapi", use_last_error=True)
        self.api.IcmpCreateFile.restype = ctypes.c_void_p
        self.api.IcmpSendEcho.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_ushort,
            ctypes.POINTER(IpOptionInformation),
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        self.api.IcmpSendEcho.restype = ctypes.c_ulong
        self.api.IcmpCloseHandle.argtypes = [ctypes.c_void_p]
        self.api.IcmpCloseHandle.restype = ctypes.c_bool
        self.handle = self.api.IcmpCreateFile()
        invalid_handle = ctypes.c_void_p(-1).value
        if not self.handle or self.handle == invalid_handle:
            raise OSError(ctypes.get_last_error(), "IcmpCreateFile failed")
        self.destination = struct.unpack("=I", socket.inet_aton(host))[0]
        self.payload = ctypes.create_string_buffer(b"wireless-debug-probe")
        self.reply_buffer = ctypes.create_string_buffer(
            ctypes.sizeof(IcmpEchoReply) + len(self.payload.raw) + 8
        )

    def send(self, timeout_s):
        ctypes.set_last_error(0)
        count = self.api.IcmpSendEcho(
            self.handle,
            self.destination,
            self.payload,
            len(self.payload.raw),
            None,
            self.reply_buffer,
            len(self.reply_buffer),
            max(1, int(timeout_s * 1000)),
        )
        last_error = ctypes.get_last_error()
        if count == 0:
            return False, None, None, last_error
        reply = ctypes.cast(
            self.reply_buffer, ctypes.POINTER(IcmpEchoReply)
        ).contents
        return reply.status == 0, int(reply.round_trip_time), int(reply.status), last_error

    def close(self):
        if self.handle:
            self.api.IcmpCloseHandle(self.handle)
            self.handle = None


class PingMonitor(threading.Thread):
    def __init__(self, host, interval, timeout, stop_event, timeline):
        super().__init__(name="ping-monitor", daemon=True)
        self.host = host
        self.interval = interval
        self.timeout = timeout
        self.stop_event = stop_event
        self.timeline = timeline
        self.samples = []

    def _command(self):
        timeout_ms = max(1, int(self.timeout * 1000))
        if os.name == "nt":
            return ["ping.exe", "-n", "1", "-w", str(timeout_ms), self.host]
        return ["ping", "-c", "1", "-W", str(max(1, int(self.timeout))), self.host]

    def run(self):
        icmp = None
        if os.name == "nt":
            try:
                icmp = WindowsIcmpProbe(self.host)
            except Exception as exc:
                self.timeline.record("ping_probe_fallback", error=repr(exc))
        next_probe = time.monotonic()
        try:
            while not self.stop_event.is_set():
                probe_started = time.monotonic()
                result = None
                icmp_status = None
                last_error = None
                method = "icmp_api" if icmp is not None else "ping_process"
                try:
                    if icmp is not None:
                        ok, rtt_ms, icmp_status, last_error = icmp.send(self.timeout)
                    else:
                        kwargs = {}
                        if os.name == "nt":
                            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
                        result = subprocess.run(
                            self._command(),
                            stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT,
                            timeout=self.timeout + 1.0,
                            check=False,
                            **kwargs,
                        )
                        output = result.stdout
                        ok = result.returncode == 0 and b"TTL=" in output.upper()
                        match = re.search(
                            rb"[=<]\s*(\d+)ms", output, re.IGNORECASE
                        )
                        rtt_ms = int(match.group(1)) if match else None
                    error = None
                except Exception as exc:
                    ok = False
                    rtt_ms = None
                    error = repr(exc)
                elapsed_ms = (time.monotonic() - probe_started) * 1000.0
                sample = {
                    "t_s": round(probe_started - self.timeline.started_at, 6),
                    "ok": ok,
                    "elapsed_ms": round(elapsed_ms, 2),
                    "rtt_ms": rtt_ms,
                    "icmp_status": icmp_status,
                    "last_error": last_error,
                }
                self.samples.append(sample)
                self.timeline.record(
                    "ping",
                    probe_started_s=sample["t_s"],
                    method=method,
                    ok=ok,
                    elapsed_ms=sample["elapsed_ms"],
                    rtt_ms=rtt_ms,
                    icmp_status=icmp_status,
                    last_error=last_error,
                    returncode=result.returncode if result is not None else None,
                    error=error,
                )
                next_probe += self.interval
                self.stop_event.wait(max(0.0, next_probe - time.monotonic()))
        finally:
            if icmp is not None:
                icmp.close()


class LinkMonitor(threading.Thread):
    def __init__(self, expected_ssid, interval, stop_event, timeline):
        super().__init__(name="link-monitor", daemon=True)
        self.expected_ssid = expected_ssid
        self.interval = interval
        self.stop_event = stop_event
        self.timeline = timeline
        self.samples = []

    def run(self):
        if os.name != "nt":
            self.timeline.record("link_probe", supported=False)
            return
        expected = self.expected_ssid.encode("ascii", "ignore")
        next_probe = time.monotonic()
        while not self.stop_event.is_set():
            probe_started = time.monotonic()
            try:
                result = subprocess.run(
                    ["netsh.exe", "wlan", "show", "interfaces"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=4.0,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                associated = result.returncode == 0 and expected in result.stdout
                error = None
            except Exception as exc:
                associated = False
                error = repr(exc)
                result = None
            sample = {
                "t_s": round(probe_started - self.timeline.started_at, 6),
                "associated": associated,
                "elapsed_ms": round((time.monotonic() - probe_started) * 1000.0, 2),
            }
            self.samples.append(sample)
            self.timeline.record(
                "link_probe",
                supported=True,
                probe_started_s=sample["t_s"],
                expected_ssid=self.expected_ssid,
                associated=associated,
                elapsed_ms=sample["elapsed_ms"],
                returncode=result.returncode if result is not None else None,
                error=error,
            )
            next_probe += self.interval
            self.stop_event.wait(max(0.0, next_probe - time.monotonic()))


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    index = min(len(ordered) - 1, int(len(ordered) * fraction))
    return ordered[index]


def raw_http_get(host, port, path, timeout, on_stage=None):
    started = time.perf_counter()
    stage = "connect"
    stages = {}

    def completed(name):
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        stages[name] = elapsed_ms
        if on_stage is not None:
            on_stage(name, elapsed_ms)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        connected = time.perf_counter()
        completed("connected")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Connection: close\r\n"
            "Accept: application/json\r\n\r\n"
        ).encode("ascii")
        stage = "send"
        sock.sendall(request)
        sent = time.perf_counter()
        completed("sent")

        stage = "first_byte"
        data = bytearray(sock.recv(4096))
        first_byte = time.perf_counter()
        if not data:
            raise ConnectionError("connection closed before response")
        completed("first_byte")

        stage = "body"
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("connection closed before headers")
            data.extend(chunk)
        header, body = bytes(data).split(b"\r\n\r\n", 1)
        lines = header.split(b"\r\n")
        if b" 200 " not in lines[0]:
            raise RuntimeError(lines[0].decode("ascii", "replace"))
        content_length = None
        for line in lines[1:]:
            name, separator, value = line.partition(b":")
            if separator and name.strip().lower() == b"content-length":
                content_length = int(value.strip())
                break
        if content_length is None:
            raise RuntimeError("missing Content-Length")
        while len(body) < content_length:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("connection closed before complete body")
            body += chunk
        finished = time.perf_counter()
        completed("body_complete")
        return body[:content_length], {
            "connect_ms": (connected - started) * 1000.0,
            "first_byte_ms": (first_byte - sent) * 1000.0,
            "body_ms": (finished - first_byte) * 1000.0,
            "total_ms": (finished - started) * 1000.0,
        }
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        raise HttpStageError(stage, elapsed_ms, exc, stages) from exc
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://192.168.4.1")
    parser.add_argument("--port", default="COM4")
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=1.0)
    parser.add_argument("--ping-interval", type=float, default=0.25)
    parser.add_argument("--ping-timeout", type=float, default=0.8)
    parser.add_argument("--link-interval", type=float, default=5.0)
    parser.add_argument("--expected-ssid", default="ESP32-S3_AP_7C9D")
    parser.add_argument("--timeline-output")
    parser.add_argument("--raw-stages", action="store_true")
    args = parser.parse_args()

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    parsed_base = urllib.parse.urlsplit(args.base_url)
    raw_host = parsed_base.hostname
    raw_port = parsed_base.port or 80
    with opener.open(args.base_url + "/api/wifi/status", timeout=args.timeout) as response:
        wifi_status = json.loads(response.read())
    precondition_ok = (
        wifi_status.get("sta_configured") is True
        and wifi_status.get("sta_connected") is False
    )
    if not precondition_ok:
        print(
            json.dumps(
                {
                    "precondition_ok": False,
                    "required": "saved STA configured but disconnected",
                    "wifi_status": wifi_status,
                }
            ),
            flush=True,
        )
        return 2

    uart = serial.Serial()
    uart.port = args.port
    uart.baudrate = 115200
    uart.timeout = 0.1
    uart.dsrdtr = False
    uart.rtscts = False
    uart.dtr = False
    uart.rts = False
    uart.open()

    started_at = time.monotonic()
    timeline = TimelineRecorder(started_at, args.timeline_output)
    stop_event = threading.Event()
    serial_monitor = SerialMonitor(uart, stop_event, timeline)
    ping_monitor = PingMonitor(
        raw_host,
        args.ping_interval,
        args.ping_timeout,
        stop_event,
        timeline,
    )
    link_monitor = LinkMonitor(
        args.expected_ssid,
        args.link_interval,
        stop_event,
        timeline,
    )
    timeline.record(
        "test_start",
        base_url=args.base_url,
        duration_s=args.duration,
        interval_s=args.interval,
        timeout_s=args.timeout,
        ping_interval_s=args.ping_interval,
        wifi_status=wifi_status,
    )
    serial_monitor.start()
    ping_monitor.start()
    link_monitor.start()

    status_latencies = []
    connect_latencies = []
    first_byte_latencies = []
    body_latencies = []
    page_latencies = []
    health_latencies = []
    uptimes = []
    errors = []
    deadline = started_at + args.duration
    next_progress = started_at + 30.0
    next_iteration_at = started_at
    iteration = 0

    try:
        while time.monotonic() < deadline:
            request_started = time.perf_counter()
            request_started_s = timeline.elapsed_s()
            timeline.record(
                "http_request_start",
                route="/api/device/status",
                iteration=iteration,
            )
            try:
                if args.raw_stages:
                    raw, stages = raw_http_get(
                        raw_host,
                        raw_port,
                        "/api/device/status",
                        args.timeout,
                        on_stage=lambda stage_name, elapsed_ms: timeline.record(
                            "http_stage",
                            route="/api/device/status",
                            iteration=iteration,
                            stage=stage_name,
                            request_elapsed_ms=round(elapsed_ms, 2),
                        ),
                    )
                else:
                    with opener.open(
                        args.base_url + "/api/device/status",
                        timeout=args.timeout,
                    ) as response:
                        raw = response.read()
                    stages = {
                        "total_ms": (time.perf_counter() - request_started) * 1000.0
                    }
                status = json.loads(raw)
                if status.get("ok") is not True or "comm_stats" not in status:
                    raise RuntimeError("incomplete status JSON")
                status_latencies.append(stages["total_ms"])
                if args.raw_stages:
                    connect_latencies.append(stages["connect_ms"])
                    first_byte_latencies.append(stages["first_byte_ms"])
                    body_latencies.append(stages["body_ms"])
                timeline.record(
                    "http_request_ok",
                    route="/api/device/status",
                    iteration=iteration,
                    total_ms=round(stages["total_ms"], 2),
                )
            except Exception as exc:
                stage = exc.stage if isinstance(exc, HttpStageError) else "urllib"
                error = {
                    "kind": "status",
                    "iteration": iteration,
                    "request_started_s": round(request_started_s, 6),
                    "request_ended_s": round(timeline.elapsed_s(), 6),
                    "stage": stage,
                    "completed_stages": exc.stages
                    if isinstance(exc, HttpStageError)
                    else {},
                    "error": repr(exc),
                }
                errors.append(error)
                timeline.record("http_request_error", **error)

            if iteration % 20 == 0:
                page_started = time.perf_counter()
                timeline.record(
                    "http_request_start", route="/orig/i.html", iteration=iteration
                )
                try:
                    with opener.open(
                        args.base_url + "/orig/i.html",
                        timeout=args.timeout,
                    ) as response:
                        page = response.read()
                    if len(page) < 100:
                        raise RuntimeError("short page")
                    page_latencies.append(
                        (time.perf_counter() - page_started) * 1000.0
                    )
                    timeline.record(
                        "http_request_ok",
                        route="/orig/i.html",
                        iteration=iteration,
                        total_ms=round(page_latencies[-1], 2),
                    )
                except Exception as exc:
                    error = {
                        "kind": "page",
                        "iteration": iteration,
                        "request_ended_s": round(timeline.elapsed_s(), 6),
                        "error": repr(exc),
                    }
                    errors.append(error)
                    timeline.record("http_request_error", **error)

                health_started = time.perf_counter()
                timeline.record(
                    "http_request_start",
                    route="/api/system/health",
                    iteration=iteration,
                )
                try:
                    with opener.open(
                        args.base_url + "/api/system/health",
                        timeout=args.timeout,
                    ) as response:
                        health = json.loads(response.read())
                    health_latencies.append(
                        (time.perf_counter() - health_started) * 1000.0
                    )
                    uptimes.append(int(health["uptime_ms"]))
                    timeline.record(
                        "http_request_ok",
                        route="/api/system/health",
                        iteration=iteration,
                        total_ms=round(health_latencies[-1], 2),
                        uptime_ms=uptimes[-1],
                    )
                except Exception as exc:
                    error = {
                        "kind": "health",
                        "iteration": iteration,
                        "request_ended_s": round(timeline.elapsed_s(), 6),
                        "error": repr(exc),
                    }
                    errors.append(error)
                    timeline.record("http_request_error", **error)

            iteration += 1
            now = time.monotonic()
            if now >= next_progress:
                print(
                    json.dumps(
                        {
                            "elapsed_s": round(now - started_at, 1),
                            "status_ok": len(status_latencies),
                            "page_ok": len(page_latencies),
                            "health_ok": len(health_latencies),
                            "errors": len(errors),
                        }
                    ),
                    flush=True,
                )
                next_progress += 30.0
            next_iteration_at = max(next_iteration_at + args.interval, now + args.interval)
            time.sleep(
                max(
                    0.0,
                    min(next_iteration_at - time.monotonic(), deadline - time.monotonic()),
                )
            )
    finally:
        stop_event.set()
        serial_monitor.join(timeout=2.0)
        ping_monitor.join(timeout=args.ping_timeout + 2.0)
        link_monitor.join(timeout=5.0)
        uart.close()

    serial_text = serial_monitor.serial_data.decode("utf-8", "replace")
    uptime_monotonic = all(b > a for a, b in zip(uptimes, uptimes[1:]))
    ping_ok = [sample for sample in ping_monitor.samples if sample["ok"]]
    ping_failed = [sample for sample in ping_monitor.samples if not sample["ok"]]
    link_failed = [
        sample for sample in link_monitor.samples if not sample["associated"]
    ]
    status_error_ping_context = []
    for error in errors:
        if error.get("kind") != "status":
            continue
        window_start = error["request_started_s"] - args.ping_interval
        window_end = error["request_ended_s"] + args.ping_interval
        nearby = [
            sample
            for sample in ping_monitor.samples
            if window_start <= sample["t_s"] <= window_end
        ]
        status_error_ping_context.append(
            {
                "iteration": error["iteration"],
                "stage": error["stage"],
                "window_s": [round(window_start, 3), round(window_end, 3)],
                "ping_samples": len(nearby),
                "ping_failures": sum(not sample["ok"] for sample in nearby),
                "ping_elapsed_max_ms": round(
                    max((sample["elapsed_ms"] for sample in nearby), default=0.0), 2
                ),
            }
        )
    summary = {
        "elapsed_s": round(time.monotonic() - started_at, 1),
        "precondition_ok": precondition_ok,
        "wifi_status": wifi_status,
        "status_ok": len(status_latencies),
        "page_ok": len(page_latencies),
        "health_ok": len(health_latencies),
        "error_count": len(errors),
        "errors": errors[:20],
        "status_error_ping_context": status_error_ping_context[:20],
        "status_latency_ms": {
            "median": round(statistics.median(status_latencies), 2),
            "p95": round(percentile(status_latencies, 0.95), 2),
            "max": round(max(status_latencies), 2),
        }
        if status_latencies
        else None,
        "raw_stage_latency_ms": {
            "connect_max": round(max(connect_latencies), 2),
            "first_byte_max": round(max(first_byte_latencies), 2),
            "body_max": round(max(body_latencies), 2),
        }
        if connect_latencies
        else None,
        "page_latency_max_ms": round(max(page_latencies), 2)
        if page_latencies
        else None,
        "health_latency_max_ms": round(max(health_latencies), 2)
        if health_latencies
        else None,
        "uptime_first_last_ms": [uptimes[0], uptimes[-1]] if uptimes else None,
        "uptime_strictly_increasing": uptime_monotonic,
        "ping": {
            "samples": len(ping_monitor.samples),
            "ok": len(ping_ok),
            "failed": len(ping_failed),
            "elapsed_p95_ms": round(
                percentile(
                    [sample["elapsed_ms"] for sample in ping_monitor.samples], 0.95
                ),
                2,
            )
            if ping_monitor.samples
            else None,
            "elapsed_max_ms": round(
                max(sample["elapsed_ms"] for sample in ping_monitor.samples), 2
            )
            if ping_monitor.samples
            else None,
            "rtt_max_ms": max(
                (
                    sample["rtt_ms"]
                    for sample in ping_ok
                    if sample["rtt_ms"] is not None
                ),
                default=None,
            ),
        },
        "link": {
            "samples": len(link_monitor.samples),
            "associated": len(link_monitor.samples) - len(link_failed),
            "not_associated": len(link_failed),
        },
        "serial_auto_scan_lines": serial_text.count("Auto scan channel="),
        "serial_panic_lines": serial_text.count("Guru Meditation"),
        "serial_health_lines": serial_text.count("health: OK"),
        "timeline_output": args.timeline_output,
    }
    timeline.record("test_summary", summary=summary)
    timeline.close()
    print(json.dumps(summary), flush=True)

    expected_status = max(1, int(args.duration / args.interval * 0.8))
    expected_periodic = max(1, expected_status // 20)
    passed = (
        precondition_ok
        and len(status_latencies) >= expected_status
        and len(page_latencies) >= expected_periodic
        and len(health_latencies) >= expected_periodic
        and not errors
        and uptime_monotonic
        and not ping_failed
        and not link_failed
        and summary["serial_auto_scan_lines"] == 0
        and summary["serial_panic_lines"] == 0
    )
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
