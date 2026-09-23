# media-service

**Stack**: NestJS  
**Port**: 3011  
**Source**: `apps/media-service/`

## Responsibilities

The media-service is the encrypted blob store. It:

- Accepts encrypted file uploads from clients; stores blobs in Garage (S3-compatible, formerly
  MinIO - see [docker](../infrastructure/docker.md)).
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
  - Stores opaque bytes in Garage
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
| DELETE | `/api/media/internal/users/:userId` | `INTERNAL_SECRET` | Delete every blob uploaded by a user (account deletion) |
| DELETE | `/api/media/:id` | `INTERNAL_SECRET` | Delete media blob - **server-to-server only** (`assertInternalSecret`) |
| POST | `/api/media/internal/retention-class` | `INTERNAL_SECRET` | Classify (`archive`) or release (`null`) existing objects - see retention below |

Neither `DELETE` is reachable by a client. `:id` is called by
`AssociationsService.deleteMediaBestEffort` (logos, event images, documents, form banners) and
`FormsService`; `internal/users/:userId` by `UsersService.deleteUser` in core-service. That route
carries **no JWT on purpose** - the account is already being destroyed, so there is no token left to
present - and it is declared BEFORE the catch-all `:id` for the same reason `internal/:id` precedes
`GET :id`. **Nothing in the chat or channel paths deletes a blob** - see retention below.

## Retention: a 90-day IDLE sweep on CHAT media, and nothing else deletes them

`MediaService.purgeExpiredMedia` (`media.service.ts`) deletes any object whose `lastAccessAt` is
older than **`RETENTION_MS` = 90 days**, leaving a tombstone that is itself trimmed after 90 days. It
runs at boot, hourly (`DEFAULT_SWEEP_MS`, overridable with `MEDIA_RETENTION_SWEEP_MS`) and on every
`download()`. **It was 30 days until 2026-09-23** - what moved it, and why moving it is not the same
decision as the one taken in August, is §6 of
[storage-forecast](../infrastructure/storage-forecast.md).

Four consequences, all of which matter and none of which are obvious:

- **`lastAccessAt` is refreshed on every download**, so anything still being viewed never expires.
  The window measures *idleness*, not age.
- **Two classes never reach the clock at all** - `isRetentionExempt`, the ONE predicate the sweep
  and `getStorageStats` both call. Public assets (`isPublicAssetEntry`), and the archive class
  below.
- **Account deletion reaches a user's uploads since 2026-08-11, message deletion deliberately does
  not.** `upload` records the JWT's `sub` as `ownerId` - the only attribution possible on a service
  that sees ciphertext - and `removeAllOwnedBy` deletes those objects, skipping public assets (a logo
  outlives the member who uploaded it). Blobs stored before that change have no owner and cannot be
  backfilled. Message deletion is left to the sweep **by design**: forwarding copies the `MediaRef`,
  so a blob can be cited from conversations the deleter cannot see and no reference count is
  computable here. Deleting a community still only archives it.
- **A user-visible effect:** a photo nobody re-opens for the window is gone from the server, so a new
  device or a reinstall can never fetch it. The client says so explicitly since 2026-08-11 - the
  service answers `410` with `purgeReason = retention_expired` and all four media surfaces render an
  expired state (`isMediaPurgedError`). **The label names no number**, because a message rendered
  today may be explaining an object swept under a different window.

The index is a **JSON file** (`media_meta/media_metadata.json`), not a database table. If it is lost,
`download()`'s `setAccess` re-creates the entry with `createdAt = now`, silently restarting every
object's clock **and losing its class** - which is why the backfill below runs at every boot rather
than once.

### The archive class: the feed is not a conversation (2026-09-23)

**A post is a permanent row whose body was on an idle clock, and half of them had already rotted.**
Measured on production the day this shipped: of the 44 media the feed referenced, **22 were already
`retention_expired`** - 26.7 MB of 40.8 MB - and every one belonged to a post from May, still on
screen, rendering an expired box. A conversation scrolls away, so idleness is the right question to
ask of it; a post that nobody has scrolled back to is not a post nobody wants.

`retentionClass: 'archive'` exempts an object from the sweep for ever. **The client sets it at
upload, because the server holds ciphertext and is the one party that cannot tell which surface a
blob came from** - `encryptAndUpload(..., 'archive')` at the three post call sites, and `uploadRaw`
unconditionally (group avatars and community images).

**It is deliberately NOT `publicAsset`, and that is the whole design.** That flag does two other
things: it opens `GET /media/public/:id` with no JWT, and it is skipped by `removeAllOwnedBy`.
Reusing it would have put post ciphertext on an unauthenticated route AND silently stopped account
deletion reaching a departing member's photos. **Exemption from the idle sweep is not exemption from
erasure**, which is why `removeAllOwnedBy` alone still calls `isPublicAssetEntry` rather than
`isRetentionExempt`, and why a test asserts exactly that.

Since nothing expires an archived object, whatever deletes the row that cites it must say so:

| Route | Secret | What it does |
| --- | --- | --- |
| `POST /api/media/internal/retention-class` | `INTERNAL_SECRET` | `{mediaIds, retentionClass}` - `'archive'` classifies, `null` RELEASES. Batches of 500. |

`PostMediaRetentionService` (social-service) is the only caller and owns both halves:

- **Release**, on `deletePost` and `deleteComment` - the object drops back to the ordinary idle
  window and the sweep takes it in its own time. Deliberately not an immediate delete: an edit that
  merely removes an image reaches the same path. `deleteComment` releases the replies' media too,
  since the replies go with it.
- **Backfill**, at every boot - one SQL pass over `posts`, which is also the repair after an index
  loss. Note the two shapes: a post carries an ARRAY under `images`, a comment carries ONE media as
  an OBJECT under `media`, and reading either with the other's accessor silently finds nothing.

Neither call may fail a user's delete, so both are best-effort **and both log** - a classify that
fails is re-applied at the next boot; a release that fails only keeps an object longer than needed.

**`archiveCount` / `archiveBytes` are reported separately in `/admin/storage`**, because an exempt
class folded into a total is a class whose growth nothing can ever see - the same defect the bucket
breakdown was split to fix on 2026-08-18. At the rate measured on the day it shipped (40.8 MB over
4.5 months, ~110 MB/year) this is indolent; the line exists so that stays a measurement.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `GARAGE_ENDPOINT` | yes | Garage host (`garage` in Compose) |
| `GARAGE_PORT` | yes | Garage S3 API port (`3900`) |
| `GARAGE_REGION` | yes | Must match `s3_region` in `infrastructure/garage/garage.toml` (`garage`). Its absence is a crash loop, not a degradation: the S3 client signs for `us-east-1` and `bucketExists` fails inside `onModuleInit` |
| `GARAGE_ACCESS_KEY_ID` | yes | The key Garage provisions on first boot - the only S3 identity in the stack |
| `GARAGE_SECRET_ACCESS_KEY` | yes | Its secret |
| `GARAGE_BUCKET` | yes | Bucket name for media blobs (default `canari-media`), **also used for public assets** |
| `MEDIA_MAX_SIZE_MB` | no | Max upload size in MB (default 100, capped at 100) |
| `MEDIA_RETENTION_SWEEP_MS` | no | Retention sweep interval (default 1 h) |

**Every one of these was named `MINIO_*` until 2026-08-18**, four days after the store itself
stopped being MinIO. Renamed rather than kept: a name that lies about what it configures is read
by the next person as evidence about what is running.

`MINIO_PUBLIC_BUCKET` used to be listed here and is **not read anywhere** in
`apps/media-service/src` - `storage.service.ts` puts private and public objects in the single
`GARAGE_BUCKET`. Removed 2026-08-07.
