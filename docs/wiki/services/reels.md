# CanaReels - the server half (R3: decisions C2, C3, C4, C6; the rule and the year of 2026-11-09)

Decided by the user on 2026-09-29 and built from 2026-10-01
([reels](../frontend/modules/reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29)).
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
| Longest reel sent in a chat | 60 000 ms (D-size, 2026-10-09; served as `chatMaxDurationMs`, absent from an older server) | `CHAT_REEL_MAX_DURATION_MS`, same file | `GET /api/posts/reel-limits` |
| Conversations one "Envoyer à..." press may reach | 15 ([reels-in-chat 15.2](../frontend/modules/reels-in-chat.md#152-the-outbox-one-take-n-sends); served as `chatReelMaxTargets` since RC-14, absent from an older server) | `CHAT_REEL_MAX_TARGETS`, same file | `GET /api/posts/reel-limits` |
| Longest reel | 90 000 ms (C4) | `REEL_MAX_DURATION_MS`, `posts/reel.constants.ts` | `GET /api/posts/reel-limits` |
| Widest reel | `width / height` <= 0.8, i.e. 4:5 (owner, 2026-11-09; served as `maxAspectRatio`, absent from an older server) | `REEL_MAX_ASPECT_RATIO`, same file | same route |
| Kept for | **365 days by default** (owner, 2026-11-09; was 30, C6) - **an admin setting since 2026-11-14**, read at each publication and stamped into `expiresAt`, so a change applies to new reels only ([retention-settings](../retention-settings.md)) | `platform_config.retention_reel_days` (core migration 025); `REEL_RETENTION_DAYS` is the year migration 158 used | same route, and every row's `expiresAt` |
| "About to expire" window | 7 days | `REEL_EXPIRY_WARNING_DAYS`, same file | same route, and `my-reels` |
| Blob ceiling | 50 MB of ciphertext | media-service `MEDIA_MAX_SIZE_MB` | `GET /api/media/limits` (unchanged) |

**A client carries no copy of these.** An installed APK keeps whatever it was built with
([media-service](media-service.md#retention-a-90-day-idle-sweep-on-chat-media-and-nothing-else-deletes-them)
says why for the 50 MB), so the camera asks the box before it arms its ring timer.

## The API contract

### `GET /api/posts/reel-limits` (JWT)

```json
{ "maxDurationMs": 90000, "chatMaxDurationMs": 60000, "chatReelMaxTargets": 15, "maxAspectRatio": 0.8, "retentionDays": 365, "warningWindowDays": 7 }
```

### The rule: what is a CanaReel (owner, 2026-11-09)

**Decided by the owner, 2026-11-09: every VERTICAL video of 90 s or less is a CanaReel** - filmed in
the CanaReels tab or imported from the gallery into a post composer alike. It is published as a reel
(`kind: 'reel'`), so it is read in the reel pager and lives the reel's lifetime. **Every other video
(landscape, square, longer than 90 s) stays an ordinary post video.** And **a CanaReel lives ONE
YEAR** (was C6's month); the reels already published were moved to the year by migration 158.

- **"Vertical" is defined ONCE**, here: `isReelFrame` in `posts/reel.constants.ts`, `width / height
  <= REEL_MAX_ASPECT_RATIO` (4:5 = 0.8), on the PREPARED file's frame - `prepareVideoForUpload`
  bakes the container's rotation into the frames, so the declared `width`/`height` are the frame
  as shown. **Why 4:5 and not "height > width"**: 4:5 is Instagram's tallest feed format, the
  boundary between "a portrait post" and "a vertical video"; it keeps 9:16 (a phone held upright,
  0.5625) and the iOS system camera's 3:4 medium quality (0.75, the 360x480 video of the
  2026-10-19 report) in, and a near-square crop (1080x1100) out - a frame the full-screen reel
  frame would show with wide bands. The number is served as `maxAspectRatio`, so the client's
  classifier (`frontend/src/lib/reels/reelRule.ts`) reads the same one the door refuses against.
- **The client decides, the door refuses.** The server cannot see inside the ciphertext, so it
  cannot classify a post on its own: the client declares the kind, the duration and the frame,
  and the server refuses a declared reel that breaks the rule (below). It does NOT refuse a
  `kind: 'post'` carrying one vertical short video: a post declares no duration (the field is a
  reel's), so the server has nothing to read it from, and every installed client older than the
  rule publishes such posts.
- **Where the client applies it**: the publish queue of the post composers decides at the create
  step, on the prepared frame and length (`reelDeclarationFor`); the CanaReels tab refuses a
  landscape or square gallery pick at once (`reels_capture_not_vertical`) and, should a prepared
  take still come out wide, publishes it as a post with a WARN. **A post carrying something a reel
  cannot** (a poll, an attached form, a linked event, a schedule, a second attachment) **stays a
  post** whatever its video is - the door refuses each on a reel. "Garder comme post" is gone from
  the composer camera's publish step: a filmed take is vertical and short, so it IS a reel.
- **An estate older than the rule** serves no `maxAspectRatio`: the client then keeps that estate's
  behaviour (the composer's video a post, the tab's take a reel) and logs it - the days between the
  stores and the production deploy.
- **An app older than the rule** still offers a gallery pick of ANY frame in the CanaReels tab and
  publishes it as `kind: 'reel'`: a landscape or square pick is now refused at this door with its
  `400` ("a reel's video must be vertical"), and that app shows its generic publish error. Deliberate
  - the door is the rule - and bounded: on a phone those apps' filmed takes are vertical (the
  capture saves the portrait preview box's frame, `framedCapture.ts`), and the member can still
  publish the video as a post from "Nouvelle publication".
- **Existing posts are not converted**: a vertical video published as a post before the rule stays a
  post (it already shows in the pager through `singleMedia`, below, and never expires).

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
| the video's `width`/`height` missing, or `width / height > maxAspectRatio` (4:5) | the rule of 2026-11-09: a reel is vertical |
| `durationMs` present on a post that is not a reel | one fact, not two |
| `media` is not exactly ONE entry of `type: "video"` with a `video/*` MIME type | a reel is one video |
| `polls`, `forms`, `attachedFormId`, `linkedCalendarEventId` or `scheduledAt` present | none has a meaning on a reel that expires; a scheduled reel would also start its month before anybody could see it |
| the blob is not the author's, does not exist, or is already deleted | the claim failed |

`markdown` may be `""` for a reel (a post still refuses it). An unreachable media service is a
`503`, never a reel stored without its blob.

The response is the created post, now carrying `kind`, `durationMs`, `expiresAt`
(`createdAt` + the `retention_reel_days` setting in force, 365 by default, set ONCE at creation; 30
days before 2026-11-09).

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

**`multiMedia=true` (with `kind=reel`) adds the full-screen posts** - the photo, video and carousel
pages of the CanaReels viewer ([client half](../frontend/modules/reels.md#the-rail-the-comments-sheet-and-the-photo-pages-user-2026-10-19-instagrams-reels),
[carousels](../frontend/modules/reels.md#carousel-pages---a-post-of-several-photos-and-videos-owner-2026-11-06),
[links](../frontend/modules/reels.md#a-post-with-a-link-in-its-text-owner-2026-11-06)). The clause is
`FULL_SCREEN_POST_SQL` (`posts/full-screen-post-sql.ts`): **1 to 10 attachments, every one a picture
or a video** (each by its `type`, or untyped with an `image/` or `video/` mime type, a legacy row),
no poll, no form, no attached form, no linked calendar event; a link in the text is ALLOWED and drawn
in the caption (owner, 2026-11-06). A file, an audio or an element with neither type nor mime keeps
the whole post out; eleven or more attachments too (`CAROUSEL_MAX_MEDIA`, Instagram's cap). "Every
element" is a `NOT EXISTS` over `jsonb_array_elements`, and a column holding JSON `null` or a scalar
counts as empty through a `CASE` on `jsonb_typeof` - `jsonb_array_length` and the element function
raise on it and would fail the page. It is OR-ed into the reel filter of every feed arm, behind the
same visibility rules, and keys its own cache entry (`+carousel-links`). Without `kind=reel` it
means nothing.

**One switch since 2026-11-11.** The list grew in four steps - `singlePhotos` (one picture,
2026-10-19), `singleMedia` (one picture or video), `multiMedia` (carousels) and `withLinks` (a link
in the text, all 2026-11-06) - each older switch keeping its narrower meaning for the installed
clients that could not draw the wider one. Every client the `1.6.6` floor admits sends `multiMedia`
(with `withLinks`), so the four collapsed into one: `singlePhotos`, `singleMedia` and `withLinks` are
no longer DTO fields, the whitelisting `ValidationPipe` strips them, and a floor client that still
sends them gets the list it asked for ([legacy-compatibility](../legacy-compatibility.md#entries-166-retires-or-unblocks-the-owners-raise-of-2026-11-08)).

**`kind=reel` is ordered by `publishedAt` alone** (`listOrderSql`): a pin is a feed concept and does
not head the CanaReels list. Every `listPosts` and `searchPosts` order ends in `posts.id DESC`, so
posts published at the same instant (scheduled ones) can neither repeat nor be skipped across
`OFFSET` pages; the post an event card links back to is picked the same way. **A video post never
expires**: only a `reel` (or a live `replay`) row has an `expiresAt`, and the live-row clause
(`posts."expiresAt" IS NULL OR posts."expiresAt" > NOW()`) leaves a plain post alone; the viewer
draws it as a `reel` page (`fullScreenPageOf`), so the save button, the rail's reactions and the
comments sheet read it like any post. Pinned by `full-screen-post-sql.integration.spec.ts` (the
exact set on a real PostgreSQL: the bounds 10 and 11, a mix with a caption, legacy elements by mime,
each exclusion, JSON `null` and scalars) and `posts.service.reels.spec.ts` (every arm, "means
nothing without `kind=reel`", the retired switches turn nothing on).

**Saving a feed video (decided 2026-11-06, reversible).** The 2026-10-09 rule *any reel can be
saved* now covers a feed video shown in the viewer. It is saved under its OWN type, never relabelled
an MP4: `saveReel.ts` takes the extension and the mime from `ref.mimeType` (mp4, mov, webm, m4v,
3gp; anything else an mp4) and names it `canari-video-...` rather than `canari-reel-...` (a reel in
a conversation, with no `kind`, stays `canari-reel-...`). The mime goes down to the native save
(`save_video`'s optional `mime`, default `video/mp4`, so an older client still works): Android's
`GalleryPlugin.kt` writes it into MediaStore, and the Rust command renames the staged file to the
name's extension because iOS Photos reads the container off the extension. **iOS Photos reads no
WebM, so the rail hides the save for a WebM in the iOS app** (`canSaveVideo`); the web and Android
keep it.

**The next slide's preload skips a long feed video (decided 2026-11-06).** A feed video is not
prepared into a reel and may be hundreds of MB; `ReelSlide` preloads the next slide's video only
when it streams (`encoding: 'segmented-v1'`) or weighs at most 28 MB (`worthPreloading`,
`REEL_PRELOAD_MAX_BYTES`, the reel cap); any other loads when its slide becomes active.

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
hidden reel still expires at its year and is purged with its row, so a pending report on a reel
nobody reviewed in that time is left pointing at a post that no longer exists - the same state as a
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
  50 MB and is gone in a year (30 days before 2026-11-09). The 90 s is the product's shape, enforced by the app and honoured by
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
- `POST /api/media/internal/reel-purge` `{ items: [{ mediaId, ownerId }], reason }` ->
  `{ results: { <mediaId>: 'deleted' | 'released' | 'absent' | 'refused' | 'failed' } }`. **THE
  ALLOWLIST OF THIS DELETE IS OWNERSHIP**: it touches an object only if the entry's `ownerId` equals
  the `ownerId` the caller names, and it is neither a public asset nor an `association` document.
  **`reason` since RC-14** (any value outside the three is a `400`; an ABSENT one is an older
  social-service, the [legacy shim](../legacy-compatibility.md): the old delete, but for a file a
  live chat hold keeps, the post hold released and `refused` answered): `moderation` (a moderator's or
  an admin's delete of someone else's reel) purges the file with every hold on it; `author` (the
  publisher's own delete) and `retention` (this worker) release the post's hold alone, so a file the
  take also sent to conversations is `released` and stays until its chat hold lapses
  ([media-service holds](media-service.md#holds-one-file-for-the-feed-and-the-chats-rc-14-2026-11-01)).
  `absent` (no entry, or already purged) and `released` are success; `refused` (not the named owner)
  is a terminal "not ours", left alone and logged at `warn`; `failed` (the store refused, or threw)
  is the only outcome that keeps a reel's row for the next tick.

**Why ownership and not "class is `reel`"**: a comment on a reel may carry a media, uploaded by the
commenter under another class. The worker deletes those too (nothing dead stays), naming the
COMMENTER as owner. A member who cites somebody else's blob id in a reel or a comment can therefore
never get it deleted - the entry says whose it is.

## The worker: `ReelRetentionScheduler` (social-service)

Hourly (`@Cron('23 * * * *')`). Everything it knows is in the database:

1. **Select** reels - and live replays past their three days ([live-replays](../live-replays.md)) -
   with `kind IN ('reel', 'replay') AND "expiresAt" <= NOW()`, oldest first, in batches of 50.
   That predicate IS the state: a reel is due, or it is not, and a row that has been deleted is done.
   No timestamp of the last run, no marker.
2. **Per reel, in isolation** (a `try` per item): list the blobs - the reel's own media and every
   comment's media with the comment's author as owner - call `reel-purge`, and **only if no blob
   came back `failed`**, delete the row and its `post_notifications`. The row delete is
   `DELETE ... WHERE id = $1 AND kind IN ('reel', 'replay') AND "expiresAt" <= NOW()`, so **a plain post
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

## What was verified, and how (2026-10-02)

- **Unit**: the rules, the service paths, the worker (fake store with the media service's
  vocabulary and ownership allowlist), the media service's claim and purge.
- **Real PostgreSQL**: `reel-retention.integration.spec.ts`, gated on `SOCIAL_IT_DATABASE_URL`
  (run in CI by `test-social-integration` since 2026-10-15): migration 069 applied twice, nothing existing becomes a
  reel, the CHECK refuses a reel stated in pieces, only the due reel is selected and deleted, a
  failed transaction leaves the row AND its notifications, a failing blob keeps only its own reel.
- **Running local estate**: this branch's media-service and social-service against the estate's
  PostgreSQL (scratch database), Redis (db 5) and Garage, over HTTP: every refusal answers `400`, a
  reel publishes and reads back with `kind`/`durationMs`/`expiresAt`, `my-reels` carries the key, an
  expired reel answers `404` before the worker runs, the real worker deleted the row, the
  notification and both blobs (reel and a commenter's media) while a post, a live reel and a
  foreign blob stayed; the second run found nothing; with the media service unreachable the row was
  kept and logged, then deleted on the next run; a reel deleted by hand loses its blob at once.
- **Not run**: the cron firing itself (a unit-tested one-line `@Cron`), and a real blob refusing
  deletion (simulated at the store boundary only).

## Migration 158: the reels already published move to the year (2026-11-09)

`158_reels_live_one_year.sql` re-dates every LIVE reel to `"createdAt" + 365 days`, the stamp the
create path writes under the new rule. Its `WHERE` is an allowlist: `kind = 'reel'` (never a post,
**never a live replay** - `kind = 'replay'` keeps its own three days, [live replays](../backlog.d/live-replays-kept-three-days-as-canareels.md)),
`"expiresAt" > now()` (a reel already past its month is dead to every read and may have lost its blob
to a `failed` purge, so it is left to the worker rather than brought back), and an expiry earlier than
the year (it only moves FORWARD, so a re-run changes nothing). Data only, row locks on the live reels,
not held (an `UPDATE` backfill is plain to the judge). The hourly worker needs no change: it deletes by
the stored `expiresAt`, whichever lifetime wrote it. Pinned by
`reels-one-year-migration.integration.spec.ts` (a live reel moves; a replay, a post, a dead reel and a
reel already on the year do not; the second run updates 0 rows; the interval equals
`REEL_RETENTION_DAYS`), mutation-checked by widening the `WHERE` to `replay`.

**What it costs** is read on production (read-only, `BEGIN READ ONLY` / `ROLLBACK`): the live reels,
their bytes as each row's `media[0].size` declares them (media-service keeps no SQL table of sizes),
and the daily publish rate of the last 30 days - the storage a year holds is roughly that rate x 365
x the mean size.

**Measured by the lead on production, 2026-11-09 (read-only, numbers only):**

| What | Value |
| --- | --- |
| Live reels today | 9, 31 MB in total (mean 3.5 MB), the oldest from 2026-10-19 |
| Publish rate, last 30 days | 0.3 reel/day, about 1 MB/day |
| A year of reels at that rate | about 110 reels, 373 MB |
| Upper bound of what the vertical-video rule adds (the composer's single-video posts, last 30 days) | 15 posts (0.5/day), 184 MB in 30 days - at most about 2.2 GB a year, if every one were vertical and 90 s or less |

**Conclusion: the one-year lifetime costs a few GB a year at most - not a storage concern.**

## The migration: `069_posts_reels.sql`

Adds `kind varchar(16) NOT NULL DEFAULT 'post'`, `"durationMs" integer NULL`, `"expiresAt"
timestamptz NULL`, a CHECK that ties the three together (a post carries neither of the other two; a
reel carries both), and a PARTIAL index on `"expiresAt" WHERE kind = 'reel'` so the worker's
predicate stays a handful of entries however large `posts` gets. **Nothing existing becomes a
reel**: the default is `'post'` and there is no `UPDATE`.

**The boot backfill that classifies feed media `archive` (`PostMediaRetentionService`) skips
reels**, and a second pass re-applies `reel` to every live reel's own blob. Without the skip, the
next boot would flip every reel's blob to `archive` - silently out of the worker's class.
