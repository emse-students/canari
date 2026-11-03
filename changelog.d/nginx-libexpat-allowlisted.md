### Fixed - the container image scan, red on two libexpat advisories in the nginx images

`CVE-2026-117610` and `CVE-2026-118370` (libexpat 2.9.0-r0, fixed in Alpine's 2.10.0-r0) were reported in `nginx:1.31.8-alpine` and `nginx:stable-alpine`; no nginx build carries the fix yet, so both are allowlisted by purl and retire with the pins ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
