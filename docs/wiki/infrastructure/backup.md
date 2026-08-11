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

**A complete backup is TWO artefacts since the cutover of 2026-08-11**: the nightly archive below,
and a restic repository holding the media blobs. `restore.sh` reads both and refuses to finish if it
can reach neither source for the media.

Each nightly run produces one timestamped archive (`canari-backup-YYYYMMDD-HHMMSS.tar.gz`):

| File | Source | Method |
|---|---|---|
| `postgres_auth_db.sql.gz` | PostgreSQL `auth_db` | `pg_dump --clean --if-exists` in the container |
| `media_meta.tar.gz` | media-service `media_meta` volume | `tar czf` via throwaway Alpine container |
| `authentik_db.sql.gz` | Authentik PostgreSQL | `pg_dump` in the Authentik container (skipped if absent) |
| `mongo_chat_db.archive.gz` | MongoDB `chat_db` | `mongodump` - **empty, see below** |
| `MANIFEST.txt` | - | Timestamp, git commit, content description, and where the media are |

Plus, at 04:00, `backup-objects.sh` (`infrastructure_minio_data` + `infrastructure_media_meta` into
restic, 14d/8w/6m, `restic check`, rsync mirror to `mitv`).

> **`mongo_chat_db.archive.gz` is 116 bytes and that is correct.** Production's MongoDB holds no
> application database - only `admin`, `config` and `local` - and nothing in the codebase carries a
> MongoDB connection string. The encrypted MLS history is in **PostgreSQL** (`queued_message`,
> `mls_*`), inside `postgres_auth_db.sql.gz`. The manifest claimed otherwise until 2026-08-11, which
> is the kind of error that only matters once, on the day someone is restoring. The `mongo` service
> is a residue and is a candidate for removal.

### Why the media are not in the archive

They are client-side encrypted, hence incompressible and immutable. Re-archiving the volume nightly
and keeping 15 made every live byte cost 16 on a 125 GB disk, and the projection at 400 daily users
filled the disk in 9 to 34 days. restic stores deduplicated chunks: a night where nothing changed
cost **24 KB** when measured. The cutover was taken only after a control restore matched the live
volume sha256-identically over 172 objects. Full model:
[storage-forecast](storage-forecast.md).

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
- media_meta is backed up as a volume tar (and again into restic) — a restore replaces the entire volume.
- The Authentik backup is optional; if the container is absent (e.g. on a dev machine), it is skipped with a warning.
- No S3 offsite in the current setup (the `BACKUP_S3_*` variables exist in the script but are not actively used).
- **The restic password is not in `infrastructure/.env` and not a GitHub secret**, because the CD
  rewrites that file on every deploy and a repository whose password changes is unreadable forever.
  It lives at `/home/canari/.config/canari/restic-password` and **must be copied off the machine** —
  the offsite mirror is a copy of an encrypted repository, not a second chance.
- The 15 archives predating the cutover were rewritten in place to drop their media member. They were
  **not deleted**: each one also carries the only backup of the databases for its night.
