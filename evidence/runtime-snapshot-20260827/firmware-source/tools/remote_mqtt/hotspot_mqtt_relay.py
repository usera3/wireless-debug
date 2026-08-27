#!/usr/bin/env python3
"""Expose the local MQTT broker on the Windows hotspot adapter."""

from __future__ import annotations

import argparse
import socket
import threading


DEFAULT_LISTEN_HOST = "192.168.137.1"
DEFAULT_TARGET_HOST = "127.0.0.1"
DEFAULT_PORT = 1883
BUFFER_SIZE = 8192
CONNECT_TIMEOUT_SECONDS = 5


def close_socket(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def pump(src: socket.socket, dst: socket.socket, done: threading.Event) -> None:
    try:
        while not done.is_set():
            data = src.recv(BUFFER_SIZE)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        done.set()


def relay_client(
    client: socket.socket,
    addr: tuple[str, int],
    target_host: str,
    target_port: int,
) -> None:
    print(f"accepted {addr[0]}:{addr[1]}", flush=True)
    target: socket.socket | None = None
    try:
        target = socket.create_connection(
            (target_host, target_port),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
        target.settimeout(None)

        done = threading.Event()
        left = threading.Thread(target=pump, args=(client, target, done), daemon=True)
        right = threading.Thread(target=pump, args=(target, client, done), daemon=True)
        left.start()
        right.start()
        done.wait()
    except OSError as exc:
        print(f"relay error {addr[0]}:{addr[1]} {exc}", flush=True)
    finally:
        close_socket(client)
        if target is not None:
            close_socket(target)
        print(f"closed {addr[0]}:{addr[1]}", flush=True)


def serve(
    listen_host: str,
    listen_port: int,
    target_host: str,
    target_port: int,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((listen_host, listen_port))
    listener.listen(20)
    print(
        f"mqtt relay listening {listen_host}:{listen_port} -> "
        f"{target_host}:{target_port}",
        flush=True,
    )

    try:
        while True:
            client, addr = listener.accept()
            thread = threading.Thread(
                target=relay_client,
                args=(client, addr, target_host, target_port),
                daemon=True,
            )
            thread.start()
    except KeyboardInterrupt:
        print("stopping relay", flush=True)
    finally:
        close_socket(listener)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Forward MQTT traffic from the Windows hotspot adapter to the "
            "local Docker/WSL MQTT listener."
        )
    )
    parser.add_argument("--listen-host", default=DEFAULT_LISTEN_HOST)
    parser.add_argument("--listen-port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--target-host", default=DEFAULT_TARGET_HOST)
    parser.add_argument("--target-port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    serve(args.listen_host, args.listen_port, args.target_host, args.target_port)


if __name__ == "__main__":
    main()
