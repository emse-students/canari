# Docker and services

**Source**: `infrastructure/local/docker-compose.yml`, `infrastructure/docker-compose.dev.yml`,
`infrastructure/docker-compose.prod.yml`

## Compose files

There are THREE, and `docker-compose.dev.yml` does not mean what its name suggests. **It is the
DEPLOYED second estate, not the local stack** - it was rewritten on 2026-09-01 for that role, and it
requires an immutable `TAG` and a full set of dev secrets, so `docker compose -f
docker-compose.dev.yml up` on a workstation fails immediately rather than starting anything. Local
development is the file under `local/`.

| File | Purpose | Host ports |
|---|---|---|
| `local/docker-compose.yml` | **Local development and CI.** Builds from source, plain HTTP, and the only place `ALLOW_INSECURE_COOKIES=true` belongs | yes, all of them |
| `docker-compose.prod.yml` | **Production**, compose project `infrastructure` | only the frontend (`8080`) and Garage tooling |
| `docker-compose.dev.yml` | **`dev.canari-emse.fr`**, compose project `canari-dev`, on the SAME host as production - see [dev-environment](dev-environment.md) | only the frontend (`3080`) and Garage tooling |

## Service graph

```
frontend (Nginx:80)
  |-- chat-gateway:3000         <- depends on redis
  |-- call-service:3004          <- depends on Cloudflare TURN (no internal deps)
  |-- chat-delivery-service:3010 <- depends on postgres, redis
  |-- media-service:3011         <- depends on garage
  |-- core-service:3012          <- depends on postgres
  |-- social-service:3014        <- depends on postgres, core-service, media-service

Infrastructure:
  postgres:5432    <- auth_db (core, chat-delivery, social)
  redis:6379       <- presence, pub/sub, history streams
  garage:3900/3903 <- media blobs (S3 API / admin API)
```

**Migrated from MinIO to [Garage](https://garagehq.deuxfleurs.fr/) on 2026-08-14** (MinIO is no
longer maintained upstream). `apps/media-service` talks to it through the same generic `minio`
npm S3 client as before - Garage implements every S3 operation that client calls
(CreateBucket/HeadBucket, PutObject, GetObject, DeleteObject, ListObjectsV2), so the app code
is unchanged. The env vars kept their `MINIO_*` names for four days and were renamed `GARAGE_*`
on 2026-08-18 (`GARAGE_ENDPOINT`, `GARAGE_PORT`, `GARAGE_USE_SSL`, `GARAGE_BUCKET`, and
`GARAGE_REGION`, required by Garage's SigV4 signing - it must match `s3_region` in
`infrastructure/garage/garage.toml`). What's structurally different, all at the infra layer:

- **No root user, and a minimum-length constraint MinIO never had.** Garage requires an access
  key ID >= 8 characters and a secret >= 16; MinIO enforces neither, and this deployment's
  `MINIO_ROOT_USER` is shorter than that, so it cannot be reused as Garage's key (this crashed
  the container on first prod deploy: `Invalid default access key: Key identifiers should be at
  least 8 characters long`). The container is started with `--single-node --default-bucket` and
  `GARAGE_DEFAULT_ACCESS_KEY`/`GARAGE_DEFAULT_SECRET_KEY`/`GARAGE_DEFAULT_BUCKET` set from
  `GARAGE_ACCESS_KEY_ID`/`GARAGE_SECRET_ACCESS_KEY`/`GARAGE_BUCKET` - Garage self-provisions the
  bucket and grants that exact key on first boot, and it is idempotent on restart (verified
  locally: no duplicate-key error, same key still granted). **That key is the only S3 identity in
  the stack**: media-service authenticates with it directly. Until 2026-08-18 the same two values
  were ALSO written as `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, which is what media-service read -
  one value under two names, verified identical on prod before the mirror was deleted. On the prod
  host this was a one-time, deliberate credential change for media-service at the cutover
  (2026-08-14), not a rotation of MinIO's own root credentials (which the now-removed `minio`
  service read from `MINIO_ROOT_USER`/`PASSWORD`, untouched throughout, and which are deleted
  now - see below). `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` are separate, unrelated secrets
  (cluster RPC and admin-API auth) with no MinIO equivalent.
- **Two volumes, not one.** `garage_meta` (small, LMDB) and `garage_data` (object bytes) replace
  the single `minio_data`. The `minio` service went at the cutover and its volume was kept orphaned
  as a rollback net until 2026-08-18, when it was deleted - see below for what it turned out to hold.

#### The rename to Garage - decided 2026-08-17, DONE 2026-08-18

Every `MINIO_*` variable is a `GARAGE_*` one now, in compose (prod, dev, local), the CD, the
service and the docs. The reason recorded for keeping them - "the app talks through the generic
`minio` npm client" - is a fact about a THIRD-PARTY PACKAGE NAME and was never a reason our own
variables had to carry it. A name that lies about what it configures is read by the next person as
evidence about what is running.

**The credential half turned out to be already done, and this was checked rather than assumed.**
The GitHub secrets were minted with Garage names at the 2026-08-14 cutover
(`GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`);
what carried MinIO names was the CD's own mirror of them into `.env`. Verified on prod before
touching anything, by comparing the values inside the two running containers without printing
them - `GARAGE_DEFAULT_ACCESS_KEY` in `garage` against `MINIO_ACCESS_KEY` in `media-service`, both
SAME - so collapsing the mirror is a rename and not a credential change. Two secrets were genuinely
stale: `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`, which `cd-dev.yml` still required and wrote for
a service removed on 2026-08-14, and which nothing in `docker-compose.dev.yml` ever read. Both are
gone from the workflow; **delete the two repository secrets once a dev deploy has answered**. That
gate is GONE: `cd-dev.yml` was deleted on 2026-09-01
([dev-environment](dev-environment.md#what-is-still-owed-and-by-whom)), so no workflow names those
two secrets any more and they can be deleted unconditionally. One click, owed to the user.

`.env` is regenerated from `.env.example` on every deploy and drops keys that are no longer in it,
so the stale `MINIO_*` lines on the prod host disappear on the next deploy rather than needing a
hand-edit. The non-secret values were read off prod first and matched the compose defaults exactly
(`garage` / `3900` / `false` / `garage` / `canari-media`), which is what makes falling back to
those defaults safe. `MINIO_API_HOST_PORT` was found dead on the way through: `.env.example`
defined it as `19000` while compose has read `GARAGE_API_HOST_PORT` (default `19010`) since the
cutover.

Three boundaries the sweep deliberately did not cross:

- **the npm dependency stays `minio`.** It is what the package is called on the registry; renaming
  an import is not ours to do, and `storage.service.ts` keeps talking S3 through it unchanged.
- **a measurement dated before 2026-08-14 keeps its MinIO wording**, here and in
  [storage-forecast](storage-forecast.md). Those numbers were taken on MinIO; rewriting them would
  falsify a record rather than tidy it. Each says which backend it was measured on.
- **the local dev default credentials still read `minioadmin`.** A local `garage_meta` volume was
  provisioned with that key ID, and changing the literal locks a developer out of their own local
  media until they delete the volume. The variable NAMES around it are Garage.

#### `minio_data` is gone - 2026-08-18, and what it was really holding

The rollback net was meant to stand until 2026-08-28. It was deleted ten days early, on the user's
instruction, and what gated the deletion is worth more than the 47.7 MB it freed.

The volume held **200 object keys**. Garage today holds 306, so the naive check ("the new store has
more") passes - and it is worthless. Comparing the key SETS instead, **five keys in `minio_data`
were absent from Garage**:

```
46f53db5-2609-47cf-8aac-8231ae7c7ffd   5a7f80c9-a921-45e5-92f4-04f52a7c8a7a
8c1264e9-e4a1-4d0f-b6d8-d42771cc3887   ca35beec-d156-4497-b2c5-d7e2b80ccd3c
fedf2767-d86e-4320-b5a4-20cc99148dfd
```

Two readings fit: the migration missed them, or they were migrated and later deleted. They lead to
opposite actions - restore them, or delete them - so the difference had to be settled, not guessed.
**The database cannot settle it**: there is no media table at all, and `channel_messages.attachments`
is `NULL` in every row because an attachment's id travels inside the ciphertext. The server cannot
enumerate what references an object, by design.

What settled it is the line above: `rclone check` counted **200 objects, 0 diffs** at the cutover -
the same 200. All five were therefore in Garage on 2026-08-14 and left it afterwards, through the
only path that removes an object, `storage.service.ts:111`. They are media a user **deleted**.

So the volume was not a safety net at all. **A frozen object store keeps deleted user content
readable for as long as the window lasts** - here, four days past the moment the platform reported
the media gone. Restoring those five would have resurrected them; keeping the volume kept them
alive. Deleting it was the only reading that honours the deletions.

One copy is deliberately left standing: restic snapshots taken before 2026-08-14 still hold
`infrastructure_minio_data`, and they age out on the repository's own 14d/8w/6m schedule. That is a
backup under a stated policy, which is a different thing from a live volume any container could
mount - but it does mean "deleted" is only final once those snapshots expire.

Also removed the same day: `infrastructure_mongo_config` and `local_mongo_data` (0 B, orphaned), and
the `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` repository secrets - unreferenced since the rename, and
credentials to a server whose storage no longer exists.

- **Health check.** MinIO's `/minio/health/live` has no Garage equivalent, and the Garage image
  ships no shell/curl to poll an HTTP endpoint anyway (distroless, only the `/garage` binary) -
  the healthcheck runs `/garage status` instead, which talks to the node over its own RPC socket.
- **Byte migration went through the S3 protocol** (`rclone sync` between the two endpoints), not
  a volume copy - Garage's on-disk format is not MinIO's. Verified with `rclone check` (0 diffs,
  200 objects / 45.370 MiB matching on both sides) before the cutover.
- **`GARAGE_REGION` is required, and its absence is a crash loop, not a degradation.** Garage signs
  with the region configured in `garage.toml` (`garage`); the `minio` npm client defaults to
  `us-east-1` when unset, and the mismatch fails inside `bucketExists` during `onModuleInit` - so
  the service never finishes booting rather than starting in some reduced mode. This line was
  present in the dev/local compose files from the start of the cutover but missed on the prod one,
  which took media-service down in production for about two hours (13:56-16:10Z, 2026-08-14)
  before the missing line was found and added.

## Dev host ports

In dev, each service is offset from its canonical port to avoid conflicts with locally-running services.

| Service | Canonical port | Dev host port |
|---|---|---|
| chat-gateway | 3000 | 3100 |
| call-service | 3004 | 3104 |
| chat-delivery-service | 3010 | 3110 |
| media-service | 3011 | 3111 |
| core-service | 3012 | 3112 |
| social-service | 3014 | 3114 |
| frontend (Nginx) | 80 | 3080 |
| Redis | 6379 | 6380 |
| PostgreSQL | 5432 | 5433 |
| Garage S3 API | 3900 | configurable (`GARAGE_API_HOST_PORT`, default 19010 prod / 19100 dev) |

## Images

All service images are pulled from GHCR:

```
ghcr.io/emse-students/canari/<service>:<tag>
```

`TAG` defaults to `dev` (latest dev build). Production uses `:latest` (built by CI on push to main).

## Starting services

```bash
make run-services      # docker compose up -d
make reload-services   # restart
make reset-services    # restart + clear DBs (drops volumes)
```

Or directly - note the path, which is `local/`:

```bash
docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env up -d
```

**Not `infrastructure/docker-compose.dev.yml`.** That file is the deployed dev estate and refuses to
start without an immutable `TAG`; see the compose-file table above.

## Health checks

chat-delivery-service, Garage and Redis have health checks. Other services depend on `service_started` (no health check gate). The frontend starts once all backend services are running.

## Volumes

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `garage_meta` | Garage cluster/bucket/key metadata (LMDB) |
| `garage_data` | Garage object storage (media blobs) |
| `media_meta` | media-service metadata sidecar |
