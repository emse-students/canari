### Fixed - the media backup never held Garage's node key, and nothing reported a failed backup

Garage's `node_key` is root-only, so no restic snapshot ever held it and the nightly run stopped
before its offsite mirror; the backup step now reads as root. A daily `backups` job reads last
night's archive and snapshot, whole and offsite, and goes red when they are not
([backup](docs/wiki/infrastructure/backup.md#five-nights-with-no-backup-at-all-2026-09-26-to-2026-09-30)).
