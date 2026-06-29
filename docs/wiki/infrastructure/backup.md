# Backup system

**Source**: `infrastructure/backup/`  
**Script**: `infrastructure/backup/backup.sh`  
**Timer**: `infrastructure/backup/canari-backup.timer` (systemd)

## Schedule

Daily at 03:30 via systemd timer (`canari-backup.timer` + `canari-backup.service`). Can also be run manually:

```bash
./infrastructure/backup/backup.sh
```

## What is backed up

Each backup produces a single timestamped archive (`canari-backup-YYYYMMDD-HHMMSS.tar.gz`) containing:

| File | Source | Method |
|---|---|---|
| `postgres_auth_db.sql.gz` | PostgreSQL `auth_db` | `pg_dump --clean --if-exists` in the container |
| `mongo_chat_db.archive.gz` | MongoDB `chat_db` | `mongodump --archive --gzip` in the container |
| `minio_data.tar.gz` | MinIO `minio_data` volume | `tar czf` via throwaway Alpine container |
| `media_meta.tar.gz` | media-service `media_meta` volume | `tar czf` via throwaway Alpine container |
| `authentik_db.sql.gz` | Authentik PostgreSQL | `pg_dump` in the Authentik container (skipped if absent) |
| `MANIFEST.txt` | - | Timestamp, git commit, content description |

## Retention

| Location | Retention |
|---|---|
| Local (`/home/canari/backups/`) | 14 days (`BACKUP_RETENTION_DAYS`, configurable) |
| Offsite (`canaribackup@10.0.0.4:/srv/canari-backups/`) | Same 14-day retention, enforced via SSH |

## Offsite transfer

Archives are pushed via `rsync` over SSH to a LAN server (`mitv`):

```
rsync -az --partial canari-backup-*.tar.gz canaribackup@10.0.0.4:/srv/canari-backups/
```

The SSH key for `canaribackup@10.0.0.4` must be pre-authorized on the offsite server. The transfer uses `BatchMode=yes` (no password prompts); if the host is unreachable, a warning is logged but the backup still completes.

## Configuration variables (in `infrastructure/.env`)

| Variable | Default | Description |
|---|---|---|
| `BACKUP_DIR` | `/home/canari/backups` | Local backup directory |
| `BACKUP_RETENTION_DAYS` | `14` | Days to keep local + offsite archives |
| `BACKUP_SSH_HOST` | `canaribackup@10.0.0.4` | Offsite rsync destination (empty to disable) |
| `BACKUP_SSH_PATH` | `/srv/canari-backups` | Offsite directory |
| `MICONNECT_PG_CONTAINER` | `miconnect-postgresql-1` | Authentik PostgreSQL container name (empty to skip) |
| `POSTGRES_USER` | (required) | PostgreSQL user for `pg_dump` |

## Restore

```bash
./infrastructure/backup/restore.sh canari-backup-YYYYMMDD-HHMMSS.tar.gz
```

See `infrastructure/backup/README.md` for the full restore procedure.

## Important notes

- The backup dumps are **logical** (not physical), so they are portable across PostgreSQL minor versions.
- MinIO and media_meta are backed up as volume tars — a restore replaces the entire volume.
- The Authentik backup is optional; if the container is absent (e.g. on a dev machine), it is skipped with a warning.
- No S3 offsite in the current setup (the `BACKUP_S3_*` variables exist in the script but are not actively used).
