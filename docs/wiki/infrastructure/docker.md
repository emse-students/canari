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
gone from the workflow, and **the two repository secrets are gone too** - verified 2026-09-02: 69
repository secrets, none matching `MINIO` (`gh secret list --json name`). Nothing in
`.github/workflows/`, `infrastructure/deploy/env-manifest.tsv` or `.env.example` names them either;
the only surviving occurrences are a comment in `docker-compose.prod.yml` and two HARDCODED literals
in `ci.yml`'s boot probe (`MINIO_ROOT_USER=boot-probe`), which read no secret. **This paragraph said
"one click, owed to the user" until that was checked**, which would have sent the user to do
something already done - the reason a doc must name the command that settles it rather than the
intention.

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

**`TAG` defaults to `dev`, and since 2026-09-03 both moving tags mean something narrower than they
used to.** `:latest` is moved by a STABLE release and by nothing else; `:dev` is moved by a
`X.X.X-alpha.N` PRE-RELEASE and by nothing else. Neither is moved by a push. The two exist as an
estate separation rather than as a convenience: a deploy resolves a tag for every service in the
compose file including the ones that were not rebuilt, so a single moving tag would hand one estate
the other's images. Each image also carries its commit sha and its `vX.Y.Z` version, which are the
tags to pin when you need to name an exact build.

## Starting services

```bash
make run-services      # docker compose up -d
make reload-services   # restart
make reset-services    # restart + clear DBs (drops volumes)
```

Or directly - note the path, which is `local/`, **and the project name, which is not the default**:

```bash
docker compose -p canari-local -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env up -d
```

**`-p canari-local` IS PART OF THE COMMAND.** Compose derives the project name from the compose
file's DIRECTORY, so omitting it drives a project called `local` - and this workstation has one, left
by an older checkout under `D:\Documents\...`, whose containers bind 3000, 3010, 3012, 3014 and
9092. Without the flag a `run-services` did `down --remove-orphans` and `up --build` on THAT project
and left the real estate untouched: two estates, conflicting ports, and a `docker compose ps` that
does not describe the one the harness is talking to. Measured 2026-09-04, `docker compose ls` listing
both. The name now lives once, as `LOCAL_PROJECT` in the `Makefile`, and every target goes through
`$(LOCAL_COMPOSE)`.

**Not `infrastructure/docker-compose.dev.yml`.** That file is the deployed dev estate and refuses to
start without an immutable `TAG`; see the compose-file table above.

### The local estate is PLAIN HTTP, and TLS was tried and is not available (2026-09-04)

`http://localhost:8081`. It is not an omission and it is not a "we did not get round to it": a
certificate was minted, nginx terminated TLS on the same port, the browsers trusted it by SPKI pin
and the debug APK carried the CA in an Android network security config. **The phone still could not
reach it.**

**The reason is that a Tauri app has TWO HTTP stacks and only one of them is the WebView.** Page
loads go through the WebView, which honours the network security config; every `fetch` the app makes
goes through the Tauri http plugin, which is Rust `reqwest`. `frontend/src-tauri/Cargo.lock` has
`webpki-roots` and neither `rustls-native-certs` nor `rustls-platform-verifier`, so that client
trusts the bundled Mozilla root set and **nothing else** - not the Android system store, not a
user-installed CA, not the config the WebView reads. Measured: TCP connected to `127.0.0.1:8081` and
every request died as `error sending request for url (https://localhost:8081/...)`. No private
certificate can be trusted there without changing the app.

So the local estate stays HTTP, `ALLOW_INSECURE_COOKIES` stays `true`, and the problem TLS was
reached for - the Android client being handed a `SameSite=Lax` cookie it discards, so it logs itself
out before publishing a key package - is fixed in the CLIENT, where the fact that decides it already
lives: [sessions](../sessions.md#the-credential-a-client-carries-itself).

Three things worth keeping from the attempt:

- **`ALLOW_INSECURE_COOKIES` is read by `core-service` and by nothing else.** Three sibling services
  declared it; the declarations were removed rather than flipped, because a compose file whose job is
  to say what the estate is should not say it three times, wrongly.
- **A second proxy hop makes a server parse headers it only ever generated**, and those headers get
  their own buffer - `proxy_buffering off` streams the body only. This estate's CSP is ~1.5 kB, so
  every page answered `502 Bad Gateway` the moment a TLS listener sat in front of the `:80` one.
- **And the container stayed HEALTHY throughout**, because the probe asked for `/api/version`, the
  one route that sets no CSP - chosen originally because it was cheap and unauthenticated. A probe
  picked for cheapness is a probe selected for not resembling the traffic. It now fetches `/chat` as
  well, so it fails when a user would fail.

### Putting the CURRENT frontend on the local estate

```bash
make local-frontend    # BUILD_WEB=1 build + assert the shape + rebuild BOTH frontend images
```

**A bare `bun run build` produces the wrong artefact and the failure is a SUCCESS.**
`svelte.config.js` picks adapter-**static** unless `BUILD_WEB` is set - deliberately, so a Tauri
build is what you get by default. Both of the estate's frontend images want the other shape:
`Dockerfile.frontend-ssr` does `COPY frontend/build ./` and runs `node index.js`, and
`Dockerfile.frontend` (nginx) copies `frontend/build/client` and `build/prerendered`. A static build
has none of the three, the image builds without complaint, and the container dies on
`Cannot find module '/app/index.js'`.

**Rebuilding `frontend-ssr` alone is not enough either**: nginx holds its own copy of the assets, so
a reloaded client would take the old JS with the new shell. `make local-frontend` builds with
`BUILD_WEB=1`, asserts `index.js` + `client/` + `prerendered/` exist, rebuilds both images and waits
to see the containers survive. A browser already open keeps the old code until it reloads - which is
what `bundle.mjs` in the harness compares and fixes.

## Health checks

chat-delivery-service, Garage and Redis have health checks. Other services depend on `service_started` (no health check gate). The frontend starts once all backend services are running.

## Volumes

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `garage_meta` | Garage cluster/bucket/key metadata (LMDB) |
| `garage_data` | Garage object storage (media blobs) |
| `media_meta` | media-service metadata sidecar |

## The deploy account is root on the host, by way of the `docker` group

`id -Gn` for the account CI and every operator log in as answers `canari sudo users docker`.
**Membership of `docker` is equivalent to root on that machine** - a container that bind-mounts `/`
writes any file on the host, including a systemd unit - and it is required, because that account is
what deploys.

This is written down because the wrong mental model is the natural one. Nothing else in this
repository says the deploy account is privileged, so a reader reasonably treats it as an application
user, and two conclusions follow that are false: that a compromise of it is contained, and that a
task needing root on that box needs a password it does not have. Neither holds. A rotation of a
systemd unit's contents was performed through it on 2026-09-02.

Two consequences worth keeping:

- **`sudo` asking for a password on that host is not a security boundary**, it is a speed bump in
  front of a door the same account can walk through by another route. Treat any capability reachable
  from `docker` as reachable from that login, full stop.
- **A destructive control must therefore carry its own allowlist**, which is why the copy and restore
  scripts name the compose project they may touch rather than trusting the caller's privileges to
  stop them. The rule is in [durable-rules](../durable-rules.md).
