# Storage and retention - audit of 2026-10-11 (DRAFT, paused mid-measurement)

**Status: PARTIAL.** Measured read-only on the Portail-etu host (`ssh portail-etu-direct`, account
in the `docker` group, no root) on 2026-10-11 09:28 UTC, then paused on the owner's request. What is
still unmeasured is listed at the end. The model and history are in
[storage-forecast](storage-forecast.md); the backup scheme in [backup](backup.md); the image prune in
[docker-prune](../../../infrastructure/docker-prune/README.md).

## 1. The host disk

| Measurement | Value |
| --- | --- |
| `/` (`/dev/sda1`) | **45 G, 29 G used, 15 G free, 68 %** (was 88 % on 2026-10-08) |
| Over the 75 % prune threshold? | **No** - the standing image/build-cache prune authorisation does not apply now |
| RAM | 11 Gi, 6.1 Gi available; swap 747 Mi of 4 Gi used |

`docker system df`:

| Type | Total | Size | Reclaimable |
| --- | ---: | ---: | ---: |
| Images | 57 (25 active) | 10.77 GB | **5.13 GB (47 %)** |
| Containers | 32 | 53 kB | 0 |
| Volumes | 18 (15 linked) | 1.78 GB | 0 |
| Build cache | 0 | 0 | 0 (was 6.98 GB on 2026-10-08, so a builder prune ran in between) |

The reclaimable images are dangling `canari/*` layers: each of the 8 Canari repositories holds one
`:dev`, one `:v1.2.3` and **four untagged** previous builds (11 to 24 h old), i.e. ~32 dangling
images, ~2 GB per deploy generation of the eight services. Plus untagged `adminer`, `postgres`,
`redis` layers and `ghcr.io/goauthentik/server:2026.8.0` (1.28 GB, in use).

### Volumes

| Volume | Size |
| --- | ---: |
| `miconnect_database` (Authentik prod) | 450.9 MB |
| `canari-dev_postgres_data_18` | 392.7 MB |
| `canari-prod_postgres_data_18` | **310.3 MB** |
| `canari-prod_garage_data` (prod media blobs) | **153.5 MB** |
| `miconnect-test_database` | 123.4 MB |
| `le-cercle_cercle-data` | 115.8 MB |
| `canari-dev_garage_data` | 103.1 MB |
| `canari-prod_redis_data` | 71.3 MB |
| `canari-dev_redis_data` | 43.8 MB |
| `canari-prod_garage_meta` / `canari-dev_garage_meta` | 6.1 MB / 4.9 MB |
| `canari-prod_media_meta` | 128 kB |
| `canari-{prod,dev}_media_upload_sessions` | 0 B |
| `infrastructure_garage_data`, `infrastructure_garage_meta`, `infrastructure_media_meta` | 0 B, **unlinked** (leftovers of a compose project this host never ran; see [backup](backup.md)) |

### Logs

| Item | Size | Bounded by |
| --- | ---: | --- |
| `/var/log` total | 548 MB | logrotate (cron.daily) |
| `/var/log/journal` | 357 MB | journald defaults (not read as root) |
| `/var/log/nginx` | 62 MB | logrotate |
| `/var/log/aide` | 58 MB | ? (not checked) |
| CrowdSec (`crowdsec_api.log` 12 MB live + ~1.1 MB gz every ~2 days, bouncer 8.9 MB) | ~35 MB | CrowdSec's own rotation; gz files accumulate since 2026-09-15 - no deletion observed |
| Canari containers (16) | capped | `json-file`, `max-size 10m`, `max-file 3` = 30 MB each max |
| **Non-Canari containers** (cercle, sky, portail-etu, miconnect x3, miconnect-test x3) | `miconnect-server-1` 22.7 MB, `miconnect-worker-1` 14.6 MB, `miconnect-test-server-1` 9.4 MB, `miconnect-test-worker-1` 7.2 MB, others < 1 MB | **NOTHING** - `LogConfig.Config` is `{}` and there is no `/etc/docker/daemon.json`, so these grow until the container is recreated |

### Backups (`/srv/canari-backups`, `gha-runner`)

12 nightly archives, 60.4 MB (2026-09-30) to **83.4 MB (2026-10-11)**, ~0.86 GB total, rotated at 14
days by `backup.sh`, mirrored to `mitv`. The archive grows **~2 MB/day**:

| Member | 2026-10-01 | 2026-10-11 |
| --- | ---: | ---: |
| `postgres_auth_db.sql.gz` | 31.1 MB | **49.7 MB** (+60 % in 10 days) |
| `authentik_db.sql.gz` | 30.0 MB | 34.0 MB |
| `media_meta.tar.gz` | 19.8 kB | 24.8 kB |

Restic (`backup-objects.sh`, 04:00): 528 files / 138.9 MiB processed, last run added 5.1 MiB
(1.6 MiB stored); policy 14d/8w/6m with prune after each run. Repository size not readable without
the `gha-runner` account.

Crontab of `gha-runner` (copy `gha-runner.crontab.bak-2026-09-30`): backup 03:30, restic 04:00,
egress probe every minute, Le Cercle backup 04:15, Sky backup 04:45. **No docker prune entry.**

## 2. What is still UNMEASURED (owed at restart)

- The media index by retention class (`ephemeral`/`archive`/`association`/`reel`/unclassified),
  count, bytes, oldest, largest 20, untracked/tombstoned objects, weekly growth - via the
  `media_meta` JSON inside `canari-prod-media-service-1` or `GET /api/mls/admin/storage`.
- `auth_db` per-table sizes (why the dump grew 60 % in 10 days), and the dev database.
- `/var/lib/docker` real size (root only), journald limits, `/var/log/aide` rotation.
- The old VMs: `ssh canari`, `mitv` (offsite backups, restic mirror), `cercle`, `miconnect`.
- The automatic-cleanup inventory from code (media sweep, social ephemeral worker, upload-session
  TTL, outbox/ledger purges, key packages, channel retention) and the last run of each in the logs.
- The projection and the recommendations.
