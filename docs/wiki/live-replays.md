# Live replays - a finished live kept three days as a CanaReel

**State (2026-11-19): BUILT AND ON. Every question decided by the owner on 2026-11-09
([the decisions](#the-owners-decisions-of-2026-11-09)); WP-R1 to WP-R5 built and shipped (the client in
the `1.7.0` stable); `live_replays_mode` turned `on` in production and on dev on 2026-11-19 at the
owner's request, BEFORE the texts (*"Prod maintenant, textes juste après"*,
[decision 42](backlog.d/owner-decisions-of-2026-11-19.md)); WP-R6, the texts and `LIVE_RULES_VERSION` 3,
[built](#wp-r6-as-built-the-texts) in the pull request that followed. The phone readings are owed.**

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
   (`lives."keepsReplay"`, written at the start from `live_replays_mode`, so a flip mid-live never
   makes half a replay; on an ENDED row the final verdict, written by every end -
   [below](#the-end-texts-say-the-servers-verdict)), `trim` deletes the segments whose `createdAt` is more than `LIVE_REPLAY_MAX_MS`
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
| **WP-R1** | the two migrations; `live_replays_mode` read like `lives_mode` (`GET /api/version` `liveReplays.mode`, `/admin/platform`); `keepsReplay` written at the start (on an ended row, since WP-R6, the final verdict written by every end); the `[LIVE]` end line carries the live's duration and stored bytes | built (this page's pull request) |
| **WP-R2** | the time-bounded trim; the replay creation (idempotent), the chat deleted at it; the purge waiting for the post; a cut or erasure ending the replay; `GET /api/lives/:id/replay`; `withReplays`; the read clause and the worker on `expiresAt`; reposts and republications refused; the removed-viewer term; the total cap and its signal | built, inert while the switch is off ([as built](#wp-r2-as-built)) |
| **WP-R3** | the live segments on a volume of their own, `live_segments`, outside `backup-objects.sh` (D2); `MIGRATION.md`; **a dev pass before production**; must ship before the switch is flipped | built, shipped from the `v1.6.9` stable on; the switch went on 2026-11-19; **its dev and production readings (1-5 below, and reading 7) are NOT recorded and are owed** ([backlog](backlog.d/live-replays-kept-three-days-as-canareels.md)) |
| **WP-R4** | the replay mode of `livePlayer`, the replay page and feed card (cover, "Rediffusion", duration, time left - D3), the end screen, the pre-live sheet; the first-live rules raised to version 3 moved to WP-R6 ([why](#wp-r4-and-wp-r5-as-built)) | client, built ([as built](#wp-r4-and-wp-r5-as-built)) |
| **WP-R5** | the segment-by-segment save, a new part on an init change, the size first | client, built ([as built](#wp-r4-and-wp-r5-as-built)) |
| **WP-R6** | the texts (below) and `LIVE_RULES_VERSION` 3; the switch went `on` on both estates first, by the owner's decision | built ([as built](#wp-r6-as-built-the-texts)); the readings owed |

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
  refusal and an expired replay are the same `404 LIVE_NOT_FOUND`. **`?moderation=true`** is the
  MODERATION READ (owner, 2026-11-15): whoever moderates the replay's post (`mayReadToModeratePost`)
  reads it past that gate, logged - the rule of the post by id and its comments (*"Oui, dans ses
  espaces"*); anyone else gets the gate above
  ([moderation-and-blocking](moderation-and-blocking.md#the-moderation-read-of-a-post-its-comments-and-its-replay-owner-2026-11-15)).
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

**Owed on dev** (written as owed before any production release; WP-R3 shipped from `v1.6.9` on and the switch went on 2026-11-19 with none of them recorded, so they are owed now, [backlog](backlog.d/live-replays-kept-three-days-as-canareels.md)):

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

Sitting [S11](device-verification.md#the-phone-readings-of-2026-11-19-s11-171-alpha3-live-replays-on-dev), 2026-11-19, dev only, `1.7.1-alpha.3`. A reading still owed says what closes it.

1. **Bytes per hour by platform**: **read.** A 10-minute live: the Mi 9T 0.50 GB/h (a still, dark scene), the iPhone 12 0.87 GB/h, both under the 1.39 and 1.04 GB/h of the forecast above.
2. **A replay plays end to end** on both phones, across a background pause and a camera flip, and seeks: **FAILED**, the player stalls for good at the first flip or pause ([entry](backlog.d/replay-seek-decoupled-from-loading.md)). A continuous replay plays and seeks (Mi). **Owed again** once the entry ships: a flip-and-pause replay through both boundaries on both phones, and the iPhone on a continuous one.
3. **A saved replay plays** in the Android Gallery and in Photos, across a gap and as parts: **read.** Three parts on each phone, played in both; the Gallery's indexed length is wrong (filed in the entry above).
4. **Expiry on dev**: **read.** `expiresAt` set into the past by SQL; the 18:23:00 worker deleted the post (`[REEL_GC] due=2 deleted=2`) and the 18:23:30 sweep deleted its segment objects (`[LIVE_GC] ... deleted (38 segment object(s))`), the volume listing then holding only the live replay.
5. **A staff deletion** removes the replay and records NO strike (D7); a cut of the live records one: **read.**
6. **The audience**: an outsider, a blocked account (both ways) and a removed viewer each get `404`: **read**, on the replay route and on the post route.
7. **The backup**: after WP-R3, the next restic snapshot holds no replay byte (`restic ls latest` names
   no `live_segments` path, and `live/` is absent from Garage's listing): **owed.** The configuration was read (three paths, `live_segments` outside them); the snapshot of 2026-11-20 after 04:00 is the one to list, by an account that reaches restic.
8. **The cap on dev**: `LIVE_REPLAY_TOTAL_MAX_GB` set low, the oldest replay evicted, `[LIVE_REPLAY_CAP]` logged, the panel's line showing it: **owed.** Setting it needs the runner's identity on dev's `.env`.
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
- **Broadcaster texts (part of WP-R6):** the audience rule names the replay while the switch is on; the end confirm and the end screen read the server's facts, [below](#the-end-texts-say-the-servers-verdict) (superseding a first version that read the switch and a client clock).

**`LIVE_RULES_VERSION` stayed 2 until the texts shipped, and is 3 since WP-R6.** Version 3 is the broadcaster accepting a text that names the replay; raised while the switch was off, every broadcaster would have re-accepted a sheet promising a replay that does not happen. The plan was to raise it with the texts BEFORE the switch; the owner had the switch turned on first (2026-11-19, [decision 42](backlog.d/owner-decisions-of-2026-11-19.md)), so lives started between the flip and WP-R6 were kept as replays under a version 2 acceptance and the pre-live line that already named the replay.

Owed: the phone readings listed above (cover and time left on the card included).

## A replay seek: the latest target alone moves the playhead (owner, 2026-11-19)

Reported on a desktop browser: drag the bar, the player loads; drag again while it loads and the
playhead is thrown back to the earlier position ("il faut decorreler la lecture et le chargement").

**Root cause.** `ReplayPlayer.noteSeeking` queued one serial step per `seeking` event, and each step
ended by WRITING `video.currentTime` where ITS segment landed. A step for an older target still held
the queue (its fetch pending), so when it completed it moved the playhead to the old target; a seek
back into buffered media (which writes nothing itself) was simply overwritten.

**The rule.** The user's LATEST seek is the single source of truth; only it may write the playhead.

- Every seek takes a ticket `{id, signal}` (`seekId`, a counter - never a clock). A newer seek bumps
  `seekId` (monotonic, never reset) and aborts the older ticket's controller, so its in-flight fetch
  is cancelled rather than waited for, and its queued step returns at once. The seek's download has
  its OWN controller, aborted with the rest by `teardownMedia`: never `AbortSignal.any`, which iOS 16
  WKWebView lacks (pinned by a test that deletes it).
- After every `await` of a seek (page listing, fetch, decrypt, append) the ticket is compared with
  `seekId`; a stale one stops and logs. A cancelled stale fetch is not a failure (no retry, no
  "reconnecting"), and a dropped stale step or a seek into buffered media ends a "reconnecting"
  left by an older seek's retry.
- Known and pre-existing: a seek still queues behind ONE untracked step already running (a fill's
  segment download or a page listing), which is not cancelled by a seek.
- Appends never set `currentTime`; background fills only append. **The invariant: every playhead write
  of the replay player is a seek, and the newest seek wins.** The writers are three: the seek step's
  landing (`seekTo`, ticket-guarded), the seek step's landing on the edge of a hole (`noteSeeking`),
  and the hole crossing of `crossHole` (itself a seek, which the engine reports as `seeking` and a newer
  seek supersedes like any other). A position inside no buffered range is never written: every
  landing is checked against the ranges.
- Loading serves the target first: the seek step takes the segment holding the target, then `fill`
  continues from its cursor ahead of it.
- `LivePlayer` (the live edge) has no user seek: its only playhead write is `seekToEdge`, forward
  only, from its own state, so it shares none of this.

Pinned in `replayPlayer.test.ts` with deferred fetches (late answer, rapid repeated seeks, seek back
into buffered media, abort of the stale download). **Owed:** a reading on a desktop browser and on
both bench phones on dev (dragging the bar repeatedly while loading), listed in
[the backlog entry](backlog.d/replay-seek-decoupled-from-loading.md).

### Holes in the replay timeline: crossed by construction (S11, 2026-11-19)

A replay is NOT contiguous media. The live itself has holes: a camera flip (a new generation and init,
about 0.8 s on the bench) and a background pause (the broadcaster's app stopped sending, 17.6 s on the
bench) leave a forward gap between one segment's end and the next one's start. Read on the Mi 9T on a
live with both: buffered `[0,16.6] [17.4,27.6] [45.2,76.1]`; the playhead stopped 0.5 s before the first
hole and never moved, because `noteStall` took a stop inside a buffered range for the engine's own wait.
Every earlier fixture was contiguous, which is why no test saw it.

The design separates two things. **Where a segment sits in media time** is MEASURED when it is appended
(`placed` start, `placedEnd` end), kept for the whole session and never forgotten by a trim or an engine
eviction. **What the SourceBuffer holds now** is read from `buffered`. Holes come from the first, the lead
and eviction from the second.

The rule: **a hole is a fact of the segment list, never something detected by a stall.**
`knownHoles(segments, placed, placedEnd, skipped)` returns the gap between where a segment was measured to end and
where its list neighbour begins (and the leading gap before the first segment, above 0.05 s); a region
not loaded yet has no measure and is no hole, while a segment skipped for good is transparent (below). The leading gap is read from the first MEASURED segment when only skipped ones precede it. A range holding a single segment
between two holes is crossed on both sides. **A segment skipped for good (404, or one that does not open)
is transparent**: each measured segment is paired with the NEXT measured one, so the media the skipped
one would have held is a hole like any other, and the lead, the far-ahead trim, the crossing and the seek
landing all follow (a 404 inside the lead used to make the fill download the replay, and again on every
`timeupdate`). A region not loaded yet, neither measured nor skipped, breaks the pairing. A segment that
does not open is downloaded once more before it is skipped (a corrupted transfer). The player then:

- **counts its lead across the holes** (`mediaAhead`, leading gap included). A lead that stopped at the
  hole opened a new range and was never met: the fill downloaded the WHOLE replay (200 of 200 segments in
  the probe), which on iOS hits the quota. The far-ahead trim is measured the same way, in media seconds
  across holes, so the media right after an 80 s pause is not "far". Pinned by P1 (hole mid-lead) and P2
  (first segment at 0.4 s): about 12 s ahead, no more. The fill also never keeps its cursor past a
  segment the buffer no longer holds ahead of the playhead (`firstGapAhead`): it is fetched again;
- on `timeupdate`, a playhead at a hole's start jumps to the start of the media after it;
- on `waiting`, a playhead whose CURRENT range ends at a hole with at most `REPLAY_SEGMENT_LENGTH_S`
  (1.5 s) of media left does the same - the engine ran out of playable media there. With more left it is
  the engine's own wait and content still ahead is never skipped. The 0.5 s stop that sets the tail was
  read on the Mi 9T ONLY and never on iOS. That one constant is also the most a seek lands inside its
  segment;
- a seek whose target is INSIDE a hole lands on the next range's start; a seek past its segment's own
  end with the next segment not yet loaded takes that segment and lands on its start. `take` answers
  null both for a skipped segment and for one already buffered, so a TARGET or next segment already
  buffered is landed on from its measured place (the engine would otherwise hang in `seeking`).

A hole is `[from, to - tolerance)` and a range `[start - tolerance, end)` with ONE shared tolerance
(0.01 s), so a position is never both and the jump cannot repeat. THE RULE of a landing is: always write
a position inside a range - the segment after the hole, else the target segment's own start, else
nothing (logged) - never a position in no range, which hangs the engine's seek and blocks the crossing
(`video.seeking`). **A user seek is never left unanswered.** When the target's segment is skipped the landing walks
FORWARD to the first segment that gives media (listing the next page when the walk reaches the end of
the pages already listed), and BACK to the LAST EXISTING segment before the target when none does - never
an arbitrary range the buffer happens to hold; only a replay with no media at all logs an error and writes
nothing. Held and skipped segments are answered from what is known, never downloaded again. The second
download after an open failure goes through the same handling as the first: a stale seek or a 404 skips
that segment and never ends the replay.
`firstGapAhead` starts from the last measured segment only when its end reaches the playhead, else from
the playhead's own list position, so nothing is fetched behind it.

A hole whose far side the engine evicted is still a hole: the crossing lands there and
the engine's `seeking` fetches the media again.

No timer is involved. Pinned with synthetic buffers holding a 0.8 s and a 17.6 s hole in
`replayPlayer.test.ts`. Owed: the same reading on both phones with a live that flipped and paused.

## WP-R6 as built: the texts

Written 2026-11-19, after the switch went `on` on both estates (the owner's order, so no "switch off"
production state was left to keep the texts true for). Each text says what the product does, from
[the owner's decisions](#the-owners-decisions-of-2026-11-09): 3 days by default then deleted, never in
a backup (the segments), the last 3 hours at most, 30 s of live at least, the live's own audience and
no repost, saved like a CanaReel, the chat not replayed, the time left shown, a staff deletion with no
strike, the 20 GB total cap evicting the oldest.

| Text | What it says now |
| --- | --- |
| CGU `#directs`, the "Pas d'enregistrement" term | renamed **Rediffusion**; the "Coupure" term adds that an ended live can be cut while its replay exists (the cut deletes it) and that a staff deletion of the replay is no cut and no sanction. `updated` 19/11/2026 |
| Privacy section 2 "Directs", section 6 rows and its closing note on backups | the replay paragraph (what is kept, for whom, no repost, no push, no seat, the chat deleted at publication); the replay row (what it holds, when it goes, never in a backup); the live row (the chat goes at the end, the video stays with a replay); the backup paragraph (segments never backed up, WP-R3). `updated` 19/11/2026 |
| Register C19, C20 | the purpose and retention of a replay; a cut reaches an ended live while its row is kept; D7 |
| Pre-live screen | `live_rule_audience_*_replay`: the time left, the last 3 hours, no repost, saved like a CanaReel, the chat not replayed |
| First-live rules | `LIVE_RULES_VERSION` **3** |

**How the texts read while the switch is off.** The broadcaster's screen reads the switch: the
`_replay` strings show only while `serverLiveReplaysMode()` is `on` (`replaysAvailable`, and
`replayFollows` for the end texts), and the plain `live_rule_audience_member` /
`_association` ("Rien n'en est gardé après la fin") are the OFF texts - true when off, so they are
unchanged. The legal pages are static text and the repository's precedent for a runtime switch on
them is a sentence true in both states, not a text that changes with a fetch (the lives paragraphs
carry "quand la fonction est ouverte"; an offline page would otherwise show a different contract): they
describe the replay as the product does today, and say that if the Editor turns replays off, a live
started after that is not recorded. The privacy page's durations stay the server's values (section 6).

**What version 3 costs.** `LIVE_RULES_VERSION` is read only at a live's START (`assertRulesAccepted`):
a broadcaster whose acceptance is below 3 sees the rules sheet on the pre-live screen once more and
taps Accept, which the start records; nobody else is asked anything. The client reads the version
from the server (`/api/lives/limits`, `/rules`), so no build carries it.

**What the legal edit does not do.** Canari has no terms version a member accepts: the CGU and the
policy carry their `updated` date and nothing else, so this edit asks no member to re-accept anything.
The one terms version that IS accepted, MiConnect's `cgu_version`, belongs to `/legal/miconnect`
([authentik](infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16)),
which this edit does not touch.
CGU section 14 and privacy section 12 both promise a notice 15 days before a substantial change
takes effect; no code sends such a notice, and none was sent for the replays (the switch went on
first, by the owner's order). **Owner's decision, 2026-11-19: handled by the owner, outside the app**
(*"Je m'en occupe"*) - he writes the text and picks the channel; nothing is built for it.

### The end texts say the server's verdict

Review of #3856: a 30 s check on the client's clock (counted from the start's answer) and the
server's (`lastSegmentAt - startedAt` on the database clock, the last flush included) disagree near
30 s, so the screen could say "Rien n'en est gardé" over a published replay, or the reverse. Now ONE
value, the server's:

- **Every end writes it, and the column has ONE meaning on an ended row: the final verdict.** The
  broadcaster's `POST /api/lives/:id/end` and the sweep's `endDue` set
  `keepsReplay = keepsReplay AND <30 s rule>` in their own `UPDATE` (one SQL fragment,
  `replayLongEnoughSql`, that `publishReplay` reads too); a cut and an erasure write it `false` in
  their own transaction. The end answers it as `keepsReplay`, and a repeated end READS the column.
  The ingest already refused any segment after the end; writing the verdict only makes the answer
  self-contained. A cut or an erasure after the answer still removes the replay (the texts do not
  promise past them). **Rows ended before this deploy keep their start-time value**: for the few
  minutes until they are purged, a repeated end on such a row can answer "kept" for a live under
  30 s; nothing is published wrongly, since `publishReplay` still applies the 30 s rule and the cut.
- **The client freezes the first answer** (`LiveBroadcast.replayVerdict`) and the end screen reads
  `replayEndText(keepsReplay, verdict)`: `none` for a live the server does not keep or judged short,
  `kept` (how long it is visible) once the answer says so (a `404`, a purged row, is `none`: a
  replay keeps its live row), and while no answer has come - the
  screen settles behind no request - the rule itself ("S'il a duré au moins 30 secondes, sa
  rediffusion sera publiée").
- **The confirm, asked before the end, states the rule** for a live the server keeps, never a
  promise: "s'il a duré au moins 30 secondes, sa rediffusion reste visible {days}".


## A replay reaches its end: the engine's state is the memory of "ended" (2026-11-19)

**Symptom (S12, desktop Chrome):** a replay played from 0 halted about 0.12 s before its last frame
(`readyState` 2, `ended` false, a spinner for good, `loop` never looping) although the log said
`end of stream declared`.

**Hypothesis refuted by measurement.** The reader's guess was two tracks ending 20 ms apart. It was
measured with a real `MediaRecorder` (`video/mp4;codecs=avc1.42E01F,mp4a.40.2`, 15 fps, 2 s timeslice)
fed to the real `ReplayPlayer` in desktop Chrome, and with ffmpeg files whose audio ends 30 ms after the
video: audio and video ends differ by 15-30 ms in every case, and Chrome extends `buffered` to the
`duration` once the source is ended, so a replay played to its end with the end declared plays on and
fires `ended` in every one of them.

**Cause.** `source.readyState` read `open` at the halt. The specification reopens an ended
`MediaSource` on ANY `appendBuffer` or `remove` on its buffer; an open source waits for more data. The
fill declares the end when the last segment is in, then the playhead moves on and `trim` removes what lies
more than 10 s behind it: `remove(0, 10.17)` with `readyState` `ended` is the line that reopened it
(logged in the page). The player had kept a flag `ended` to say it was done, and the flag stayed true.

**Fix.** The flag is gone. The engine's `readyState` is the only memory of the end: `declareEnd` runs at
every arrival at the end of the list (after each trim and fill) and calls `endOfStream()` whenever the
source is `open` - idempotent through the engine's state, never through ours, so a trim or a refill of a
gap that reopens it is followed by a new declaration in the same step. No timer, no seek to the end when
stuck. Test: the fake buffer reopens an ended source on `remove`/`append`
(`keeps the stream ended when the trim behind the playhead reopened it`).

**The seek landing (S12's second question).** A seek lands INSIDE the segment its target falls in, at
the measured start of that segment plus the share of it the target is past, capped at the segment length
(`REPLAY_SEGMENT_LENGTH_S`): by design never a keyframe snap forward. What can still land later than the
target is the segment LOOKUP: `segmentPositionAt` reads the segments' arrival time `atMs`, while the bar's
time is media time, which runs ahead of arrival time on a replay whose media is longer than its live
(61 s of media for 54 s). Read from the code, not measured on a real replay; owed a reading on the
S12 replays.
