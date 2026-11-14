# Live replays - a finished live kept three days as a CanaReel

**State (2026-11-09): DESIGNED, every question decided by the owner on 2026-11-09
([the decisions](#the-owners-decisions-of-2026-11-09)); WP-R1 (the switch and the schema) and WP-R2
(the server, [as built](#wp-r2-as-built)) built, WP-R3 (out of the backup,
[as built](#wp-r3-as-built-the-segments-outside-the-backup)) built and owed a dev pass, the client
(WP-R4, WP-R5) and the texts (WP-R6) not built; `live_replays_mode` is `off` everywhere.**

This page is the ONE design. It reconciles the two drafts written for it: #3234 (2026-11-09, the
measured cost and the chosen mechanism, kept as the base) and #3133 (2026-11-07, closed; its
concatenation measurement, its trap list and its list of the texts to change are folded in below).
#3133 also recorded answers dated 2026-11-07 (2 h per account, a 90-day CanaReel for every vertical
or short video, the time left on reels): **the owner's answers of 2026-11-09 below replace them**. The
CanaReel rule was decided apart the same day (every vertical video of 90 s or less is a CanaReel, kept
one year, existing ones too) and is built on its own branch, not here; a replay keeps its own 3 days.

The owner's request of 2026-11-07 ([backlog entry](backlog.d/live-replays-kept-three-days-as-canareels.md)):
a finished live is kept and watchable for **3 days**, then deleted; it appears **as a CanaReel in
the feeds and the CanaReels tab**, to **the audience that could see the live**; it is downloadable
**like a reel**; **the chat is not replayed**; a live **cut by moderation or ended by an erasure
never becomes one** (lead decision).

What it reverses: L3 and Q10 ("no replay", deletion at the end) and the 20-segment trim of
2026-10-31 in [lives](services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3) - for a live that
keeps a replay only.

## The owner's decisions of 2026-11-09

Answered by the owner on 2026-11-09, recorded as DECIDED. Each one names where it is built.

| # | Decision (owner, 2026-11-09) | Where it is built |
| --- | --- | --- |
| D1 | **A replay keeps the last 3 hours of a live at most.** A 10-hour live keeps its end. | the trim, by the segments' own database times ([section 2](#c-in-detail), step 1), `LIVE_REPLAY_MAX_MS` |
| D2 | **Replays are never in backups.** | WP-R3: the live segments go to a volume of their own, `live_segments`, that `backup-objects.sh` never mounts ([as built](#wp-r3-as-built-the-segments-outside-the-backup)) |
| D3 | **The time left is shown on replays** ("encore 2 j"); a reel keeps its age. | WP-R4, from `expiresAt` and the server's `serverNow` |
| D4 | **A replay is kept only for a live that lasted at least 30 s** (a false start shows nothing). | the replay creation, `LIVE_REPLAY_MIN_MS`, read from `lastSegmentAt - startedAt` |
| D5 | **A total space cap, default 20 GB, a config value**: past it, **the oldest replay is deleted before its 3 days**, and **admins are signalled**. | the live sweep, `LIVE_REPLAY_TOTAL_MAX_GB`; the signal is a `WARN` line tagged `[LIVE_REPLAY_CAP]` and the replay line of the admin storage panel (the channel that exists: [the cap](#the-total-cap-and-how-admins-learn-of-it)) |
| D6 | **A replay cannot be republished or reposted into a feed.** Sending it in a message works only where it already works: a shared link opens for a reader the replay's own rule admits, and for nobody else. | the repost and republication writes refuse `kind = 'replay'` |
| D7 | **A replay removed by moderation is a simple deletion: no strike, no consequence for the broadcaster** (unlike a moderation CUT of a live). | `DELETE /api/posts/:id` by staff, unchanged; nothing is written to `live_cuts` |
| D8 | **"Entre étudiants" on an association's live: not now.** The replay has exactly the live's audience. | the replay is created with `studentsOnly = false` |

**Read by the lead, reversible** (the owner's delegation): a CUT of the live itself through its own
report (`POST /api/lives/:id/cut`, accepted while the live row exists - now during the three days)
stays a cut of a live, with its strike, and deletes the replay first; D7 covers the replay POST
(reported as a post, deleted by staff). Two different acts, two different consequences, as before.

**Decided by the owner on 2026-11-09, built APART from this design** - *"un truc général pour toutes
les vidéos du genre ? 90 s et vidéos verticales ?"*: every vertical video of 90 s or less is a
CanaReel, and CanaReels are kept one year, the existing ones too. That work moves
`REEL_RETENTION_DAYS` and the `kind = 'reel'` rows; **a replay is untouched by it**: its
`expiresAt` is written once at its publication from the admin setting `retention_live_replay_days`
(3 by default, a constant until 2026-11-14 - [retention-settings](retention-settings.md)), never from
the reels' own setting, and any re-dating of existing reels must name `kind = 'reel'`, never `'replay'`.

## 1. What a replay costs, measured

### The bitrate, from production and from the bench

**Production, 2026-11-09** (read-only, social-service's `[LIVE]` lines since the last deploy:
every `segment N of <live> stored (B)` line summed per live, between the live's first and last
segment):

| Live (id prefix) | Segments | Bytes stored | Span | Mean rate | Per hour |
| --- | ---: | ---: | ---: | ---: | ---: |
| `1496e2ab` | 580 | 308.7 MB | 1 192 s | 2.07 Mb/s | 0.93 GB |
| `195d119d` | 415 | 206.9 MB | 846 s | 1.96 Mb/s | 0.88 GB |
| `8f4e8161` | 72 | 35.9 MB | 146 s | 1.97 Mb/s | 0.89 GB |
| `fd322da3` | 20 | 6.4 MB | 38 s | 1.34 Mb/s | 0.60 GB |
| **All four** | **1 087** | **557.9 MB** | **37 min** | **2.01 Mb/s** | **0.90 GB** |

A segment is 2.04 s and 513 kB on average. **No durable record of past lives exists** (a live's row
is deleted at its end, `live_starts` after an hour), so lives per day is not measurable from
production today - WP-R1 adds the duration and the bytes to the `[LIVE]` end line.

**The WP-L1 bench** ([live](frontend/modules/live.md#wp-l1---measured-2026-10-19)): an Android
broadcaster sends **3.08 Mb/s = 1.39 GB/h**, an iPhone **2.32 Mb/s = 1.04 GB/h**. The seal adds 28
bytes and each self-contained segment repeats its ~1.2 kB init: 0.2 %, ignored below.

**So a replay costs 0.9 to 1.4 GB per hour of live**, and D1 bounds one replay at **2.7 to 4.2 GB**.

### What three days hold, and the cap

| Scenario | Lives a day x length | Stored a day | **Standing (3 days)** |
| --- | --- | ---: | ---: |
| S0 - the day measured | 4 lives, 37 min in all | 0.56 GB | **1.7 GB** |
| S1 - ordinary | 4 x 30 min | 1.8-2.8 GB | **5.4-8.3 GB** |
| S2 - an event week | 10 x 45 min | 6.8-10.4 GB | **20-31 GB** -> held at **20 GB** by D5 |
| S3 - a phone forgotten on air | 1 x 10 h | - | **2.7-4.2 GB** by D1 (was 9-14 GB) |

**Against the disk** (a read-only reading of the shared host on 2026-11-09, figures in the operators'
private notes): the root filesystem was 36 % used, with about **44 GB** of headroom before the 75 %
threshold the host's image-prune rule reads. D1 and D5 together make the replays' worst case 20 GB
plus the lives still running, under half of it.

### Why the backup decided the shape (D2)

The media store is backed up nightly by restic (`backup-objects.sh`: the Garage volumes, 14 daily,
8 weekly, 6 monthly, [backup](infrastructure/backup.md)) into a repository on the same disk. Garage
keeps an object as content-addressed blocks, not under its key, so **the backup cannot leave out the
`live/` prefix** (checked again for WP-R3: `garage_data` is `data/<2 hex>/<2 hex>/<block hash>`, and
which block belongs to which key is only in `garage_meta`'s database). A snapshot holds the replays alive that night; the retained union is about 47 days'
worth of replay: **~26 GB at S0, ~85-130 GB at S1** - more than the headroom, and a replay promised
"deleted after 3 days" would survive up to six months in a backup. Hence D2 and WP-R3.

**Egress.** A replay viewer pulls what a live viewer pulls (~2-3 Mb/s) through the same nginx
segment location (per-address limits, the `live_segments` cache) but takes NO seat: replays are
uncapped like reels. Owed a reading once replays exist.

## 2. How the segments are kept, and how they become a CanaReel

### Today

The broadcaster's phone seals each ~2 s segment (AES-256-GCM under the live key, AAD = label + live
id + index, [seal v1](frontend/modules/live.md#the-segment-seal-format-v1)); each segment is
**self-contained** (the recorder's init `ftyp`+`moov`, then ONE fragment `moof`+`mdat`). media-service
stores it under `live/<liveId>/<random uuid>`; `live_segments` keeps `(liveId, index, name, bytes,
sha256, createdAt)`. After each confirmed segment `LivesService.trim` deletes what is older than the
newest 20; at the end `purgeEnded` deletes the prefix, proves it empty by a second listing, then
deletes the row ([lives](services/lives.md#what-one-broadcaster-may-store)).

### The three ways to make a reel object, compared

| | A - one MP4 concatenated at the end | B - re-sealed as a `segmented-v1` reel blob | **C - the live's own segments, served as a replay (CHOSEN)** |
| --- | --- | --- | --- |
| Who does the work | the server (decrypt, re-mux, re-seal) or the phone (re-upload) | a client: download, open, re-seal, upload | nobody: the bytes stored stay |
| Bytes written again | the whole live | the whole live | **none** |
| Fits the reel pipeline | **no**: one blob is capped at 50 MB (`MEDIA_MAX_SIZE_MB`) = ~3.5 min of live | no, same cap | n/a |
| Rules it breaks | "the server only stores" (a server re-mux decrypts every byte) | a GB-sized upload from a phone after the fact | none |
| Reuses | the reel worker | the reel player | **the seal and its index binding, the key at rest and its one reader, the segment store, the nginx cache, the purge and its empty-listing proof, the MSE player, the post row (comments, reactions, reports, feed)** |

**Measured by #3133, 2026-11-07, with the repo's own `Fmp4Splitter`, `composeSegment` and
`rebaseFragment` over ffmpeg encodes of the live's profile** (H.264 baseline, AAC-LC, 2 s keyframes,
fragmented), each result decoded to the end with ffmpeg 8.0.1:

| Joined file | Inits | Result |
| --- | --- | --- |
| A + B, every segment end to end (init repeated) | identical (byte-equal) | 300 frames, 0 decode errors, the 4 s background gap kept as a timestamp gap |
| A + B, an init only when it differs (the viewer's rule) | identical | the same |
| A + C (another frame size) | **different** | **725 decode errors**: C's pictures read with A's parameter sets |

So **one file by plain concatenation is valid only while every init is the same**; where a new
recorder wrote a different init, one MP4 cannot hold both (one `moov`). MSE has no such limit - the
live player already appends a new init mid-stream. What was NOT read: real recorder output (whether
two generations of one phone write byte-equal inits) and any player but ffmpeg - readings 2 and 3.

### C in detail

1. **The trim keeps the replay, bounded in TIME (D1).** For a live that keeps a replay
   (`lives."keepsReplay"`, fixed at the start from `live_replays_mode`, so a flip mid-live never makes
   half a replay), `trim` deletes the segments whose `createdAt` is more than `LIVE_REPLAY_MAX_MS`
   (3 hours) older than the newest segment's - the database's own times, never a process clock - and
   never the newest 20. Everything else of the trim is unchanged (the media delete first, then the
   rows and `storedBytes` in one transaction, idempotent from durable state). A live with
   `keepsReplay = false` keeps today's 20. The bytes stay bounded by the ingest's own limits
   (`LIVE_SEGMENT_MAX_BYTES`, one segment per `LIVE_SEGMENT_MIN_DURATION_MS`).
2. **The end creates the replay, in the purge, idempotently.** `purgeEnded`, for an ended live with
   `keepsReplay`, no `live_cuts` row, a broadcaster that is not `DELETED_ACCOUNT`, the drain over (the
   seat rule of today), at least one stored segment and `lastSegmentAt - startedAt >=
   LIVE_REPLAY_MIN_MS` (30 s, D4), inserts the replay POST instead of purging: `kind = 'replay'`,
   `"liveId"`, the author and association of the live, `publishedAt = endedAt`, `"expiresAt" = endedAt
   + 3 days` (the database clock), `"durationMs"` from the first and last kept segment, the live's
   title as caption, `studentsOnly = false` (D8). **A UNIQUE partial index on `posts."liveId"`** makes
   the insert idempotent (`ON CONFLICT DO NOTHING`): two replicas, a crash, a retry - one replay. In
   the SAME transaction the live's chat rows and reaction bursts are deleted (**the chat stays
   ephemeral**; a reported line is in its own table under its own rule); the arrival keys go after the
   commit, as at a purge.
3. **The purge waits for the replay post, and nothing else.** An ended live whose replay post EXISTS
   is kept (a `debug` line, no clock); once the post is gone - expired and deleted by the worker,
   deleted by its author or staff, evicted by the cap - the next 30 s sweep purges the live exactly as
   today. A cut or an erasure deletes the replay post first, then purges.
4. **The replay is read through ONE new route**, `GET /api/lives/:id/replay?from=<index>`:
   `{ liveId, postId, key, durationMs, expiresAt, serverNow, segments: [{ index, name, bytes, atMs }],
   nextFrom }`, 200 segments a page, `no-store`, **no seat**. `key` comes from `openLiveKey` (the one
   reader of the key at rest; the key is NEVER copied into the post row - a reel's CEK sits in
   `posts.media`, and copying the live key there would undo migration 110); `atMs` is `createdAt -
   first createdAt` on the database clock (the seek map; the media time stays the fragments' `tfdt`).
   It answers `404 LIVE_NOT_FOUND` to anyone the replay post is not visible to, a block either way, a
   viewer the broadcaster removed, and once `expiresAt` has passed.
5. **The segment fetch is unchanged**: `GET /api/media/public/live/<liveId>/<name>`, token-free,
   ciphertext, answered by nginx's `live_segments` cache.
6. **The player gains a replay mode** (WP-R4): it starts at the first listed segment (a replay
   trimmed by D1 does not start at 0), appends in order, keeps a bounded buffer, and seeks by taking
   the last segment whose `atMs` is at or before the target - the join logic, at any index.
7. **Download, like a reel** (WP-R5): one fragmented MP4 written segment by segment into the gallery
   staging (`reels/gallery.ts`), never the whole replay in memory; **a new part where the init
   changes** (`-2.mp4`), per the measurement above; the size said before the save.

## 3. Retention: the three days are durable state

**One column, one predicate, two existing sweeps, no timer.**

- **`posts."expiresAt"`**, written ONCE at the replay's creation (`endedAt + 3 days`), as a reel's
  (`createdAt + 30 days`). `posts_kind_shape` gains the `replay` shape (`durationMs`, `expiresAt` and
  `liveId` all present; `liveId` is NULL on every other kind).
- **Every read excludes an expired row**: the clause `posts.kind <> 'reel' OR "expiresAt" > NOW()`
  became `"expiresAt" IS NULL OR "expiresAt" > NOW()` (WP-R2), which covers every kind that expires.
- **`ReelRetentionScheduler`** (hourly) selects `kind IN ('reel', 'replay') AND "expiresAt" <= NOW()`
  (its partial index follows), per-row step unchanged: purge the blobs (a replay has none of its own -
  only its comments' media), then delete the row. **The replay's segments are NOT its blobs**: the
  post row's deletion is what lets the live sweep purge them, with its own proof.
- **Worst case**: a replay is gone **3 days + 1 hour + 30 s** after its live ended.

**What goes with a replay when it is deleted**, the reel's rule: its comments and reactions, its
comments' media, its notifications; a link to it shows "unavailable"; a copy a member SAVED stays
theirs. **Reposts and republications are refused at creation** (D6), so none can outlive or widen it.

**Who may delete it earlier**: whoever may delete the post (the broadcaster, a `POST_AS_ASSO` holder
for an association's live, a moderator, an admin) - no strike (D7); the segments follow within 30 s.

### The total cap, and how admins learn of it

**D5, built in the live sweep (WP-R2, `LivesService.enforceReplayCap`).** After the purges, the
sweep sums `storedBytes` over the lives whose replay post is still showing (`"expiresAt" > now()`).
While the sum is above `LIVE_REPLAY_TOTAL_MAX_GB` (default 20, an environment value of
social-service, read once at construction, refused at boot when not a positive number), it ends the
OLDEST replay (smallest `expiresAt`, then the post id) by the one early end every path uses -
`posts."expiresAt" = now()` - so every read refuses it at once, the hourly worker deletes the post
(comments and their media) and the next sweep purges the segments. Each round runs under one
transaction-scoped advisory lock, so two replicas never evict twice for one excess; each round ends
one replay still showing, so the set shrinks and the loop stops under the cap - a proof, not a
clock.

**The signal to admins, on the channel that exists.** Canari has no push or mail to admins: the
operations reports are the scheduled jobs and the admin storage panel, "display only, no alert"
([admin storage](infrastructure/storage-and-retention.md)). So an eviction is:

- a `WARN` line, tag **`[LIVE_REPLAY_CAP]`**, naming the live, the bytes freed, the total before and
  the cap - stable, so a log search or a later report job can count it;
- a row of `live_replay_cap_evictions` (`liveId`, `bytes`, `totalBytes`, `capBytes`, `evictedAt`;
  pruned after 30 days by the same sweep), read by the **admin storage panel's replay line**
  (chat-delivery `GET /mls/admin/storage`, `replays`): replays showing, their bytes, the evictions on
  record (30 days) and the latest one with the cap it was judged against. The cap itself is not
  copied into chat-delivery; each eviction row carries the value it was judged against.
- and the `[LIVE_GC]` line counts them (`replays=` published this run, `capEvicted=`).

## 4. Audience and visibility: exactly the live's

The replay's audience is the live's: `liveVisibleToUserSql` and the post rule are built from the same
fragments. On a replay row (`anonymous = false`, `studentsOnly = false`) the post rule's personal
branch is the live rule's (shared space or accepted follower), its association branch the live's
(member, its rules, a read grant). The post rule's three extra doors are closed:

| Door of the post rule | On a replay |
| --- | --- |
| Member repost (WP-F6) | refused at creation (D6) |
| Republication by an association / a personal carrier | refused at creation (D6) |
| "Entre étudiants" (`studentsOnly`) | created OFF (D8): the live has no such switch |

On top of the post rule, every read applies what the live applied:

- **A block, either way**, hides it (the feed's blocked-author filter; the route's 404).
- **A viewer the broadcaster REMOVED from the live** does not see the replay: the post visibility
  predicate itself carries `NOT EXISTS live_removed_viewers` for a `replay` row, so the feeds, the
  read by id, a reaction, a comment, a report and a notification all refuse it alike (lead decision).
- **A named reader whose "voit les commentaires" is off** watches it and sees no comments.
- **An archived association** keeps its replays until they expire (lead decision).
- **No push** (lead decision): the live already announced itself.
- **Older clients never receive a replay.** The feed and the CanaReels list include `kind = 'replay'`
  only when the client sends `withReplays=true` (the precedent of `withLinks`); `GET /api/posts/:id`
  answers a replay only with `withReplays=true`; every other list (search, pins, a profile) leaves
  replays out.

## 5. What a CanaReel is: the audit

The CanaReels list is `GET /api/posts?kind=reel&multiMedia=true`
(`reels/allReels.ts`), drawn by `fullScreenPageOf` (`reels/fullScreenPost.ts`):

| Item | How it gets in | Kept | Where the rule lives |
| --- | --- | --- | --- |
| **Reel** - filmed with the Canari camera, 90 s at most (C4) | `kind = 'reel'` | **30 days** from publication when this page was written; one year by the owner's decision of 2026-11-09, built apart | `REEL_RETENTION_DAYS`, each row's `expiresAt`, `ReelRetentionScheduler` |
| **One picture** | `FULL_SCREEN_POST_SQL` | as long as the post | media class `archive`, never swept |
| **One video not filmed with the Canari camera** | `FULL_SCREEN_POST_SQL` | as long as the post | same |
| **A carousel**, 2 to 10 items | `FULL_SCREEN_POST_SQL` | as long as the post | same |
| Any of the three with a link | `FULL_SCREEN_POST_SQL` (one clause since 2026-11-11) | as long as the post | same |
| A repost of any of these | the same row | the original's rule | the original row |
| **Replay** (this design) | `kind = 'replay'`, with `withReplays=true` | **3 days from the live's end** | `posts."expiresAt"`, the same worker |

Outside the tab: a reel SENT in a conversation (30 days by age, media-service), an open live.

**The model this page builds**: a CanaReel is any post the viewer can draw full screen; expiry is a
property of an item's ORIGIN held in ONE column, `posts."expiresAt"` (NULL = permanent); one read
predicate, one worker. Two origins expire: the camera (a reel's retention) and the live (3 days). The
owner's rule of 2026-11-09 for every short vertical video is built apart (above); the live's 3 days
are its own constant whatever the reels' retention becomes.

## 6. Migrations, work packages, readings

### Migrations

| Service | File | What | Held? |
| --- | --- | --- | --- |
| core | `021_platform_config_live_replays_mode.sql` | `live_replays_mode varchar(16) NOT NULL DEFAULT 'off'` + CHECK, the calls/lives pattern | plain (additive) |
| social | `156_live_replays.sql` | `lives."keepsReplay"`; `posts."liveId"` (FK to `lives`, no cascade) + its UNIQUE partial index; `posts_kind_shape` re-created with `replay`; the expiry index re-created on every row with an `expiresAt` (`idx_posts_expiry`, read by the worker for reels and replays alike); `live_replay_cap_evictions` | plain - every statement on the allowlist of `migration-hold.sh` |

(`154` and `155` are taken by open drafts #3233 and #3237.) **No held migration**: nothing is
dropped but a constraint and an index re-created in the same file, no row is rewritten.

### The work packages, in order

| WP | What | State |
| --- | --- | --- |
| **WP-R1** | the two migrations; `live_replays_mode` read like `lives_mode` (`GET /api/version` `liveReplays.mode`, `/admin/platform`); `keepsReplay` written at the start; the `[LIVE]` end line carries the live's duration and stored bytes | built (this page's pull request) |
| **WP-R2** | the time-bounded trim; the replay creation (idempotent), the chat deleted at it; the purge waiting for the post; a cut or erasure ending the replay; `GET /api/lives/:id/replay`; `withReplays`; the read clause and the worker on `expiresAt`; reposts and republications refused; the removed-viewer term; the total cap and its signal | built, inert while the switch is off ([as built](#wp-r2-as-built)) |
| **WP-R3** | the live segments on a volume of their own, `live_segments`, outside `backup-objects.sh` (D2); `MIGRATION.md`; **a dev pass before production**; must ship before the switch is flipped | built in the repo, owed its dev pass ([as built](#wp-r3-as-built-the-segments-outside-the-backup)) |
| **WP-R4** | the replay mode of `livePlayer`, the replay page and feed card (cover, "Rediffusion", duration, time left - D3), the end screen, the pre-live sheet; the first-live rules raised to version 3 moved to WP-R6 ([why](#wp-r4-and-wp-r5-as-built)) | client, built ([as built](#wp-r4-and-wp-r5-as-built)) |
| **WP-R5** | the segment-by-segment save, a new part on an init change, the size first | client, built ([as built](#wp-r4-and-wp-r5-as-built)) |
| **WP-R6** | the texts (below), then `live_replays_mode = on` on dev, the readings, then production | not built |

### WP-R2, as built

Everything below is reached only by a live started with `keepsReplay` (the switch on at its start),
so with the switch off nothing changes for any live.

- **The trim** (`LivesService.trim`): such a live keeps its last 3 hours (D1) - a segment goes only
  when it is behind the window AND older than three hours before the newest one, by the segments'
  own `createdAt`.
- **The publication** (`publishReplay`, from `purgeEnded` once the drain is over and nothing is
  storing): ONE transaction under the live's row lock re-reads every fact - ended, `keepsReplay`, not
  yet published, not cut, not erased, `lastSegmentAt - startedAt >= 30 s` (D4) - inserts the
  `kind = 'replay'` post (`ON CONFLICT ("liveId") DO NOTHING`), stamps `replayPostedAt`, deletes the
  live's chat and reaction bursts. The post: the broadcaster as author, the live's association, its
  title as text, `publishedAt` = the end, `expiresAt` = the end + 3 days (written once, database
  clock), `durationMs` = first to last kept segment, `studentsOnly = false` (D8),
  `allowReposts = false` (D6), `feedNotifiedAt` set so **no push announces a replay** (lead decision,
  reversible). `replayPostedAt` answers "already published" for ever, so a replay deleted early is
  never published again; the live is then purged by the next sweep.
- **The purge waits for the post** and for nothing else; a replay that exists keeps the live
  (`endedLiveIds` leaves it out, unless its broadcaster was erased and the replay still shows).
- **A cut ends the replay at once** (`cut` -> `expireReplay`, in the cut's own transaction) - a cut is
  moderation of the LIVE and keeps its strike; **a staff deletion of the replay POST is D7**: the
  post's ordinary deletion, no strike. **An erasure ends it in its own transaction**: it locks the
  account's lives first (`ERASURE_LIVES_LOCK_SQL`, the order a publication and a cut take them, so a
  replay being published is seen or never published), a personal replay goes with the account's
  posts, and an association's is ended and loses the title it copied (`live_replays`, before the live
  forgets its broadcaster); the sweep's erased-broadcaster term is the backstop.
- **A replay is edited by its caption alone**, as a reel (no media, poll, form, event or schedule),
  and refuses the "Entre etudiants" switch (`students_only_not_offered`, D8).
- **A publication, a cut, an eviction and an erasure met by the sweep invalidate the feed cache**
  (`invalidatePostListCache`, after the commit), as every post write does - never a 30 s TTL later.
- **`GET /api/lives/:id/replay?from=N`** (behind `LiveEnabledGuard`, `no-store`): the live key, the
  segments from `N` with `atMs` on the database clock, `nextFrom`, `expiresAt` and `serverNow` (the
  time left, D3, is computed against the server's clock). No seat. The gate is the replay post's own
  (`readPostOpenVerdict`): its audience, moderation, a block either way with its broadcaster - an
  association's replay included, as its live was (the feed's `blockedAuthorSql` exempts every other
  association post, a replay alone not: the live had already named its broadcaster) - and the
  **removed viewer** (a viewer the broadcaster removed from the live never sees the replay). Any
  refusal and an expired replay are the same `404 LIVE_NOT_FOUND`.
- **`withReplays`** on `GET /api/posts` (the feed, and `kind=reel` - the CanaReels list) and on
  `GET /api/posts/:id`: a client that does not say it can draw a replay never receives one - a
  replay by id is then `404`. Search, the linked-event post, pins, member-repost cards and the
  personal-request list never carry a replay. The removed-viewer term is in every list arm that
  serves replays. The feed cache keys a page with replays apart (`+replays`).
- **Every read** drops a row past its `expiresAt` (`posts."expiresAt" IS NULL OR > now()`, the reels'
  clause generalised), and **the hourly worker** deletes `kind IN ('reel', 'replay')` past it.
- **Reposts and republications are refused** with the typed `403 POST_REPLAY_NOT_REPOSTABLE`
  (`assertNotReplay`), after the visibility check, in the association republication, the personal
  republication (ask and accept) and the member repost. Sending a replay in a message is not built:
  a chat attachment names a reel's own blob, which a replay does not have.
- **The cap**: [above](#the-total-cap-and-how-admins-learn-of-it).

### WP-R3, as built: the segments outside the backup

**The choice: a plain disk volume of media-service, not a second Garage node.** The design first named
a second Garage node with its own volumes and a second S3 client. Checked before building, the
premise holds (no prefix of one Garage can be left out of its backup, above), but the remedy was
heavier than the problem:

| | Second Garage node | Second bucket of the same Garage | **A volume of media-service (CHOSEN)** |
| --- | --- | --- | --- |
| Out of the backup | yes, by not mounting its volumes | **no**: same `data_dir`, same blocks | **yes, by not mounting `live_segments`** |
| New moving parts | a container, an RPC secret, an admin token, an access key, a bucket, a healthcheck, a second S3 client | - | **one volume, one directory class** |
| New secrets / bootstrap | 4 secrets on 2 estates, the `--default-bucket` provisioning | - | **none: `docker compose` creates the volume, media-service its directories** |
| Writers | any media-service replica | - | ONE: media-service is `exclusive` (one container, recreated in place, [cicd](cicd.md)), the reason its metadata index is already one JSON file on `media_meta` |

What the segments need from a store is small: a ~0.5 MB object put, read, deleted and listed by
prefix, one writer, no range, no presigning. A directory gives all of it, and the backup is an
allowlist of volume NAMES, so a volume it does not name is out of it by construction - the precedent
is `media_upload_sessions`, already "DELIBERATELY not backed up".

**What was built:**

- **`LiveSegmentStore`** (`apps/media-service/src/media/live-segment-store.ts`): the key
  `live/<liveId>/<name>` is the file `$LIVE_SEGMENTS_DIR/live/<liveId>/<name>`; written in
  `.staging/` then renamed (a reader sees a whole segment or none; staging is emptied at boot, one
  process); a key outside `live/`, not exactly `live/<folder>/<name>`, or resolving outside the root
  is refused (so a delete's folder removal can never name `live/` itself); deleting a live's last
  segment removes its folder, so the orphan reaper's folder listing names only lives that hold bytes
  (no store races that: a live on air keeps its newest 20 segments, and its purge runs after its end
  and the drain of its uploads). `LiveSegmentsService` reads it through the same six calls it read
  Garage with, so the trim, the purge and its empty-listing proof, the reaper and the public read are
  unchanged; the posters (`live/<liveId>/<uuid>`) move with them.
- **The split holds whoever writes**: `StorageService.put` and `putFileStream` REFUSE a `live/` key,
  so no path can put a segment back into the backed-up store.
- **The old segments are drained**: at each boot media-service deletes every live segment left in
  Garage (the lives on air at the deploy - no replay can be there, the switch ships after WP-R3) and
  logs `[LIVE_STORE] ... drained=N leftAlone=M`. The delete is an ALLOWLIST of one key shape,
  `live/<uuid>/<uuid>` in canonical lower case (`LiveSegmentsService.isSegmentKey`, what `key()`
  wrote, segments and posters alike), never the bare prefix: anything else under `live/` is named at
  WARN and kept (review of #3253); removal condition in
  [legacy-compatibility](legacy-compatibility.md#removal-once-both-estates-log-drained0---live-segments-an-older-release-left-in-garage-2026-11-09).
  A live on air during that deploy loses at most its last ~40 s window to its viewers, as any
  media-service recreate already costs.
- **The admin storage panel**: `liveSegment*` is read from the new store; `totalBytes`, `objectCount`
  and the weekly buckets describe the backed-up object store only, and a `live/` key found there
  counts as `untracked` (an accusation, not a segment).
- **Compose**: `live_segments:/app/live_segments` and `LIVE_SEGMENTS_DIR=/app/live_segments` on
  media-service in the production, dev and local files; the volume is declared in each. No deploy
  workflow change: the deploy runs `docker compose`, which creates a declared volume.
- **The guard**: `.github/scripts/tests/backup-sources.test.sh` (in `make test-ci-scripts`) runs the
  real `backup-objects.sh` against a stub `docker`, and fails if the volumes it mounts are anything but
  `garage_data`, `garage_meta`, `media_meta`, if any backup script names `live_segments`, or if a
  compose file stops mounting `live_segments` at `LIVE_SEGMENTS_DIR`.

**What it costs.** The same bytes on the same disk (Garage's volumes and this one share the root
filesystem), so section 1's figures are unchanged. A restored host starts with no live segment and no
replay (`MIGRATION.md` section 6): the replay posts that come back with the database play nothing
(every segment fetch 404s) until their `expiresAt` drops them, 3 days at most.

**Owed on dev, before any production release carries it** (and before `live_replays_mode` moves):

1. a live from a phone on dev: its segments under the dev estate's `live_segments` volume and NONE
   under `live/` in Garage (`garage` CLI or an S3 listing), the viewer plays, the poster shows;
2. the end of that live: the volume's folder for it gone within a sweep, the `[LIVE_GC]` line with
   `remaining=0`;
3. the media-service boot line `[LIVE_STORE] object store drained of old live segments: drained=N`
   at the first deploy, then `drained=0` at the next;
4. the admin storage panel's live line moving with the live, and back to 0 after it;
5. the backup (reading 7 below), on production only: the next restic snapshot holds no
   `live_segments` path.

### The texts that must change before the flip (from #3133's list)

| Text | Where | What says the opposite today |
| --- | --- | --- |
| CGU, "Directs" | `frontend/src/routes/legal/cgu/+page.svelte` | "Canari n'enregistre pas les directs et n'en propose aucune rediffusion" |
| Privacy policy, section 2 "Directs" and section 6's row | `frontend/src/routes/legal/privacy/+page.svelte` | "Un direct n'est pas enregistré et n'a pas de rediffusion"; "Supprimés à la fin du direct" |
| Register rows C19, C20 | [register-of-processing](compliance/register-of-processing.md) | "no replay, L3"; a cut targets a live "that just ended and is not purged yet" - now three days |
| The pre-live screen | `live_rule_audience_member`, `live_rule_audience_association` in `frontend/messages/*.json` | "Rien n'en est gardé après la fin." |
| The first-live rules | `LIVE_RULES_VERSION` | every broadcaster accepted "no replay": version 3, re-accepted before the next live |

### The readings owed

1. **Bytes per hour by platform**: a 10-minute live from the Mi 9T and one from the iPhone 12.
2. **A replay plays end to end** on both phones, across a background pause and a camera flip, and seeks.
3. **A saved replay plays** in the Android Gallery and in Photos, across a gap and as two parts.
4. **Expiry on dev**: `expiresAt` moved into the past by SQL, gone within an hour and 30 s, the prefix listed empty.
5. **A staff deletion** removes the replay and records NO strike (D7); a cut of the live records one.
6. **The audience**: an outsider, a blocked account and a removed viewer each get `404`.
7. **The backup**: after WP-R3, the next restic snapshot holds no replay byte (`restic ls latest` names
   no `live_segments` path, and `live/` is absent from Garage's listing).
8. **The cap on dev**: `LIVE_REPLAY_TOTAL_MAX_GB` set low, the oldest replay evicted, `[LIVE_REPLAY_CAP]` logged, the panel's line showing it.
9. **The first week in production**: the panel's replay bytes against the scenarios above.

## See also

[lives](services/lives.md), [live](frontend/modules/live.md), [reels (server)](services/reels.md),
[reels (client)](frontend/modules/reels.md), [storage-forecast](infrastructure/storage-forecast.md),
[backup](infrastructure/backup.md), [register C19](compliance/register-of-processing.md).

## WP-R4 and WP-R5 as built

The client half (`frontend/`), inert while `live_replays_mode` is `off`:

- **The switch.** `/api/version` publishes `liveReplays.mode`; `serverLiveReplaysMode()` reads it (off until a server says on, fails closed). `listPosts` and `getPost` send `withReplays` only when it reads `on` (a list that cannot draw a replay passes `false`); `PostCard` draws nothing for a replay row left in a cache while it is off.
- **`live/replayPlayer.ts`** is a separate small machine, not a mode of the 1000-line `LivePlayer`: it shares that player's MSE flavour, buffer settle, init comparison and seal, and none of its live-edge policy. It lists pages of `GET /api/lives/:id/replay`, keeps 12 s ahead and 10 s behind the playhead, and MEASURES each appended segment's place in the buffer (`newMediaStart`) rather than trusting `atMs`. A seek takes the last segment at or before the target; a seek inside buffered media only moves the cursor. A replay trimmed to its last hours is rebased to zero under a `timestampOffset` so the player's bar reads its own length. Failures: `404` is "gone", transport and busy are a backoff retry, unsupported engine and undecryptable are final.
- **`ReplayPane`** mounts the shared `VideoPlayer` (`reel` variant, `streamed`) on the MediaSource URL for the ACTIVE page only, with the "Rediffusion" mark and the time left (`replayTimeLeft`, from the replay route's own `expiresAt` and `serverNow`). `fullScreenPageOf` answers `replay`. **`ReplayCard`** is the feed card: mark, length, title, the time left, no inline play.
- **The cover and the feed's clock.** A replay row is served (`GET /api/posts`, `GET /api/posts/:id`) with its live's last preview image as `poster` and the key that opens it alone as `posterKey` (`posterKeyOf`, the open-lives card's own derivation, its outage reported once), and the database's `now()` as `serverNow` beside `expiresAt` (`readReplayRowFacts`, one query per page, only when the page holds a replay). These are added AT SERVE TIME, on a cached page as on a computed one, never stored in the 30 s page cache - a cached clock would be up to 30 s old. A failed read is logged at ERROR and the rows go out without cover or clock, never a 500; a preview name without its time (`posterAgeMs` NULL) is no cover, never an age of 0 (`servedPoster`, shared with the open-lives list). The client's poster memo is bounded (24 images, least recently used out), since nothing lists the replays' covers to prune them. No new object: the live row and its prefix are kept while the replay post exists, so the image is where the card fetched it. The card draws the cover with `LivePosterImage` under the live's id (the same memo) and the time left with the pane's `replayTimeLeft`; the pane stands the cover over the page until the picture plays (on a neighbour page too) and drops it for a blocked autoplay or a failure. The list rows now select `posts."liveId"`, which the pane needs to start.
- **No repost:** the card's menu offers no repost, republication or consent for a replay; the reel rail never had one. The rail's "Envoyer a..." stays (a link, not a repost). A replay is edited by its caption alone, as the server decided.
- **Save (WP-R5):** `ReelSaveButton` runs `saveReplayFlow` (list, say the size, confirm) then `saveReplay`: the first init once, every fragment staged at a continuing offset (`stageBlobAt`), a second part (`-2.mp4`) when an init differs; a part is committed to the gallery as soon as it is closed. On the web a part is held and handed to the download.
- **Broadcaster texts (part of WP-R6):** the audience rule, the end confirm and the broadcaster's own end screen name the replay only while the switch is on (and, for the last two, only for a live of at least 30 s: `replayFollows`). The legal pages (privacy `#directs`, CGU `#directs`, register C19) are NOT changed here: they say "pas de rediffusion" and change at the flip.

**`LIVE_RULES_VERSION` stays 2 until the flip's texts ship (WP-R6).** Version 3 is the broadcaster accepting a text that names the replay, and the rules sheet points at the CGU, which says "pas de rediffusion" until the flip; raised now, every broadcaster would re-accept, with the switch off, either a sheet promising a replay that does not happen or the unchanged text under a new number. It is raised in the pull request that changes the CGU, the privacy policy, register C19-C20 and the pre-live texts, merged before `live_replays_mode` is turned on (the table above).

Owed: the phone readings listed above (cover and time left on the card included).
