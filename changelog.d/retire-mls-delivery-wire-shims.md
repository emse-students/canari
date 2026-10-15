### Removed - bare-string prekeys and the reason-less key-package 404

At `minClientVersion` 1.2.7 a prekey batch must be `[{ keyPackage, notAfter }]` (a bare string is a
400), and a `/key-package` 404 naming no reason is `unanswered`, not a retirement
([key-package-pool](docs/wiki/protocols/key-package-pool.md)).
