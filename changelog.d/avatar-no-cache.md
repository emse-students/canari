### Fixed - a changed profile photo shows at once instead of up to 24 h later

The avatar proxy answers `no-cache` with MiGallery's ETag and a `304` on a matching validator ([core-service](docs/wiki/services/core-service.md#no-cache--the-upstream-etag-and-the-busted-url-it-did-not-need-2026-10-08)).
