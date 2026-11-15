### Fixed - a backup restore no longer resumes an outbound salon session at an index already used

A restored Graine session comes back without its sent count, so it is read and never sealed under:
the first salon send after a restore mints a new session ([backup](docs/wiki/frontend/backup.md#a-seed-comes-back-to-read-never-to-seal-under---2026-11-15)).
