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

| Method | Path                                   | Auth              | Description                                                                                                       |
| ------ | -------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/media/limits`                    | none              | The configured upload ceiling in bytes - the client ASKS for it rather than being built with it                   |
| POST   | `/api/media/upload`                    | JWT               | Upload encrypted blob, return `mediaId`                                                                           |
| POST   | `/api/media/upload/public`             | JWT               | Upload small public image (logo), auto-resized to 512x512 WebP                                                    |
| POST   | `/api/media/upload/chunk/init`         | JWT               | Initialize chunked upload session                                                                                 |
| POST   | `/api/media/upload/chunk/:id`          | JWT               | Append chunk (max 50 MB per chunk)                                                                                |
| POST   | `/api/media/upload/chunk/:id/complete` | JWT               | Complete chunked upload, return `mediaId`                                                                         |
| GET    | `/api/media/public/:id`                | none              | Download public asset (cached 1 year, no auth)                                                                    |
| GET    | `/api/media/:id`                       | JWT               | Download encrypted blob (no-cache, owner or group member)                                                         |
| DELETE | `/api/media/internal/users/:userId`    | `INTERNAL_SECRET` | Delete every blob uploaded by a user (account deletion)                                                           |
| DELETE | `/api/media/:id`                       | `INTERNAL_SECRET` | Delete media blob - **server-to-server only** (`assertInternalSecret`)                                            |
| POST   | `/api/media/internal/retention-class`  | `INTERNAL_SECRET` | Set an existing object's class (`ephemeral`, `archive`, `association`; required, no `null`) - see retention below |

Neither `DELETE` is reachable by a client. `:id` is called by
`AssociationsService.deleteMediaBestEffort` (logos, event images, documents, form banners) and
`FormsService`; `internal/users/:userId` by `UsersService.deleteUser` in core-service. That route
carries **no JWT on purpose** - the account is already being destroyed, so there is no token left to
present - and it is declared BEFORE the catch-all `:id` for the same reason `internal/:id` precedes
`GET :id`. **Nothing in the chat or channel paths deletes a blob** - see retention below.

## The upload ceiling is ONE number, and the box publishes it (2026-09-24)

`GET /api/media/limits` answers `{ "maxBytes": <number> }` and takes no token. It exists because the
client used to carry its OWN copy of the ceiling.

**What the two copies were.** The client refused a file over `VITE_MEDIA_MAX_SIZE_MB`, a Vite
variable inlined at BUILD time, default 100. The server refuses a part over `MEDIA_MAX_SIZE_MB`,
default 100, and **both estates run `50`**. Nothing in CI ever wrote the Vite variable - only
`scripts/setup-env.sh`, on a developer's machine - so **every shipped build, web, APK and iOS,
allowed twice what every server accepts.**

**Measured before either number moved**, on the local estate, uploading from a logged-in page: 49 MB
answers `201`, 51 MB answers `413 File too large`. So the gap is a whole 50 MB, not the handful of
bytes the backlog item predicted, and a member could pick a 90 MB video, watch all of it go up and
be refused at the end.

**`client_max_body_size 100m` on nginx was never the opposing side.** It is the number the item named
and it never got a say: media-service refuses at half of it, first.

**The two caps also measured different bytes, and that is now explicit.** The server's ceiling
applies to the CIPHERTEXT; the picker holds a PLAINTEXT `File`. AES-GCM grows it by exactly its
16-byte tag - the IV travels beside the blob in the `MediaRef`, not inside it - so
`MediaService.uploadLimits()` returns both `maxBytes` (what the member is TOLD) and
`maxPlaintextBytes` (what a file is COMPARED against). Announcing the compared number would say
"49 Mo" of a 50 MB server, which is the bug the boundary test in
`useMessaging.mediaCeiling.svelte.test.ts` exists to keep shut.

**A build-time variable could not have fixed this**, which is the deciding argument rather than a
preference: an installed APK carries whatever value it was built with, and nothing keeps that in
step with the box. Only the box can answer.

**When the limit cannot be had, the client refuses NOTHING.** The check is an optimisation - telling
a member before the bytes go up rather than after - and the refusal that matters is the server's
`413`. A `null` ceiling never becomes an invented one; a default would be exactly the second copy
this removed. The answer is cached per origin, so one fetch serves every picker.

## Retention: a 90-day IDLE sweep on CHAT media, and nothing else deletes them

`MediaService.purgeExpiredMedia` (`media.service.ts`) deletes any **`ephemeral`** object whose
`lastAccessAt` is older than **`RETENTION_MS` = 90 days**, leaving a tombstone that is itself
trimmed after 90 days. It runs at boot, hourly (`DEFAULT_SWEEP_MS`, overridable with
`MEDIA_RETENTION_SWEEP_MS`) and on every `download()`. **It was 30 days until 2026-09-23** - what
moved it, and why moving it is not the same decision as the one taken in August, is §6 of
[storage-forecast](../infrastructure/storage-forecast.md).

Four consequences, all of which matter and none of which are obvious:

- **`lastAccessAt` is refreshed on every download**, so anything still being viewed never expires.
  The window measures _idleness_, not age.
- **The sweep is an ALLOWLIST since 2026-10-01: it takes `ephemeral` and nothing else** -
  `isSweepable`, the ONE predicate the sweep and `getStorageStats` both call. Every other class, a
  public asset, and an object with NO class are all kept. Why it flipped is the next section.
- **Account deletion reaches a user's uploads since 2026-08-11, message deletion deliberately does
  not.** `upload` records the JWT's `sub` as `ownerId` - the only attribution possible on a service
  that sees ciphertext - and `removeAllOwnedBy` deletes those objects, skipping what
  `survivesAccountDeletion` names: public assets (a logo outlives the member who uploaded it) and
  `association` documents (the vault belongs to the association). Blobs stored before that change
  have no owner and cannot be backfilled. Message deletion is left to the sweep **by design**:
  forwarding copies the `MediaRef`, so a blob can be cited from conversations the deleter cannot see
  and no reference count is computable here. Deleting a community still only archives it.
- **A user-visible effect:** a photo nobody re-opens for the window is gone from the server, so a new
  device or a reinstall can never fetch it. The client says so explicitly since 2026-08-11 - the
  service answers `410` with `purgeReason = retention_expired` and all four media surfaces render an
  expired state (`isMediaPurgedError`). **The label names no number**, because a message rendered
  today may be explaining an object swept under a different window.

The index is a **JSON file** (`media_meta/media_metadata.json`), not a database table. If it is lost,
`download()`'s `setAccess` re-creates the entry with `createdAt = now`, silently restarting every
object's clock **and losing its class** - which is why the backfills below run at every boot rather
than once. Since the allowlist, a lost class means "kept", never "swept".

### The sweep is an allowlist: an association's document was swept (2026-10-01)

**The report.** On `canari.emse.fr`, downloading a document from the `les-rootz` vault answered
`GET /api/media/<id> -> 410` while the document row and the vault key both answered 200. The vault
upload (`AssociationDocumentManager.svelte`) named **no retention class**, and the sweep then took
every idle object that no exemption named - so a document uploaded 2026-08-22 and never reopened was
deleted after the 30-day window of the time (~2026-09-21). A list of exemptions protects only what
somebody thought of; the vault was nobody's thought.

**What was measured on production, read-only (2026-10-01).** The tombstone of that object now reads
`manual_delete` at 10:01 that day, not `retention_expired`: the member had deleted the dead row and
uploaded two documents a minute later, and `remove()` **rewrote the tombstone**, erasing the only
record that the sweep was the cause. The 410 itself proves it was `retention_expired` before - no
other state answers 410. Across the estate: 4 document rows in 2 associations, **all 4 live and
unclassified** (one already 36 days idle, which the 90-day window would have taken in December); 0
rows pointing at a purged object, so no other vault document is lost today. Every other association
media - 91 logos, 16 card icons, 2 event images - is a public asset and was never at risk. One
community image (`channel_workspaces`) was unclassified, uploaded before `uploadRaw` sent `archive`.

**The design now**, `RetentionClass` in `media.service.ts`:

| Class         | Who sets it                                                                        | Idle sweep   | Account deletion |
| ------------- | ---------------------------------------------------------------------------------- | ------------ | ---------------- |
| `ephemeral`   | the client, for chat and channel media; social-service on a post release           | **takes it** | takes it         |
| `archive`     | the client, for feed media and avatars; social-service's boot backfill             | keeps        | takes it         |
| `association` | the client, for a vault upload; social-service on `createDocument` and at boot     | keeps        | **keeps**        |
| none          | an old client, anything before 2026-10-01, an entry re-created after an index loss | **keeps**    | takes it         |

- **The client's `encryptAndUpload` takes the class as a REQUIRED argument**, so no new call site
  can forget it the way the vault did.
- **The internal route requires a class and accepts no `null`.** It used to read an ABSENT key as
  `null`, the release - a body that forgot the field silently moved a batch onto the idle clock.
- **`remove()` keeps an existing tombstone's date and reason**, so the next loss stays readable
  after the member deletes the dead row.
- **The cost, measured**: the 225 live unclassified objects (~31.5 MB on 2026-10-01, mostly legacy
  chat media) are now kept for ever, and so is every chat upload from an installed client older than
  this change. `getStorageStats` reports them as `unclassified*`, and the vault as `association*`,
  each with its own line in `/admin/storage` - an exempt class folded into a total is one whose
  growth nothing can see.

**What the client shows.** `fetchVaultCiphertext` (`$lib/associations/vaultDownload.ts`) is the one
fetch of a vault document for the vault AND the reviewer page; it throws `MediaPurgedError` on a 410
(the type every chat media surface already reads), and both pages show a notice saying the file is
no longer stored and must be uploaded again - with an "upload again" button in the vault, and "the
association must upload it again" on the reviewer page. Before, it was a generic "download failed",
and a protected document's 410 read as a wrong password.

**Recovery is a restore, not code.** The restic repository (`/srv/canari-backups/restic-objects`,
14d/8w/6m) still holds `garage_data` snapshots of 08-23, 08-30, 08-31, 09-06, 09-13 and daily
09-18 to 09-21, all taken while that blob existed; its decryption salt lives in the deleted row's
`description`, which the 2026-10-01 03:30 `auth_db` dump still holds. Whether to restore is the
user's call ([backup](../infrastructure/backup.md)).

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
erasure**, which is why `removeAllOwnedBy` calls `survivesAccountDeletion` rather than the inverse
of `isSweepable`, and why a test asserts exactly that.

Since nothing expires an archived object, whatever deletes the row that cites it must say so:

| Route                                      | Secret            | What it does                                                                                                                           |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/media/internal/retention-class` | `INTERNAL_SECRET` | `{mediaIds, retentionClass}` - `'archive'`/`'association'` classify, `'ephemeral'` RELEASES; a missing class is a 400. Batches of 500. |

Social-service calls it through ONE helper, `applyMediaRetentionClass`
(`src/internal/media-retention-class.ts`). `AssociationDocumentRetentionService` classifies every
vault document `association` at boot, and `createDocument` classifies the new row's blob - the
repair for an installed client too old to send the class. `PostMediaRetentionService` owns the feed's
two halves:

- **Release**, on `deletePost` and `deleteComment` - the object is moved to `ephemeral` and the
  sweep takes it in its own time. It must NAME `ephemeral`: an object with no class is one the
  allowlisted sweep never takes. Deliberately not an immediate delete: an edit that
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

| Variable                   | Required | Description                                                                                                                                                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`               | yes      | HS256 secret (shared with all services)                                                                                                                                                                      |
| `GARAGE_ENDPOINT`          | yes      | Garage host (`garage` in Compose)                                                                                                                                                                            |
| `GARAGE_PORT`              | yes      | Garage S3 API port (`3900`)                                                                                                                                                                                  |
| `GARAGE_REGION`            | yes      | Must match `s3_region` in `infrastructure/garage/garage.toml` (`garage`). Its absence is a crash loop, not a degradation: the S3 client signs for `us-east-1` and `bucketExists` fails inside `onModuleInit` |
| `GARAGE_ACCESS_KEY_ID`     | yes      | The key Garage provisions on first boot - the only S3 identity in the stack                                                                                                                                  |
| `GARAGE_SECRET_ACCESS_KEY` | yes      | Its secret                                                                                                                                                                                                   |
| `GARAGE_BUCKET`            | yes      | Bucket name for media blobs (default `canari-media`), **also used for public assets**                                                                                                                        |
| `MEDIA_MAX_SIZE_MB`        | no       | Max upload size in MB, measured on the CIPHERTEXT (default 100, capped at 100). **Both estates run `50`.** Published by `GET /api/media/limits` and the only copy of the number                              |
| `MEDIA_RETENTION_SWEEP_MS` | no       | Retention sweep interval (default 1 h)                                                                                                                                                                       |

**Every one of these was named `MINIO_*` until 2026-08-18**, four days after the store itself
stopped being MinIO. Renamed rather than kept: a name that lies about what it configures is read
by the next person as evidence about what is running.

`MINIO_PUBLIC_BUCKET` used to be listed here and is **not read anywhere** in
`apps/media-service/src` - `storage.service.ts` puts private and public objects in the single
`GARAGE_BUCKET`. Removed 2026-08-07.
