# shellcheck shell=bash
#
# THE CONFIGURATION EVERY BACKUP SCRIPT SHARES, IN ONE PLACE. Sourced by backup.sh,
# backup-objects.sh, restore.sh and backup-report.sh. It was three copies until 2026-09-30, and a
# path that diverges does not break a backup, it breaks the RESTORE - or, for the report, makes it
# check a directory nothing writes to.
#
# Each value may be set by the environment (the production crontab sets several) and is then
# overridden by infrastructure/.env, which every script sources AFTER this file.
#
# `-` AND NOT `:-` FOR THE THREE WHOSE EMPTY VALUE IS A DECISION (MICONNECT_PG_CONTAINER,
# MICONNECT_SSH_HOST, BACKUP_SSH_HOST): `:-` treats empty as unset and puts the default back, so
# "empty to disable" was a comment the code contradicted until 2026-09-25.

BACKUP_DIR="${BACKUP_DIR:-/home/canari/backups}"

# The compose project's name (docker-compose.prod.yml's `name:`): the volumes are mounted by a raw
# `docker run`, outside `docker compose`, so nothing resolves it for us.
CANARI_COMPOSE_PROJECT="${CANARI_COMPOSE_PROJECT:-canari-prod}"

# The Authentik stack's database container. EMPTY is the ONLY way to leave it out: a value that is
# set and unreachable fails the backup, because an archive without the identities that still
# succeeds is worse than one that fails.
MICONNECT_PG_CONTAINER="${MICONNECT_PG_CONTAINER-miconnect-postgresql-1}"

# The box running that container, as a ~/.ssh/config ALIAS (dedicated key, IdentitiesOnly). EMPTY
# = it runs here, which is true since 2026-09-24. The default used to name `authentik-target`, an
# alias only the old application box had, and it failed the WHOLE backup, auth_db included, five
# nights running (2026-09-26 to 2026-09-30). Never the old Authentik VM: it still runs a FROZEN
# copy of the database, which would give a backup that succeeds and lies.
MICONNECT_SSH_HOST="${MICONNECT_SSH_HOST-}"

# The offsite copy over SSH/rsync (the LAN server mitv). Empty to disable.
BACKUP_SSH_HOST="${BACKUP_SSH_HOST-canaribackup@10.0.0.4}"
BACKUP_SSH_PATH="${BACKUP_SSH_PATH:-/srv/canari-backups}"

# The restic repository of the media blobs. Its password is deliberately NOT in
# infrastructure/.env: the CD regenerates that file from the GitHub secrets on every deploy, and a
# repository whose password changes is unreadable forever (infrastructure/MIGRATION.md).
RESTIC_REPO_DIR="${RESTIC_REPO_DIR:-${BACKUP_DIR}/restic-objects}"
RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/home/canari/.cache/restic}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/home/canari/.config/canari/restic-password}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:latest}"
