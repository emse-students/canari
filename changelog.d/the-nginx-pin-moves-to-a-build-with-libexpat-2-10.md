### Fixed - the edge nginx pin moves to the rebuild that carries libexpat 2.10

`CVE-2026-115506` (libexpat 2.9.0-r0) turned every pull request's container scan red. Upstream had just rebuilt nginx with libexpat 2.10.0, so the edge pin moved to that build and the three libexpat allowlist entries were deleted ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
