### Changed - the offsite backup host is no longer a default in the public repository

`BACKUP_SSH_HOST` has no default any more: the production crontab carries it, an unset value stops the backup instead of dropping the offsite copy ([backup](docs/wiki/infrastructure/backup.md)).
