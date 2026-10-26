"""Enforce the repository's source-only hygiene policy."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


MAX_FILE_SIZE = 2 * 1024 * 1024
FORBIDDEN_DIRECTORY_COMPONENTS = frozenset(
    {"evidence", "artifacts", "releases", "release"}
)
FORBIDDEN_EXTENSIONS = (
    ".tar.gz",
    ".tar.xz",
    ".bundle",
    ".bin",
    ".zip",
    ".tar",
    ".tgz",
    ".txz",
    ".7z",
    ".rar",
    ".hex",
    ".elf",
    ".map",
    ".img",
    ".uf2",
)
COPIED_SOURCE_MARKERS = (
    "/firmware-source/",
    "/web-source/source/",
    "/cloud-183/source/",
)
RUNTIME_SNAPSHOT_COMPONENT = re.compile(r"runtime-snapshot-", re.IGNORECASE)
CREDENTIAL_FILENAMES = frozenset(
    {"credentials.json", "service-account.json", "id_rsa", "id_ed25519"}
)
ENV_TEMPLATE_FILENAMES = frozenset({".env.example", ".env.sample", ".env.template"})
COMPRESSED_TEST_FIXTURES = frozenset({
    "frontend/fixtures/osc-c52c-local-30s.json.gz",
    "frontend/fixtures/cloud-waveform-integrity-20260729-144603.bin.gz",
})
SECRET_PATTERNS = (
    (
        "possible private key",
        re.compile(br"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"),
    ),
    ("possible GitLab token", re.compile(br"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("possible GitHub token", re.compile(br"\bgh[pousr]_[A-Za-z0-9]{36,255}\b")),
    ("possible AWS access key", re.compile(br"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
)


def normalize_path(path: str) -> str:
    """Return a repository-relative path using forward slashes."""
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def scan_paths(paths: list[tuple[str, int]]) -> list[str]:
    """Return every repository-policy violation for the supplied paths."""
    violations: list[str] = []

    for path, size in paths:
        normalized = normalize_path(path)
        lower_path = normalized.lower()
        components = lower_path.split("/")
        filename = components[-1]

        if any(part in FORBIDDEN_DIRECTORY_COMPONENTS for part in components[:-1]):
            violations.append(f"forbidden release/recovery directory: {normalized}")
        if any(RUNTIME_SNAPSHOT_COMPONENT.match(part) for part in components):
            violations.append(f"forbidden runtime snapshot path: {normalized}")
        forbidden_archive = lower_path.endswith(FORBIDDEN_EXTENSIONS)
        forbidden_gzip = (
            lower_path.endswith(".gz")
            and not lower_path.startswith("dist/")
            and lower_path not in COMPRESSED_TEST_FIXTURES
        )
        if forbidden_archive or forbidden_gzip:
            violations.append(f"forbidden release extension: {normalized}")
        if any(marker in f"/{lower_path}" for marker in COPIED_SOURCE_MARKERS):
            violations.append(f"forbidden copied-source path: {normalized}")
        if filename in CREDENTIAL_FILENAMES or (
            filename.startswith(".env") and filename not in ENV_TEMPLATE_FILENAMES
        ):
            violations.append(f"forbidden credential filename: {normalized}")
        if size > MAX_FILE_SIZE:
            violations.append(
                f"file exceeds {MAX_FILE_SIZE} byte limit ({size} bytes): {normalized}"
            )

    return violations


def scan_contents(files: list[tuple[str, bytes]]) -> list[str]:
    """Return likely credential violations found in tracked file contents."""
    violations: list[str] = []

    for path, content in files:
        normalized = normalize_path(path)
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(content):
                violations.append(f"{label}: {normalized}")

    return violations


def tracked_paths(worktree: Path) -> list[tuple[str, int]]:
    """Read tracked paths and their current worktree sizes."""
    result = subprocess.run(
        ["git", "-C", str(worktree), "ls-files", "-z"],
        check=True,
        stdout=subprocess.PIPE,
    )
    paths: list[tuple[str, int]] = []
    for encoded_path in result.stdout.split(b"\0"):
        if not encoded_path:
            continue
        path = os.fsdecode(encoded_path)
        paths.append((path, (worktree / path).stat().st_size))
    return paths


def main() -> int:
    worktree = Path(__file__).resolve().parent.parent
    paths = tracked_paths(worktree)
    violations = scan_paths(paths)
    contents = [
        (path, (worktree / path).read_bytes())
        for path, size in paths
        if size <= MAX_FILE_SIZE
    ]
    violations.extend(scan_contents(contents))
    if violations:
        print("Repository hygiene check failed:")
        print(*violations, sep="\n")
        return 1

    print("Repository hygiene check passed: no policy violations found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
