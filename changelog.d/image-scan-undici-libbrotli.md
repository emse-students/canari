### Fixed - the image scan's two new advisories are allowlisted, and a purl-scoped entry retires on its own package

npm's bundled `undici` in `node:24-alpine` and Debian's `libbrotli1` in authentik 2026.8.5 have no newer upstream image; each entry is scoped and retires itself, now per package rather than per id ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
