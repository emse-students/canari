### Fixed - the image scan's two new undici advisories are allowlisted

`CVE-2026-109383` and `CVE-2026-87018` sit on npm's bundled undici 6.28.0 in `node:24-alpine`, which has no patched tag yet; scoped by purl so the rescan retires them ([cicd](docs/wiki/cicd.md)).
