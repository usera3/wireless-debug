# Repository Policy

## Tracked content

This repository tracks the buildable ESP-IDF firmware source, tests, scripts, tools,
engineering documentation, configuration, and the active top-level `dist/` SPIFFS
web assets required by firmware builds. Product source and required runtime assets
belong in the repository; generated build output and local runtime state do not.

## Excluded release and recovery content

Release packages, firmware binaries, recovery captures, deployment captures, and
archived source copies must live outside this source repository, such as the GitLab
Release or Package Registry or another approved artifact store. Git records release
metadata rather than embedding packages. Required compressed web assets under
`dist/` remain tracked; they are runtime input, not release archives.

The repository gate rejects `evidence`, `artifacts`, `release`, and `releases`
directory components at any depth; any directory beginning `runtime-snapshot-`;
known copied firmware/frontend/cloud source layouts; firmware and archive suffixes
(`.bin`, `.hex`, `.elf`, `.map`, `.img`, `.uf2`, `.zip`, `.bundle`, `.tar`,
`.tar.gz`, `.tgz`, `.tar.xz`, `.txz`, `.gz`, `.7z`, and `.rar`), with `.gz`
allowed only under the top-level `dist/` runtime-asset tree; and tracked files over
2 MiB. It also rejects common credential filenames and recognizable private-key,
GitLab, GitHub, and AWS token signatures. These checks reduce accidental exposure;
they do not make credentials safe to commit. Never put a credential in Git.

Every GitLab release manifest must include: source SHA, artifact version, artifact
URL, artifact size in bytes, and SHA-256 checksum. Include any target or compatibility
metadata needed to select the artifact, but keep the artifact itself out of Git.

## Branch and directory rules

`standard/main` is the long-lived clean source baseline. Create feature branches from
`standard/main`, review and test them, then merge through the normal protected-branch
workflow. Existing historical branches and tags are preserved; do not rewrite,
force-push, or retag them.

Dated snapshot directories are prohibited anywhere in the tracked tree. In particular,
do not create `runtime-snapshot-*` directories or branches as a release workflow.
Publish release artifacts externally and link them through the release manifest.

## Commit messages

Use Conventional Commits. Examples:

- `feat(wifi): add station reconnect telemetry`
- `fix(web): preserve oscillator view range`
- `docs: clarify release manifest fields`
- `ci: enforce repository hygiene`
- `chore: update ESP-IDF component metadata`
