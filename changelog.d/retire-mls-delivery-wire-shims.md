### Removed - bare-string prekeys and the reason-less key-package 404

At `minClientVersion` 1.2.7 a prekey batch must be `[{ keyPackage, notAfter }]` (a bare string is a
400); a `/key-package` 404 naming no reason is `unanswered`, and one naming a reason this build
does not know is `unrecognized`, which keeps the invitation
([key-package-pool](docs/wiki/protocols/key-package-pool.md)).
