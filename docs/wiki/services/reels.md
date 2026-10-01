# CanaReels - the server half (R3: decisions C2, C3, C4, C6)

Decided by the user on 2026-09-29 and built from 2026-10-01
([backlog](../backlog.md#the-composer-and-canareels-chantier---compared-on-the-mi-9t-2026-09-29-every-decision-taken)).
This page is the CONTRACT the camera tab, the full-screen viewer and the on-device compression are
built against, and the design behind the server side. A reel is a **post of `kind = 'reel'`**: same
table, same feed, same reactions, comments, reports and moderation - plus a duration, an expiry,
and a worker that deletes the whole thing when the expiry passes.

**What the server is NOT**: it transcodes nothing and makes no thumbnail (C3, *"il faut que la
charge serveur soit minimale"*). The phone compresses to ~720p / ~2.5 Mb/s (about 28 MB for 90 s,
under the 50 MB ciphertext cap) and the server stores the bytes.

## The numbers, and where each is the ONE copy

| Number | Value | Lives in | Clients read it from |
| --- | --- | --- | --- |
| Longest reel | 90 000 ms (C4) | `REEL_MAX_DURATION_MS`, `posts/reel.constants.ts` | `GET /api/posts/reel-limits` |
| Kept for | 30 days (C6) | `REEL_RETENTION_DAYS`, same file | same route, and every row's `expiresAt` |
| "About to expire" window | 7 days | `REEL_EXPIRY_WARNING_DAYS`, same file | same route, and `my-reels` |
| Blob ceiling | 50 MB of ciphertext | media-service `MEDIA_MAX_SIZE_MB` | `GET /api/media/limits` (unchanged) |

**A client carries no copy of these.** An installed APK keeps whatever it was built with
([media-service](media-service.md#retention-a-90-day-idle-sweep-on-chat-media-and-nothing-else-deletes-them)
says why for the 50 MB), so the camera asks the box before it arms its ring timer.

## The API contract

### `GET /api/posts/reel-limits` (JWT)

```json
{ "maxDurationMs": 90000, "retentionDays": 30, "warningWindowDays": 7 }
```

### Publishing: `POST /api/posts` with `kind: "reel"`

The ordinary create request, plus two fields. Any member may publish (C2); the mute check, the
association-identity rule (`associationId` needs `POST_AS_ASSO`) and `anonymous` behave as for a post.

```json
{
  "kind": "reel",
  "durationMs": 41250,
  "markdown": "optional caption, may be empty",
  "media": [{ "type": "video", "mediaId": "<uuid>", "key": "...", "iv": "...",
              "mimeType": "video/mp4", "size": 27123456, "width": 720, "height": 1280,
              "encoding": "segmented-v1" }]
}
```

**What the client must do first**: upload the blob with `retentionClass: 'reel'` (a fourth class
next to `ephemeral`, `archive`, `association`; the upload route accepts it, and `encryptAndUpload`'s
required class argument takes it). Social-service then CLAIMS the blob for the author (below); a
blob the author did not upload is refused, which is what keeps a forged `mediaId` from ever being
deleted by this feature.

**Refusals, all `400`** (a status is an answer; nothing is retried):

| Condition | Why |
| --- | --- |
| `durationMs` missing, not an integer, `< 1` or `> maxDurationMs` | C4 |
| `durationMs` present on a post that is not a reel | one fact, not two |
| `media` is not exactly ONE entry of `type: "video"` with a `video/*` MIME type | a reel is one video |
| `polls`, `forms`, `attachedFormId`, `linkedCalendarEventId` or `scheduledAt` present | none has a meaning on a reel that expires; a scheduled reel would also start its month before anybody could see it |
| the blob is not the author's, does not exist, or is already deleted | the claim failed |

`markdown` may be `""` for a reel (a post still refuses it). An unreachable media service is a
`503`, never a reel stored without its blob.

The response is the created post, now carrying `kind`, `durationMs`, `expiresAt`
(`createdAt + 30 days`, set ONCE at creation).

**Editing** (`PATCH /api/posts/:id`): a reel's caption is the only thing that can change. A payload
naming `media`, `images`, `polls`, `attachedFormId`, `linkedCalendarEventId` or `scheduledAt` on a
reel is a `400` - the video, its duration and its expiry are fixed at publication.

### Reading

Every post row - feed, search, `GET /api/posts/:id`, the notification link - now carries:

| Field | Post | Reel |
| --- | --- | --- |
| `kind` | `"post"` | `"reel"` |
| `durationMs` | `null` | integer, 1..90000 |
| `expiresAt` | `null` | ISO timestamp |

`GET /api/posts?feed=all|followed|custom|associations&kind=reel|post` - `kind` is optional and
**absent means both**, so the feed shows reels where it shows posts (C7: *a reel is read in the
feed*). The full-screen viewer asks for `kind=reel` and pages with `limit`/`offset` like the feed.
Every filter the feed has applies (blocked authors, moderation-hidden, promo gate, service account).

**An expired reel is never served**, whether the worker has reached it or not: a reel whose
`expiresAt` has passed is excluded from every read (`GET /api/posts/:id` answers `404`). The client
needs no clock to decide that - it simply never receives one. The row and its blob go at the next
worker tick.

An older client that does not know reels renders one as a post with a video attachment, which is
what it is.

### The author's expiry signal: `GET /api/posts/my-reels` (JWT)

```json
{ "serverNow": "2026-10-31T09:00:00.000Z", "warningWindowDays": 7,
  "reels": [{ "id": "...", "createdAt": "...", "expiresAt": "...", "durationMs": 41250,
              "expiringSoon": true, "markdown": "", "media": [ ... ] }] }
```

The caller's OWN live reels, soonest expiry first. `expiringSoon` is `expiresAt - serverNow <=
warningWindowDays`, computed by the server from ITS clock, and `serverNow` is there so a phone with a
skewed clock still shows the right countdown. `media[0]` carries the key and IV, which is why this
is the author's route and nobody else's: it is what the client needs to **decrypt and save the video
to the gallery before the deletion** (C6). Reels the caller published in an association's name or
anonymously are included - they are the caller's. Nothing is offered after `expiresAt`: the blob may
still exist for up to an hour, but the reel is no longer served and the offer stops with it.

### Deleting

`DELETE /api/posts/:id` is unchanged for the caller (author, `POST_AS_ASSO` holder, moderator,
admin). For a reel it also deletes the blob at once (below) rather than leaving it to an idle clock.

### Reporting and moderation: unchanged

`POST /api/moderation/reports` with `contentType: "post"` and the reel's id; the threshold hides it
exactly as it hides a post (`hiddenByModeration`), and a moderator's hide/unhide/delete are the same
routes ([moderation-and-blocking](../moderation-and-blocking.md)). **One consequence to know**: a
hidden reel still expires at 30 days and is purged with its row, so a pending report on a reel
nobody reviewed in a month is left pointing at a post that no longer exists - the same state as a
report on any deleted post.

## What the server can verify about a 90-second cap, and what it cannot

**It cannot see inside the blob** - the video is AES-GCM ciphertext under a key that travels in the
post row, and the service stores bytes. So:

- **`durationMs` is DECLARED by the client and enforced as a declaration**: the server refuses a
  missing, non-integer or `> 90 000` value and stores the number it was given. A modified client can
  upload a longer video and declare 10 seconds. **There is no server-side check that could catch
  it** without decrypting (which the design forbids) or trusting a container header inside the
  ciphertext (which it cannot read).
- **What the server DOES bound, for real**: the 50 MB ciphertext cap (`413` at upload), ownership of
  the blob (a reel can only cite what its author uploaded), that it is ONE video (type and MIME as
  declared), and the expiry, which is the server's own clock at creation.
- **So the cap's real bound is storage, not time**: whatever the declared duration, a reel is at most
  50 MB and is gone in 30 days. The 90 s is the product's shape, enforced by the app and honoured by
  the server's refusal of every declaration beyond it. Honest, and deliberate: re-encoding on the
  server would cost the CPU C3 forbids.

## The retention class `reel`, and the claim

Media-service gains a fourth class, `reel`:

| Class | Idle sweep | Account deletion | Reaped by |
| --- | --- | --- | --- |
| `reel` | **keeps** (the sweep is an allowlist of `ephemeral`) | takes it | `ReelRetentionScheduler`, through `POST /api/media/internal/reel-purge` |

`reel` is reported in `getStorageStats` as `reelCount` / `reelBytes` - an exempt class folded into a
total is one whose growth nothing can see.

Two internal routes (`X-Internal-Secret`, never reachable by a client), both batched at 500:

- `POST /api/media/internal/reel-claim` `{ mediaIds, ownerId }` -> `{ claimed, refused }`. Sets
  `retentionClass = 'reel'` on every entry that exists, is not purged, is not a public asset, and
  whose recorded `ownerId` (the JWT `sub` of its uploader) equals `ownerId`. Idempotent.
- `POST /api/media/internal/reel-purge` `{ items: [{ mediaId, ownerId }] }` ->
  `{ results: { <mediaId>: 'deleted' | 'absent' | 'refused' | 'failed' } }`. **THE ALLOWLIST OF THIS
  DELETE IS OWNERSHIP**: it deletes an object only if the entry's `ownerId` equals the `ownerId` the
  caller names, and it is neither a public asset nor an `association` document. `absent` (no entry,
  or already purged) is success; `refused` (not the named owner) is a terminal "not ours", left
  alone and logged at `warn`; `failed` (the store refused, or threw) is the only outcome that keeps
  a reel's row for the next tick.

**Why ownership and not "class is `reel`"**: a comment on a reel may carry a media, uploaded by the
commenter under another class. The worker deletes those too (nothing dead stays), naming the
COMMENTER as owner. A member who cites somebody else's blob id in a reel or a comment can therefore
never get it deleted - the entry says whose it is.

## The worker: `ReelRetentionScheduler` (social-service)

Hourly (`@Cron('23 * * * *')`). Everything it knows is in the database:

1. **Select** reels with `kind = 'reel' AND "expiresAt" <= NOW()`, oldest first, in batches of 50.
   That predicate IS the state: a reel is due, or it is not, and a row that has been deleted is done.
   No timestamp of the last run, no marker.
2. **Per reel, in isolation** (a `try` per item): list the blobs - the reel's own media and every
   comment's media with the comment's author as owner - call `reel-purge`, and **only if no blob
   came back `failed`**, delete the row and its `post_notifications`. The row delete is
   `DELETE ... WHERE id = $1 AND kind = 'reel' AND "expiresAt" <= NOW()`, so **a non-reel post
   cannot be touched by this code path whatever id reaches it**.
3. Comments, reactions and links are columns of the row: they go with it.
4. **Idempotent by construction**: a crash after the blobs and before the row leaves a due row with
   absent blobs; the next tick finds them `absent` (success) and deletes the row. Running it twice
   in a row deletes once and the second run finds nothing due.
5. **A failing blob keeps its own reel and nobody else's**: that row stays (invisible to every
   read - an expired reel is never served), is logged at `warn` with the blob id and the outcome,
   and is retried on the next tick; the rest of the batch proceeds.
6. Invalidates the feed cache once at the end if anything was deleted.

**Observed** three ways: one `[REEL_GC]` line per run that found work (`due`, `deleted`, `failed`,
`blobs`), the per-item `warn`s, and **the admin storage panel**'s reel block (`/admin/storage`):
`live`, `expiringSoon`, **`overdue`** (due rows still present) and `oldestOverdueMs`. `overdue`
above zero for more than a couple of ticks means the worker is stuck, and that figure is the one to
read - the same reasoning as the media sweep's own `overdueCount`.

## The migration: `069_posts_reels.sql`

Adds `kind varchar(16) NOT NULL DEFAULT 'post'`, `"durationMs" integer NULL`, `"expiresAt"
timestamptz NULL`, a CHECK that ties the three together (a post carries neither of the other two; a
reel carries both), and a PARTIAL index on `"expiresAt" WHERE kind = 'reel'` so the worker's
predicate stays a handful of entries however large `posts` gets. **Nothing existing becomes a
reel**: the default is `'post'` and there is no `UPDATE`.

**The boot backfill that classifies feed media `archive` (`PostMediaRetentionService`) skips
reels**, and a second pass re-applies `reel` to every live reel's own blob. Without the skip, the
next boot would flip every reel's blob to `archive` - silently out of the worker's class.
