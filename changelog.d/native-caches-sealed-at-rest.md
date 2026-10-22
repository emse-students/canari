### Security - local caches are encrypted at rest and excluded from backups; release builds log no message content

The phone's native seed mirror and push message cache are sealed under a per-install key and kept out of iOS backups, older plaintext copies are sealed on upgrade, and native log lines carry ids and counts only ([mobile](docs/wiki/frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)).
