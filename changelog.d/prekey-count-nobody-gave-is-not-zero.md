### Fixed - a prekey count that got no answer no longer mints fifty key packages

A request with no answer, a refusal or an answer without a count is a typed `PrekeyCountUnreadableError`; the round mints no one-time package and still refreshes the fallback ([key-package-pool](docs/wiki/protocols/key-package-pool.md#a-count-nobody-gave-is-not-a-zero-2026-11-25)).
