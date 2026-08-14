# Docker and services

**Source**: `infrastructure/docker-compose.dev.yml`, `infrastructure/docker-compose.prod.yml`

## Compose files

| File | Purpose |
|---|---|
| `docker-compose.dev.yml` | Development + CI: all services with host-exposed ports |
| `docker-compose.prod.yml` | Production: same services but `expose:` only (no host ports) |

## Service graph

```
frontend (Nginx:80)
  |-- chat-gateway:3000         <- depends on redis, kafka
  |-- call-service:3004          <- depends on Cloudflare TURN (no internal deps)
  |-- chat-delivery-service:3010 <- depends on postgres, redis, kafka, mongo
  |-- media-service:3011         <- depends on garage
  |-- core-service:3012          <- depends on postgres
  |-- social-service:3014        <- depends on postgres, core-service, media-service

Infrastructure:
  postgres:5432    <- auth_db (core, chat-delivery, social)
  mongo:27017      <- chat_db (posts, MLS history blobs)
  redis:6379       <- presence, pub/sub, history streams
  kafka:29092      <- async events
  zookeeper:2181   <- Kafka coordinator
  garage:3900/3903 <- media blobs (S3 API / admin API)
```

**Migrated from MinIO to [Garage](https://garagehq.deuxfleurs.fr/) on 2026-08-14** (MinIO is no
longer maintained upstream). `apps/media-service` talks to it through the same generic `minio`
npm S3 client as before - Garage implements every S3 operation that client calls
(CreateBucket/HeadBucket, PutObject, GetObject, DeleteObject, ListObjectsV2), so the app code
is unchanged. Every env var keeps its `MINIO_*` name for that reason (`MINIO_ENDPOINT`,
`MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, plus a new `MINIO_REGION`
required by Garage's SigV4 signing - unset for MinIO, `garage` for Garage, must match
`s3_region` in `infrastructure/garage/garage.toml`). What's structurally different, all at the
infra layer:

- **No root user.** Garage has no MinIO-style admin credential that doubles as an S3 key. The
  container is started with `--single-node --default-bucket` and
  `GARAGE_DEFAULT_ACCESS_KEY`/`GARAGE_DEFAULT_SECRET_KEY`/`GARAGE_DEFAULT_BUCKET` set to the
  *same* values as `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_BUCKET` - Garage self-provisions
  the bucket and grants that exact key on first boot, so the app's credentials never need to be
  rotated. `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` are new, unrelated secrets (cluster RPC
  and admin-API auth) with no MinIO equivalent.
- **Two volumes, not one.** `garage_meta` (small, LMDB) and `garage_data` (object bytes) replace
  the single `minio_data`. On the production host, `minio_data` was kept for a 14-day rollback
  window after the cutover, then removed.
- **Health check.** MinIO's `/minio/health/live` has no Garage equivalent, and the Garage image
  ships no shell/curl to poll an HTTP endpoint anyway (distroless, only the `/garage` binary) -
  the healthcheck runs `/garage status` instead, which talks to the node over its own RPC socket.
- **Byte migration went through the S3 protocol** (`rclone sync` between the two endpoints), not
  a volume copy - Garage's on-disk format is not MinIO's.

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
| MongoDB | 27017 | 27018 |
| Kafka (external) | 9092 | 9093 |
| Garage S3 API | 3900 | configurable (`MINIO_API_HOST_PORT`, default 19100 - name kept from MinIO) |

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

Or directly:

```bash
cd infrastructure
docker compose -f docker-compose.dev.yml up -d
```

## Health checks

chat-delivery-service, Garage, Redis, and Kafka have health checks. Other services depend on `service_started` (no health check gate). The frontend starts once all backend services are running.

## Volumes

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `mongo_data` | MongoDB data directory |
| `garage_meta` | Garage cluster/bucket/key metadata (LMDB) |
| `garage_data` | Garage object storage (media blobs) |
| `media_meta` | media-service metadata sidecar |
