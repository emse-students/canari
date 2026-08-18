# Media Service

NestJS microservice for the encrypted blob store. Runs on port **3011**.

## Responsibilities

The media-service stores and serves encrypted files:

- Accepts encrypted file uploads from clients; stores blobs in Garage (S3-compatible, formerly MinIO).
- Exposes download endpoints (authenticated for private blobs, public for profile images).
- Supports both single-shot uploads and chunked uploads for large files (max 50 MB per chunk).
- Auto-resizes public images (logos, avatars) to 512x512 WebP on upload.
- Purges media idle for 30 days (RETENTION_MS); public assets are exempt.

The service **never decrypts content** - the client provides AES-256-GCM ciphertext; the encryption key travels inside the MLS message ciphertext.

## Encryption Model

```
Client:
  - Generates random CEK (AES-256-GCM, 256-bit)
  - Encrypts file with CEK
  - Uploads ciphertext to media-service
  - Sends CEK inside MLS message ciphertext

Server:
  - Stores opaque bytes in Garage
  - Returns a mediaId
  - Never sees plaintext or key
```

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/media/upload` | JWT | Upload encrypted blob, return `mediaId` |
| POST | `/api/media/upload/public` | JWT | Upload small public image (logo), auto-resized to 512x512 WebP |
| POST | `/api/media/upload/chunk/init` | JWT | Initialize chunked upload session |
| POST | `/api/media/upload/chunk/:id` | JWT | Append chunk (max 50 MB per chunk) |
| POST | `/api/media/upload/chunk/:id/complete` | JWT | Complete chunked upload, return `mediaId` |
| GET | `/api/media/public/:id` | none | Download public asset (cached 1 year, no auth) |
| GET | `/api/media/:id` | JWT | Download encrypted blob (no-cache, owner or group member) |
| DELETE | `/api/media/internal/users/:userId` | `INTERNAL_SECRET` | Delete every blob uploaded by a user (account deletion) |
| DELETE | `/api/media/:id` | `INTERNAL_SECRET` | Delete media blob - server-to-server only |

Client-facing `DELETE` endpoints do not exist. Blob deletion is triggered only by the 30-day idle retention sweep or account deletion via internal API.

## Retention: 30-Day Idle Sweep

`purgeExpiredMedia` deletes any object whose `lastAccessAt` is older than 30 days, leaving a tombstone trimmed after 90 days. Runs at boot, hourly, and on every download.

Four consequences:

- **`lastAccessAt` is refreshed on every download**, so anything still being viewed never expires (window measures idleness, not age).
- **Public assets are exempt** and permanent.
- **Account deletion reaches a user's uploads**, but message deletion deliberately does not (forwarding copies the `MediaRef`, so blobs can be cited from conversations the deleter cannot see).
- **New device or reinstall gets no media older than 30 days** - when the server responds `410` with `purgeReason = retention_expired`, the client renders an expired state.

## Startup

```bash
cd apps/media-service
npm run start:dev
```

Requires running PostgreSQL, Garage (S3 store), and configured credentials.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `GARAGE_ENDPOINT` | yes | Garage host (`garage` in Compose) |
| `GARAGE_PORT` | yes | Garage S3 API port (`3900`) |
| `GARAGE_REGION` | yes | Must match `s3_region` in `garage.toml`; without it every request is refused |
| `GARAGE_ACCESS_KEY_ID` | yes | The key Garage provisions on first boot - not a second one |
| `GARAGE_SECRET_ACCESS_KEY` | yes | Its secret |
| `GARAGE_BUCKET` | yes | Bucket for both private and public blobs (default `canari-media`) |
| `MEDIA_MAX_SIZE_MB` | no | Max upload size in MB (default 100, capped at 100) |
| `MEDIA_RETENTION_SWEEP_MS` | no | Retention sweep interval (default 1 hour) |

## See also

- [Wiki: media-service](../../docs/wiki/services/media-service.md) - Full API, encryption model, retention design
- [Wiki: Storage forecast](../../docs/wiki/infrastructure/storage-forecast.md) - Media storage capacity planning
- [Wiki: Docker (Garage)](../../docs/wiki/infrastructure/docker.md) - the Garage S3 store, and the migration off MinIO
