## P3 - Bump authentik when a release ships Debian's libbrotli1 1.1.0-2+deb13u1 (2026-10-24)

target: 1.9.0

Owner: Master. `CVE-2026-111497` on Debian's `libbrotli1` 1.1.0-2+b7 is allowlisted by purl for
`ghcr.io/goauthentik/server:2026.8.5`, the newest authentik release, which this repository does not
build. Done when an authentik release carries 1.1.0-2+deb13u1 and `AUTHENTIK_TAG` (the compose
default and the host's `.env`) moves to it; the image scan's purl retirement fails on that pull
request until the `libbrotli1` entry is deleted ([cicd](../cicd.md#container-images-are-scanned-2026-10-23)). Re-read 2026-11-11: the entries are still allowlisted.

**Also allowlisted on 2026-10-27 for the same image, same condition (a release that ships them):** dnspython 2.8.0 (`CVE-2026-114605`, fixed in 2.9.0), msgpack 1.2.1 (`CVE-2026-114613`, 1.2.3) and oauthlib 3.3.1 (`CVE-2026-49272`, 4.0.0). Each entry is scoped by purl and retires through the same check, so the bump pull request deletes all four together.

**Frontend build tooling, 2026-10-28:** `GHSA-gcqx-w48m-w2h4` (LOW, `deepmerge` <= 4.3.1, prototype poisoning in `mergeObject()`, no fixed version published) is ignored in the frontend's dependency audit with its reachability argument in `code-analysis.yml`. Delete the ignore when a fixed `deepmerge` reaches the tree; the audit's retirement step fails until it is.
