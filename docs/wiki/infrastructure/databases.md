# Databases

## PostgreSQL

**Image**: `postgres:18-alpine` in all three compose files since #841 (2026-09-18).  
**Port**: 5432 (container), 5433 (dev host)  
**Database**: `auth_db`

## Reaching it from a workstation

`ssh canari`, then `docker exec` into the container `infrastructure-postgres-1` as user `canari`.
**`auth_db` is the ONLY database** - every service shares it, social-service included, whose
`DB_DATABASE` default `canari_social` **does not exist on prod**; a command that names it fails and
the failure looks like a permissions problem.

**THE CONTAINER NAME IS THE ONLY THING THAT SAYS WHICH ESTATE YOU ARE IN, so read it before you
write.** The same host is to carry a second Postgres for `dev.canari-emse.fr` - compose project
`canari-dev`, so container `canari-dev-postgres-1`, holding a full copy of production's data
([dev-environment](dev-environment.md)). Two containers, the same user, the same database name, the
same table contents: nothing in a `psql` prompt distinguishes them. Prefer selecting by compose
label over typing a name, which is what `infrastructure/dev/copy-prod-to-dev.sh` does and why it
cannot be pointed at production:

```
docker ps --filter label=com.docker.compose.project=infrastructure \
          --filter label=com.docker.compose.service=postgres --format '{{.Names}}'
```

**EITHER TOOL WORKS SINCE 2026-09-02, AND THE RULE THAT SAID "PowerShell, never Bash" NAMED THE
WRONG CULPRIT.** It was never Bash. MSYS `ssh` execs the cloudflared `ProxyCommand` through
`/bin/bash` whatever the caller, and it was the BACKSLASHES in that path, spelled Windows-style,
that were eaten - so the connection died with an opaque error and the tool that happened to be
running got the blame. `~/.ssh/config` now spells the path with FORWARD SLASHES, which `bash` and
`cmd` both exec; measured on both.

**The preference now runs the other way for anything binary.** PowerShell text-encodes stdout, so a
`pg_dump | gzip` routed through it is corrupted on arrival - a backup that restores to nothing. A
dump, a restore, or any pipe carrying bytes rather than text goes through Bash. Text queries may go
through either. Quote SQL single-outer, doubled-inner:

```
ssh canari 'docker exec ... psql -U canari -d auth_db -x -c "SELECT ... WHERE id = ''uuid''"'
```

Single shared database host for all relational data. The database name is `auth_db`; logical separation is by schema/table prefix, not by database.

Table names below are the live production names (TypeORM's default strategy snake_cases the entity
class name, so most are singular unless the entity declares `@Entity('...')`).

| Service | Tables (key ones) |
|---|---|
| core-service | `users` (the personal notepad is a `notes` column, not a table), `platform_config` |
| chat-delivery-service | `key_package`, `one_time_key_package`, `queued_message`, `dm_groups`, `dm_group_members`, `dm_device_group_memberships`, `dm_user_dismissed_groups`, `group_invites`, `mls_commit_log`, `mls_group_info`, `push_token`, `revoked_device`, `pin_verifier` |
| social-service | `channel_workspaces`, `channels`, `channel_members`, `channel_roles`, `channel_messages`, `channel_key_distributions`, `workspace_invites`, `forms`, `submissions`, `form_reminders`, `associations`, `association_members`, `association_products`, `association_categories`, `association_documents`, `purchase_records`, `webhook_deliveries` |

Full schema: see `docs/wiki/architecture.md` (PostgreSQL schema overview section).

### Migrations

NestJS services use TypeORM. In development `synchronize: true` auto-syncs the schema from the
entities; in production `synchronize: false`, so **every entity change needs a hand-written SQL file**
in that service's `src/migrations/` directory or the column simply will not exist in production.

The CD workflow applies them (`.github/workflows/serve-prod.yml`, "Run database migrations"): it collects
`apps/*/src/migrations/*.sql`, sorts by path, and applies each file that is not yet recorded in the
`schema_migrations` ledger (`filename`, `checksum`, `applied_at`), inside the postgres container with
`ON_ERROR_STOP=1`. A failing migration fails the deploy.

Rules, all of them load-bearing:

- **Idempotent, always.** A deploy that dies mid-run leaves later files unrecorded, so the next
  deploy re-runs them. Use `IF NOT EXISTS` / `IF EXISTS`, or a `DO $$ ... IF EXISTS ... $$` guard for
  DDL that has no such clause.
- **Never edit an applied migration.** The checksum is recorded; a changed file only produces a CI
  warning, because production keeps the version it already ran. Write a new migration instead.
- **Quote camelCase columns.** TypeORM's default naming strategy preserves camelCase, so unquoted
  `writePolicy` would be folded to `writepolicy` and the entity would not find it.
- **One number per service directory.** Numbers are per-service and gaps are fine (deleted
  migrations leave holes at 023 and 026-029 in social-service); duplicates are not, because ordering
  then depends on the rest of the filename.
- **One-shot data backfills are a trap.** Before the ledger existed every file replayed on every
  deploy, so a backfill kept re-applying: migration 004 re-granted `MANAGE_STRIPE_CONNECT` and 016
  re-enabled `cotisationEnabled`, silently reverting admin changes. The ledger fixes this going
  forward; keep backfills narrowly conditioned anyway.

The file set is a **patch set, not a schema**. It assumes a database that TypeORM already created;
migration 001 starts with `ALTER TABLE users`. A brand-new production database is bootstrapped from a
backup restore (see `backup.md`), never by replaying migrations.

To check production against the entities, dump `information_schema.columns` and compare with the
`@Column` declarations - drift is silent otherwise.

### Backup

PostgreSQL is backed up daily via `pg_dump -d auth_db --clean --if-exists` (logical dump, gzip). See `docs/wiki/infrastructure/backup.md`.

### Crossing a MAJOR version - the rehearsed procedure

**A datastore major is an OPERATION, not a dependency update, and this section is why.** On
2026-09-01 an auto-merge shipped `postgres:15-alpine -> 18-alpine`, the deploy recreated the
container, and PostgreSQL 18 exited against the existing data directory; all eight backend services
lost `auth_db` - the only database - for 33 minutes. `.github/scripts/lib/ceiling.sh` refuses that
class of update now. This is the procedure that makes the crossing safe, **rehearsed end to end on
2026-09-15 against production's own bytes**; every number below was measured, not estimated.

**PostgreSQL 18 refuses the current layout for two independent reasons, and both have to be answered
in the SAME change.** The catalogue: a 15 cluster is not readable by 18, and `pg_upgrade` needs both
majors' binaries present at once, which no official image carries. The mount: 18+ expects a single
mount at `/var/lib/postgresql` and places the cluster in a major-version subdirectory beneath it
(`PGDATA=/var/lib/postgresql/18/docker`, declared volume `/var/lib/postgresql`), where this
repository mounts `postgres_data` at `/var/lib/postgresql/data`.

**The refusal is deterministic and reproducible** - seed a volume with 15 at the old mount, start 18
on it, and the docker-library entrypoint prints this and exits **1**, before postgres starts:

```
       Counter to that, there appears to be PostgreSQL data in:
         /var/lib/postgresql/data

       This is usually the result of upgrading the Docker image without
       upgrading the underlying database using "pg_upgrade" (which requires both
       versions).
```

**The path is a logical dump and restore, decided rather than defaulted.** `auth_db` is **127 MB**
(133,143,911 bytes, measured on production 2026-09-18; 96 MB on 2026-09-15 and 84 MB on 2026-09-01,
so about 10 MB a day - **re-measure before the window rather than quoting any of the three**). At
that size the restore is seconds, so `pg_upgrade` and a throwaway two-binary image buy nothing and
are not built.

**Step 1 - the dump, off production, THROUGH BASH.** PowerShell text-encodes stdout and destroys a
binary pipe, so a `pg_dump` routed through it is a backup that restores to nothing.

```sh
ssh canari 'docker exec infrastructure-postgres-1 pg_dump -U canari -d auth_db -Fc' > prod-auth_db.dump
```

Measured 2026-09-15: **23,253,358 bytes in 45.8 s**, 282 TOC entries, `Format: CUSTOM`,
`Compression: gzip`. The wall time is the tunnel, not the dump.

**Step 2 - verify the dump is READABLE, not merely written**, which is the whole reason this is a
separate step. `pg_restore --list` reads the archive header; then restore it into a fresh cluster of
the NEW major, with the NEW mount layout:

```sh
docker run -d --name pg18-verify -e POSTGRES_USER=canari -e POSTGRES_PASSWORD=...   -e POSTGRES_DB=auth_db -v pg18_verify_data:/var/lib/postgresql postgres:18-alpine
docker cp prod-auth_db.dump pg18-verify:/tmp/prod.dump
docker exec pg18-verify pg_restore --no-owner --exit-on-error -U canari -d auth_db /tmp/prod.dump
```

Measured: **1.62 s, exit 0, not one line of output.** `--exit-on-error` is not optional - without
it `pg_restore` reports errors and still exits 0, which is a restore that looks clean and is not.

**Step 3 - compare, and know which differences are EXPECTED.** Row counts per table, structural
counts, extensions, collation:

| Checked | Production 15.18 | Restored 18.6 | Reading |
| --- | --- | --- | --- |
| tables | 53 | 53 | same |
| rows, per table | - | - | **50 of 53 identical**; `one_time_key_package`, `post_notifications` and `queued_message` differ |
| indexes | 158 | 158 | same |
| constraints, `c`/`f`/`p`/`u` | 2 / 6 / 53 / 15 | 2 / 6 / 53 / 15 | same |
| constraints, `n` | 0 | 347 | **EXPECTED - see below** |
| enum types | 2 | 2 | same |
| invalid indexes, unvalidated constraints | 0 / 0 | 0 / 0 | same |
| extensions | `pg_trgm plpgsql unaccent uuid-ossp` | identical | same |
| `datcollate` / `datctype` / encoding / locale provider | `en_US.utf8` / `en_US.utf8` / `UTF8` / `c` | identical | same |

**Two of those rows would fail a naive comparison on a CORRECT migration, and both were met.**

- **The three tables that differ are the three that MOVE.** The dump is a snapshot; production is
  live. Reading production TWICE, minutes apart, moved `one_time_key_package` (30293 -> 30315) and
  `post_notifications` (348 -> 349) on its own, and `queued_message` is a queue that drains. A
  differing count on those three is evidence the estate is alive; a differing count on any of the
  other 50 would be evidence of a lost restore. **Compare per table, never a total.**
- **347 constraints appear from nowhere, and none of them are new.** PostgreSQL 17 began
  cataloguing NOT NULL constraints in `pg_constraint`; 15 does not. Broken down by `contype` the
  entire gap is `n`, and every user-meaningful class is identical. A check comparing
  `count(*) FROM pg_constraint` goes red here on a migration that is exactly right.

Then run the application's own hot paths, because a restore can be structurally perfect and still
have lost an extension or a collation. Measured identical on both majors: the `pg_trgm` + `unaccent`
similarity search over `users`, and the `associations` / `association_members` join. Collation is
the real cross-major hazard and it is safe here for a reason worth stating - both images are
Alpine, so both clusters are **musl**, and the sort order does not move underneath the indexes.

**Step 4 - the application on the new major.** Measured 2026-09-15: core-service booted completely
against an 18 cluster holding this data, logged `unaccent + pg_trgm extensions ready` and `Nest
application successfully started`, and served `/api/version` and `/api/chat-delivery-health`.

**Step 5 - the cutover, and it is USER-VISIBLE DOWNTIME ON BOTH ESTATES.** The image tag and the
mount move in ONE commit (#841) and cannot be split: mounting `postgres_data` at
`/var/lib/postgresql` while the image is still 15 gives the 15 entrypoint an empty directory and it
initialises a new cluster over it. Three files change together -
`infrastructure/docker-compose.prod.yml`, `infrastructure/docker-compose.dev.yml`,
`infrastructure/local/docker-compose.yml`.

**A MERGE IS SAFE; A RELEASE IS NOT, and that distinction is the whole scheduling constraint** - an
earlier draft of this section said the commit "cannot be merged ahead of the window", which conflated
the two. `serve-prod.yml` is `workflow_call` and is called by `release.yml` ALONE, on a STABLE,
behind `needs: [build, android, ios]` - some 14 minutes after the tag. `serve-dev.yml` has the same
shape on a pre-release. **Nothing deploys on a push**, so the commit may sit on `main` as long as it
likes; what it must not do is be carried by a RELEASE before the new volumes hold data.

**WHAT A RELEASE AHEAD OF THE WINDOW WOULD DO, AND IT IS WORSE THAN 2026-09-01.** The deploy runs
`git reset --hard <sha>` and then `dc up -d --remove-orphans`, which recreates postgres with the new
image against the new and EMPTY volume. **18 does not refuse that** - a fresh volume is the one case
that always works, so it initialises a clean cluster and reports healthy - while every application
service is recreated beside it pointing at an empty database. Nothing stops until `require_orm_schema`
in `deploy-environment.sh`, several steps later, with *"this is production and its schema is GONE"*.
The 2026-09-01 failure at least crash-looped at once; this one comes up green and serves nothing.

**DEV CROSSES FIRST, AND NOT AS A REHEARSAL.** A stable is refused unless a pre-release served dev at
that same commit (`release-preconditions.sh`), so the pre-release is not optional and it deploys dev.
If `canari-dev-postgres-1` has not crossed by then, the dev deploy dies at the same guard and the
stable can never be cut. Dev holds a logical copy of production (95 MB, 2026-09-18) and
`infrastructure/dev/copy-prod-to-dev.sh` rebuilds it from nothing, so dev needs no dump of its own.

**The sequence on the box.** `ssh canari`; the checkout is `/home/canari/canari` and
`infrastructure/.env` already carries `TAG`, so compose needs nothing added on the command line
(production runs `TAG=latest`, dev `TAG=dev`). The stop list is DERIVED, because a typed one goes
stale the day a service is added - which is the same defect `deploy-environment.sh` fixed for its own
readiness check.

```sh
cd /home/canari/canari
dc() { docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env "$@"; }

# 1. Writes stop, and ONLY the writers: postgres 15 keeps running so it can be dumped.
dc stop $(dc config --services | grep -vE '^(postgres|redis|garage|adminer)$')

# 2. The dump, off a cluster nobody is writing to - and READ IT BACK, which is a separate step
#    because a dump that was written is not a dump that can be restored.
docker exec infrastructure-postgres-1 pg_dump -U canari -d auth_db -Fc > /tmp/cutover.dump
pg_restore --list /tmp/cutover.dump | tail -1

# 3. The new compose, and nothing else from main - the next deploy's `git reset --hard` cleans it up.
git fetch origin main && git checkout origin/main -- infrastructure/docker-compose.prod.yml

# 4. 18 comes up on the NEW volume and builds a clean cluster. `postgres_data` is not touched.
dc up -d postgres && dc exec -T postgres pg_isready -U canari -d auth_db

# 5. The restore. `--exit-on-error` is not optional: without it pg_restore reports errors and still
#    exits 0, which is a restore that looks clean and is not.
docker cp /tmp/cutover.dump infrastructure-postgres-1:/tmp/cutover.dump
dc exec -T postgres pg_restore --no-owner --exit-on-error -U canari -d auth_db /tmp/cutover.dump

# 6. Compare per table, BEFORE a single writer returns - this is the only moment the two clusters
#    can be compared without the live estate moving one of them underneath the count.

# 7. The writers come back.
dc up -d
```

**The rollback is written down BEFORE the window opens, and it is the point of the NEW volume rather
than of the dump.** `postgres_data` is never destroyed and never written to by 18, so rolling back is
`git checkout HEAD -- infrastructure/docker-compose.prod.yml` and `dc up -d` - 15 restarts on the
bytes it left behind, in under a minute. The dump is the SECOND line of defence, not the first. And
the rollback has a deadline nothing enforces: it is good until the first write lands on 18, after
which returning to 15 silently discards it.

---

## MongoDB - REMOVED 2026-08-18

There was a `mongo:latest` container, `chat_db` was declared as its database, and this page said
social-service used it for posts, polls, comments and reactions. **None of it was true.** Those
live in PostgreSQL as TypeORM entities; no service ever held a MongoDB connection string, and the
database `chat_db` was never even created - the instance carried `admin`, `config` and `local` and
nothing else, measured on 2026-08-11 and again on 2026-08-18. `chat-delivery-service` waited on it
to become healthy before booting, which delayed every start for a container it never opened a
socket to. It was still dumped nightly into a 116-byte archive listed in the backup manifest, where
a line reads as a backup.

Service, volumes, `depends_on` and backup step are all gone. The deploy of `40e4f801` removed the
container; `infrastructure_mongo_data` (480 MB), `infrastructure_mongo_config` and `local_mongo_data`
(0 B each) were deleted by hand the same day, since a volume outlives the compose file that named
it. Before deleting the 480 MB, the volume was mounted into a throwaway `mongod` one last time and
asked directly: `admin` 40 KB, `config` 102 KB, `local` 94 KB - **237 KB of MongoDB's own bookkeeping
inside 480 MB of preallocated WiredTiger files**, and not one application byte. That is the third
independent measurement, and the only one taken after the container was already gone.

---

## Redis

**Image**: `redis:alpine`  
**Port**: 6379 (container), 6380 (dev host)

Redis is used for three distinct purposes:

### Pub/Sub channels

| Channel | Producer | Consumer | Payload |
|---|---|---|---|
| `chat:messages` | chat-delivery-service | chat-gateway | `{ recipientId, deviceId, proto, groupId, senderId, … }` |
| `chat:channel_events` | social-service | chat-gateway | `{ type, data, userIds[], timestamp }` |

### Presence keys

`user:online:{userId}:{deviceId}` — TTL 20 seconds, refreshed on each WebSocket Pong. Deleted immediately on clean disconnect.

### History streams

`history:{groupId}` — Redis Stream. Appended to by chat-delivery-service on each `POST /api/mls/send`. Read incrementally by clients via `GET /api/mls/history/:groupId?after=<streamId>`.

### Other keys

| Key | Type | Purpose |
|---|---|---|
| `group:members:{groupId}` | Set | Active device members for a group (for welcome forward) |
| `pending_welcomes:{userId}` | List | WS frames queued while device is offline |
| `mls:addlock:{groupId}` | String | Distributed add-lock, one holder per group (`ADD_LOCK_TTL_SEC`, 30 s) |

Redis is **not persisted** (no AOF/RDB in the default config). Presence and pending frames are ephemeral; history streams are the durable record.

---

## Garage

**Image**: `dxflrs/garage:v2.3.0` (migrated from MinIO 2026-08-14, unmaintained upstream - see
[docker](docker.md))  
**S3 API port**: 3900 (container), configurable dev host port (default 19100, var name
`GARAGE_API_HOST_PORT`)  
**Admin API port**: 3903 (container) - health check and CLI, which MinIO had no equivalent of

S3-compatible object storage. Used exclusively by media-service, through the same generic
`minio` npm S3 client as before (Garage implements every S3 operation it calls).

| Bucket | Contents |
|---|---|
| `canari-media` (`GARAGE_BUCKET`) | Both encrypted media blobs (AES-256-GCM, client-side encrypted) and resized public images (logos, avatars) - `storage.service.ts` puts both in this one bucket. `MINIO_PUBLIC_BUCKET` was not read anywhere in the code (removed 2026-08-07). Every remaining variable was renamed `MINIO_*` -> `GARAGE_*` on 2026-08-18. |

The `garage_data` (object bytes) and `garage_meta` (bucket/key metadata) Docker volumes are
backed up via the deduplicated restic repository in `infrastructure/backup/backup-objects.sh`,
not as a tar archive. See [backup](backup.md).

### Finding every media reference a COPY carries but cannot serve

A copy of production - into `dev.canari-emse.fr` or into a local stack - fetches a Postgres dump and
nothing else. Neither touches Garage, so every media id in the restored rows names a blob that
exists only in production's store, and `infrastructure/lib/copy-strips.sh` clears them all and then
COUNTS what is left, refusing the restore unless the answer is zero.

**That count enumerates COLUMNS, which is a claim about a schema, and it goes stale in silence.** It
reported 0 over three rows that still pointed at production's store on 2026-09-05: a post COMMENT
can carry an attachment, and `posts.comments` is a jsonb array of objects whose `media` sits one
level below anything a column list can see. The feed 404ed while the copy's own verification passed.

**What settles it is asking the database rather than reading harder.** This walks every text and
jsonb column, and it is what found that one - run it against a fresh copy after any schema change
that adds a place a media reference can hide, and add whatever it names to BOTH the strip and the
count in `copy-strips.sh` (which deliberately cannot run this itself: `dev-copy-guards.test.sh`
fails the build if that file so much as mentions `docker exec` or `psql`, because the allowlist of
writable targets belongs in the script that owns the target):

```sh
docker exec canari-local-postgres-1 psql -U admin -d auth_db -tAc "
do \$\$ declare r record; n bigint; begin
  for r in select c.table_name, c.column_name from information_schema.columns c
           join information_schema.tables t on t.table_name = c.table_name
             and t.table_schema = 'public' and t.table_type = 'BASE TABLE'
           where c.table_schema = 'public'
             and c.data_type in ('text','jsonb','character varying') loop
    execute format('select count(*) from %I where %I::text ~ %L',
                   r.table_name, r.column_name, 'mediaId|/api/media/') into n;
    if n > 0 then raise notice 'RESIDUE % . % rows=%', r.table_name, r.column_name, n; end if;
  end loop; end \$\$;"
```

It answered nothing at all on the local estate of 2026-09-05, after the `posts.comments` strip and
the ten that predate it - so the enumeration is complete AS OF that schema, and only as of it.
