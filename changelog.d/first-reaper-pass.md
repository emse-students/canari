### Changed - 43 abandoned device generations revoked on production

The first stage of predicate R, approved by the user: 43 devices with no session, no push token, a newer device of the same platform, and a queue older than 30 days went through the product's own device deletion route. 5 771 queued rows and 173 seats removed, backup kept on the host ([prod-queue-and-epoch-audit](docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#first-reaper-pass---2026-10-12-0920-utc)).
