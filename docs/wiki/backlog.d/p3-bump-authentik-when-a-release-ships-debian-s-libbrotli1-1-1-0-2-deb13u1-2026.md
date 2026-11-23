## P3 - Bump authentik when a release ships Debian's libbrotli1 1.1.0-2+deb13u1 (2026-10-24)

target: 1.9.0

Owner: Master. `CVE-2026-111497` on Debian's `libbrotli1` 1.1.0-2+b7 is allowlisted by purl for
`ghcr.io/goauthentik/server:2026.8.5`, the newest authentik release, which this repository does not
build. Done when an authentik release carries 1.1.0-2+deb13u1 and the literal pin of
`infrastructure/authentik/compose.yml` moves to it (Dependabot opens that pull request since
2026-11-13, and the release deploys it); the image scan's purl retirement fails on that pull
request until the `libbrotli1` entry is deleted ([cicd](../cicd.md#container-images-are-scanned-2026-10-23)). Re-read 2026-11-11: the entries are still allowlisted.

**Also allowlisted on 2026-10-27 for the same image, same condition (a release that ships them):** dnspython 2.8.0 (`CVE-2026-114605`, fixed in 2.9.0), msgpack 1.2.1 (`CVE-2026-114613`, 1.2.3) and oauthlib 3.3.1 (`CVE-2026-49272`, 4.0.0). Each entry is scoped by purl and retires through the same check, so the bump pull request deletes all four together.

**Also allowlisted on 2026-11-16, same image and condition:** aiohttp 3.14.3 (`CVE-2026-128124`, `-128126`, `-128127`, `-128128`, fixed in 3.14.4; authentik's main branch is on 3.14.5, no release yet). Purl-scoped, retired by the same check, deleted by the same bump pull request.

**2026-11-20, authentik 2026.8.6 (#3877) retired every entry above**; setuptools 70.3.0 (`CVE-2025-47273`) still reports and remains. **Also allowlisted on 2026-11-23, same image and condition:** Debian krb5 1.21.3-5+deb13u1 (14 ids, each on the six krb5 client packages, fixed in deb13u2; 2026.8.6 is still the newest release and was not rebuilt). Purl-scoped, retired by the same check, deleted by the bump pull request that moves the pin to a release carrying deb13u2.
