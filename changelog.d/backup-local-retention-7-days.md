### Changed - the nightly archive is kept 7 days on the host, 14 offsite

`LOCAL_RETENTION_DAYS` (7) now drives the local purge and `BACKUP_RETENTION_DAYS` (14) the offsite one, after the shared host's disk reached 92 %; the archive's growth to ~700 MB is traced to one group's undelivered queue ([backup](docs/wiki/infrastructure/backup.md#retention)).
