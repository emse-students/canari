## P3 - Bump the four Alpine pins when upstream rebuilds with brotli 1.2.1 (2026-10-24)

target: 1.9.0

Owner: Master. `CVE-2026-92392` (curl 8.22.0-r0, fixed in 8.23.0-r0) joined it on 2026-10-26 under the same conditions, so the rebuild must carry BOTH fixes and both entries go together. `CVE-2026-117610` and `CVE-2026-118370` (libexpat 2.9.0-r0, fixed in 2.10.0-r0, nginx pins only) joined on 2026-11-03: the rebuild must carry all three, and those two entries go with it. **The nginx half is done (2026-11-06):** the edge pin moved to a build carrying all three fixes and the libexpat entries were deleted; adminer and postgres are what is left. `CVE-2026-111497` (`brotli-libs` 1.2.0-r1) is allowlisted in
`.github/image-scan-allowlist.yaml` because no patched image existed: Alpine fixed it on 2026-10-22
and the official `adminer`, `nginx:1.31.8-alpine`, `nginx:stable-alpine` and `postgres:18-alpine`
builds of that day still carry 1.2.0. Done when the three digest pins (production and dev compose,
the local compose for postgres) move to a rebuild carrying 1.2.1-r0, postgres within major 18. The
floating `nginx:stable-alpine` follows on its own, and the allowlist entry is deleted in the same pull
request - the image scan's retirement check fails until it is
([cicd](../cicd.md#container-images-are-scanned-2026-10-23)). Re-read 2026-11-11: the allowlist still
carries the entries, so no rebuild has been taken; the scheduled image scan names the day one exists.

**2026-11-20: `CVE-2026-86144` (`libxml2` 2.13.9-r2, fixed in 2.13.9-r3) joined it** for the edge `nginx:1.31.8-alpine` and both `postgres:18-alpine` pins, whose newest builds still carry r2. The images built here ship r3 already (`apk upgrade` in `Dockerfile.adminer` and `Dockerfile.frontend`). The rebuild the pins move to must carry r3 too, and that entry is deleted with them; the frontend's `apk upgrade` line goes the day `nginx:stable-alpine` itself carries r3, and adminer's `libxml2` with the rest of that Dockerfile ([legacy-compatibility](../legacy-compatibility.md#removal-once-upstream-adminer-ships-libpq--187-r0---the-adminer-image-this-repository-builds-owner-2026-11-13)).
