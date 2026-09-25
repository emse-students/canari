### Fixed - an empty backup variable disables what it says it disables

`BACKUP_SSH_HOST`, `MICONNECT_PG_CONTAINER` and `MICONNECT_SSH_HOST` were read with `:-`, which puts
the default back on an empty value, so none of the three could be switched off - including the
escape hatch `restore.sh` prints. Now `-` ([backup](docs/wiki/infrastructure/backup.md#important-notes)).
