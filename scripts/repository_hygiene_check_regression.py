"""Regression coverage for repository_hygiene_check."""

import gzip

from repository_hygiene_check import MAX_FILE_SIZE, scan_contents, scan_paths


def assert_path_violation(candidate: tuple[str, int], expected: str) -> None:
    violations = scan_paths([candidate])
    assert expected in violations, (candidate, violations)


def assert_content_violation(path: str, content: bytes, expected: str) -> None:
    violations = scan_contents([(path, content)])
    assert expected in violations, (path, violations)


def main() -> None:
    path_cases = [
        (("evidence/note.txt", 10), "forbidden release/recovery directory: evidence/note.txt"),
        (("nested/artifacts/note.txt", 10), "forbidden release/recovery directory: nested/artifacts/note.txt"),
        (("nested/release/note.txt", 10), "forbidden release/recovery directory: nested/release/note.txt"),
        (("nested/releases/note.txt", 10), "forbidden release/recovery directory: nested/releases/note.txt"),
        (("backup/runtime-snapshot-2026-09-18/README.md", 10), "forbidden runtime snapshot path: backup/runtime-snapshot-2026-09-18/README.md"),
        (("archive/firmware-source/main.c", 10), "forbidden copied-source path: archive/firmware-source/main.c"),
        (("backup/web-source/source/package.json", 10), "forbidden copied-source path: backup/web-source/source/package.json"),
        (("capture/cloud-183/source/app.py", 10), "forbidden copied-source path: capture/cloud-183/source/app.py"),
        (("release-image.BIN", 10), "forbidden release extension: release-image.BIN"),
        (("bundle.ZIP", 10), "forbidden release extension: bundle.ZIP"),
        (("history.bundle", 10), "forbidden release extension: history.bundle"),
        (("firmware.tar", 10), "forbidden release extension: firmware.tar"),
        (("firmware.tar.gz", 10), "forbidden release extension: firmware.tar.gz"),
        (("dist/archive.tar.gz", 10), "forbidden release extension: dist/archive.tar.gz"),
        (("firmware.tgz", 10), "forbidden release extension: firmware.tgz"),
        (("firmware.tar.xz", 10), "forbidden release extension: firmware.tar.xz"),
        (("firmware.txz", 10), "forbidden release extension: firmware.txz"),
        (("backup/firmware.gz", 10), "forbidden release extension: backup/firmware.gz"),
        (("firmware.7z", 10), "forbidden release extension: firmware.7z"),
        (("firmware.rar", 10), "forbidden release extension: firmware.rar"),
        (("firmware.hex", 10), "forbidden release extension: firmware.hex"),
        (("firmware.elf", 10), "forbidden release extension: firmware.elf"),
        (("firmware.map", 10), "forbidden release extension: firmware.map"),
        (("firmware.img", 10), "forbidden release extension: firmware.img"),
        (("firmware.uf2", 10), "forbidden release extension: firmware.uf2"),
        (("fixtures/too-large.dat", MAX_FILE_SIZE + 1), f"file exceeds {MAX_FILE_SIZE} byte limit ({MAX_FILE_SIZE + 1} bytes): fixtures/too-large.dat"),
        ((".env", 10), "forbidden credential filename: .env"),
        (("config/.env.production", 10), "forbidden credential filename: config/.env.production"),
        (("config/credentials.json", 10), "forbidden credential filename: config/credentials.json"),
        (("config/service-account.json", 10), "forbidden credential filename: config/service-account.json"),
        (("keys/id_rsa", 10), "forbidden credential filename: keys/id_rsa"),
        (("keys/id_ed25519", 10), "forbidden credential filename: keys/id_ed25519"),
    ]
    for candidate, expected in path_cases:
        assert_path_violation(candidate, expected)

    allowed = [
        ("main/main.c", 10),
        ("dist/orig/a.js", 10),
        ("dist/ori.html.gz", 10),
        ("dist/orig/a.css.gz", 10),
        ("dist/orig/a.js.gz", 10),
        ("dist/orig/i.html.gz", 10),
        ("dist/orig/x.js.gz", 10),
        ("sdkconfig", 10),
        ("docs/REPOSITORY_POLICY.md", 10),
        (".env.example", 10),
        ("config/.env.sample", 10),
        ("config/.env.template", 10),
        ("./docs/guide.md", MAX_FILE_SIZE),
    ]
    assert scan_paths(allowed) == []

    private_key = b"-----BEGIN " + b"PRIVATE KEY-----\nnot-a-real-key"
    compressed_private_key = gzip.compress(private_key)
    gitlab_token = b"glpat-" + b"a" * 20
    github_token = b"ghp_" + b"a" * 36
    aws_key = b"AKIA" + b"A" * 16
    assert_content_violation("keys/private.pem", private_key, "possible private key: keys/private.pem")
    assert_content_violation("notes/token.txt", gitlab_token, "possible GitLab token: notes/token.txt")
    assert_content_violation("notes/token.txt", github_token, "possible GitHub token: notes/token.txt")
    assert_content_violation("notes/token.txt", aws_key, "possible AWS access key: notes/token.txt")
    assert_path_violation(
        ("backup/private-key.gz", len(compressed_private_key)),
        "forbidden release extension: backup/private-key.gz",
    )
    assert scan_contents([("docs/example.txt", b"placeholder-token")]) == []

    print("repository hygiene regression checks passed")


if __name__ == "__main__":
    main()
