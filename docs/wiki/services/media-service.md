# media-service

**Stack**: NestJS  
**Port**: 3011  
**Source**: `apps/media-service/`

## Responsibilities

The media-service is the encrypted blob store. It:

- Accepts encrypted file uploads from clients; stores blobs in MinIO (S3-compatible).
- Exposes download endpoints (authenticated for private blobs, public for profile images).
- Supports both single-shot uploads and chunked uploads for large files.
- Auto-resizes public images (logos, avatars) to 512x512 WebP on upload.
- Never decrypts content — the client provides AES-256-GCM ciphertext; the encryption key travels inside the MLS ciphertext.

## Encryption model

```
Client:
  - Generates a random CEK (AES-256-GCM, 256-bit)
  - Encrypts the file with the CEK
  - Uploads ciphertext to media-service
  - Sends the CEK inside the MLS message ciphertext

Server:
  - Stores opaque bytes in MinIO
  - Returns a mediaId
  - Never sees the plaintext or the key
```

## Client-side download (`utils/mediaBlobCache.ts`)

Every download goes through one seam: ciphertext is fetched (and kept in the Cache API under
`canari-media-ciphertext-v1`, so it survives a reload), decrypted, and handed out as a
reference-counted blob URL (`BlobUrlPool`, 5-minute delayed eviction).

**The bearer token is resolved inside that seam, per request, never passed in.** An access token
lives in memory for minutes and refreshes itself silently through `getToken`; the copy the chat
session hands down its component tree (`session.authToken`) is captured once at login and never
updated. Passing that copy down to the fetch meant a tab open past the expiry kept rendering
already-cached media while every newly received image 401'd - a bug that reads as "the image only
appears after a reload", because a reload is what mints a fresh token. `authToken` still travels as
a prop, but only as a signal that the session is authenticated.

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
| DELETE | `/api/media/:id` | JWT | Delete media blob (owner only) |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `MINIO_ENDPOINT` | yes | MinIO server URL |
| `MINIO_ACCESS_KEY` | yes | MinIO access key |
| `MINIO_SECRET_KEY` | yes | MinIO secret key |
| `MINIO_BUCKET` | yes | Bucket name for media blobs |
| `MINIO_PUBLIC_BUCKET` | yes | Bucket for public assets |
| `MEDIA_MAX_SIZE_MB` | no | Max upload size in MB (default 100, capped at 100) |
