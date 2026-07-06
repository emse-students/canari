# Databases

## PostgreSQL

**Image**: `postgres:15-alpine`  
**Port**: 5432 (container), 5433 (dev host)  
**Database**: `auth_db`

Single shared database host for all relational data. The database name is `auth_db`; logical separation is by schema/table prefix, not by database.

| Service | Tables (key ones) |
|---|---|
| core-service | `users`, `platform_config`, `notes` |
| chat-delivery-service | `key_packages`, `one_time_key_packages`, `queued_message`, `dm_groups`, `dm_group_members`, `dm_device_group_memberships`, `push_tokens`, `revoked_devices`, `pin_verifiers` |
| social-service | `channel_workspaces`, `channels`, `channel_members`, `channel_roles`, `channel_messages`, `channel_key_distributions`, `forms`, `form_submissions`, `associations`, `association_members`, `products` |

Full schema: see `docs/wiki/architecture.md` (PostgreSQL schema overview section).

### Migrations

NestJS services use TypeORM. Schema is managed via migrations in each service's `src/migrations/` directory. In development, `synchronize: true` is active (auto-sync). In production, `synchronize: false` — migrations run explicitly.

### Backup

PostgreSQL is backed up daily via `pg_dump -d auth_db --clean --if-exists` (logical dump, gzip). See `docs/wiki/infrastructure/backup.md`.

---

## MongoDB

**Image**: `mongo:latest`  
**Port**: 27017 (container), 27018 (dev host)  
**Database**: `chat_db`

Used by social-service for document-oriented data.

| Collection | Contents |
|---|---|
| `posts` | Markdown post documents, polls, comments, reactions |

Backed up daily via `mongodump --db=chat_db --archive --gzip`.

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

`user:online:{userId}:{deviceId}` — TTL 90 seconds, refreshed on each WebSocket Pong. Deleted immediately on clean disconnect.

### History streams

`history:{groupId}` — Redis Stream. Appended to by chat-delivery-service on each `POST /api/mls/send`. Read incrementally by clients via `GET /api/mls/history/:groupId?after=<streamId>`.

### Other keys

| Key | Type | Purpose |
|---|---|---|
| `group:members:{groupId}` | Set | Active device members for a group (for welcome forward) |
| `pending_welcomes:{userId}` | List | WS frames queued while device is offline |
| `add-lock:{groupId}` | String | Distributed add-lock (1s TTL) |

Redis is **not persisted** (no AOF/RDB in the default config). Presence and pending frames are ephemeral; history streams are the durable record.

---

## MinIO

**Image**: `minio/minio:latest`  
**API port**: 9000 (container), configurable dev host port (default 19100)  
**Console port**: 9001 (container), configurable dev host port (default 19101)

S3-compatible object storage. Used exclusively by media-service.

| Bucket | Contents |
|---|---|
| `canari-media` (`MINIO_BUCKET`) | Encrypted media blobs (AES-256-GCM, client-side encrypted) |
| Public bucket (`MINIO_PUBLIC_BUCKET`) | Resized public images (logos, avatars — not encrypted) |

The MinIO `minio_data` Docker volume is backed up daily as a tar archive. See backup docs.
