# Backup system

**Source**: `infrastructure/backup/`  
**Script**: `infrastructure/backup/backup.sh`  
**Schedule**: the `gha-runner` user's crontab on the Portail-etu host, `30 3 * * *` (the systemd
units in `infrastructure/backup/` belonged to the old box and are not installed there)

## Schedule

Daily at 03:30, from `gha-runner`'s crontab on the production host, logging to
`/srv/canari-backups/backup.log`. Can also be run manually:

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
| `MANIFEST.txt` | - | Timestamp, git commit, content description, and where the media are |

Plus, at 04:00, `backup-objects.sh` (`infrastructure_garage_data` + `infrastructure_garage_meta` +
`infrastructure_media_meta` into restic, 14d/8w/6m, `restic check`, rsync mirror to `mitv`).
The object storage backend migrated from MinIO to Garage on 2026-08-14 (MinIO is no longer
maintained upstream) - see [docker](docker.md). Snapshots taken before that date are in the old
`infrastructure_minio_data` format; see the comment at the top of `restore.sh`.

> **MongoDB was REMOVED from the stack on 2026-08-18**, and its dump with it. The instance held no
> application database - only `admin`, `config` and `local`, measured on 2026-08-11 and again on
> 2026-08-18 - and nothing in the codebase ever carried a MongoDB connection string. The encrypted
> MLS history is in **PostgreSQL** (`queued_message`, `mls_*`), inside `postgres_auth_db.sql.gz`.
> The manifest claimed otherwise until 2026-08-11, which is the kind of error that only matters
> once, on the day someone is restoring - and a 116-byte member that stays on the list reads as a
> backup, which is worse than an absent one. Archives taken before 2026-08-18 still carry
> `mongo_chat_db.archive.gz`; `restore.sh` ignores it deliberately.

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
| `MICONNECT_SSH_HOST` | empty | `~/.ssh/config` alias of the box running Authentik; empty = the container runs on this machine, TRUE since 2026-09-24 ([below](#five-nights-with-no-backup-at-all-2026-09-26-to-2026-09-30)) |
| `POSTGRES_USER` | (required) | PostgreSQL user for `pg_dump` |

## Five nights with no backup at all (2026-09-26 to 2026-09-30)

**Measured 2026-09-30**, while checking the day's dump before a MiConnect write: the newest archive
was `canari-backup-20260925-033002`. Every night since, `backup.sh` ran, dumped `auth_db`, then died
on `ssh: Could not resolve hostname authentik-target` - and a failed step aborts the WHOLE archive,
so Canari's own database was not saved either.

**Why.** The cutover of 2026-09-24 put Canari AND Authentik on the Portail-etu host. The migration
plan said `MICONNECT_SSH_HOST` becomes empty again once both stacks meet
([README](../../../infrastructure/backup/README.md)); it stayed `authentik-target` in
`.env.example`, which the deploy renders into `infrastructure/.env`. That alias lived in the OLD
box's `~/.ssh/config`, never in `gha-runner`'s on the new host. Read in `backup.log`: on 09-25 the
script still dumped locally (`Dump PostgreSQL Authentik…`, no `via`); the deploy of that evening
brought the version reading this variable, and from 09-26 every run went `via authentik-target`.
The crontab even said "no
`MICONNECT_SSH_HOST` here, the local path is taken" - true of neither the unset case (the script's
default was the alias) nor the `.env`, which is read after the environment.

**Fixed the same day**: the default and the template are EMPTY (a local `docker exec`), the host's
`.env` and crontab say so explicitly, and a backup run by hand wrote a 58 MB archive
(`authentik_db.sql.gz` 29 MB with the user table, `postgres_auth_db.sql.gz` 31 MB) and copied it
offsite.

**What is NOT fixed: nothing reported it.** Five failed nights reached no one; a missing archive was
found by hand, by a session that happened to look. That is the P1 left open in
[backlog](../backlog.md).

## Restore

```bash
./infrastructure/backup/restore.sh canari-backup-YYYYMMDD-HHMMSS.tar.gz
```

See `infrastructure/backup/README.md` for the full restore procedure.

## Important notes

- The backup dumps are **logical** (not physical), so they are portable across PostgreSQL minor versions.
- media_meta is backed up as a volume tar (and again into restic) — a restore replaces the entire volume.
- **An EMPTY value is a decision, an UNSET one takes the default.** The three variables whose empty value means something - `BACKUP_SSH_HOST`, `MICONNECT_PG_CONTAINER`, `MICONNECT_SSH_HOST` - are read with `${VAR-default}`, never `${VAR:-default}`: `:-` treats empty as unset and puts the default back, so until 2026-09-25 none of the three "empty to ..." rows above was true, and the escape hatch `restore.sh` itself names (`MICONNECT_PG_CONTAINER=`) did not exist. Found by the same construction failing a live test of Sky's backup.
- **The Authentik backup is NOT skipped when its container is absent - the backup FAILS.** Only an empty `MICONNECT_PG_CONTAINER` excludes it, because a value that is set and unreachable is a backup that would succeed without the identities.
- No S3 offsite in the current setup (the `BACKUP_S3_*` variables exist in the script but are not actively used).
- **The restic password is not in `infrastructure/.env` and not a GitHub secret**, because the CD
  rewrites that file on every deploy and a repository whose password changes is unreadable forever.
  It lives at `/home/canari/.config/canari/restic-password` and **must be copied off the machine** —
  the offsite mirror is a copy of an encrypted repository, not a second chance.
- The 15 archives predating the cutover were rewritten in place to drop their media member. They were
  **not deleted**: each one also carries the only backup of the databases for its night.
