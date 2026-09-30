### Fixed - five nights with no backup at all

From 2026-09-26 to 2026-09-30 the nightly backup died reaching Authentik through an SSH alias the
new host never had, and took `auth_db` down with it. Authentik runs on the same host, so the
default is now a local dump; nothing reported the failure, which stays open
([backup](docs/wiki/infrastructure/backup.md#five-nights-with-no-backup-at-all-2026-09-26-to-2026-09-30)).
