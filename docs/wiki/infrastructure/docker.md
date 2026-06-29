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
  |-- chat-delivery-service:3010 <- depends on postgres, redis, kafka, mongo
  |-- media-service:3011         <- depends on minio
  |-- core-service:3012          <- depends on postgres
  |-- social-service:3014        <- depends on postgres, core-service, media-service
  |-- call-service:3004          <- independent (Cloudflare TURN)

Infrastructure:
  postgres:5432    <- auth_db (core, chat-delivery, social)
  mongo:27017      <- chat_db (posts, MLS history blobs)
  redis:6379       <- presence, pub/sub, history streams
  kafka:29092      <- async events
  zookeeper:2181   <- Kafka coordinator
  minio:9000/9001  <- media blobs
```

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
| MinIO API | 9000 | configurable (`MINIO_API_HOST_PORT`, default 19100) |
| MinIO console | 9001 | configurable (`MINIO_CONSOLE_HOST_PORT`, default 19101) |

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

chat-delivery-service, MinIO, Redis, and Kafka have health checks. Other services depend on `service_started` (no health check gate). The frontend starts once all backend services are running.

## Volumes

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `mongo_data` | MongoDB data directory |
| `minio_data` | MinIO object storage |
| `media_meta` | media-service metadata sidecar |
