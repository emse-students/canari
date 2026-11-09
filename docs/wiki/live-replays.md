# Live replays - a finished live kept three days as a CanaReel (design, 2026-11-09, NOT BUILT)

The owner's decisions of 2026-11-07 ([backlog entry](backlog.d/live-replays-kept-three-days-as-canareels.md)):
a finished live is kept and watchable for **3 days**, then deleted; it appears **as a CanaReel in
the feeds and the CanaReels tab**, to **the audience that could see the live**; it is downloadable
**like a reel**; **the chat is not replayed**; a live **cut by moderation or ended by an erasure
never becomes one** (lead decision). The owner also asked for **a review of what a CanaReel is**
(retention, and perhaps showing the time left before deletion). This page is that design, measured
on 2026-11-09. Nothing on it is built. The owner's open questions are
[at the end](#the-owners-questions-in-french-four-at-a-time).

What it reverses: L3 and Q10 ("no replay", deletion at the end) and the 20-segment trim of
2026-10-31 in [lives](services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3).

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

A segment is 2.04 s and 513 kB on average. These are the only lives in the current container log
(from the deploy of 2026-11-08 evening to 2026-11-09 evening); **no durable record of past lives
exists** (a live's row is deleted at its end, `live_starts` after an hour), so lives per day is not
measurable from production today - [WP-R1](#wp-r1---the-schema-and-the-switch-plain-migrations)
adds the count.

**The WP-L1 bench** ([live](frontend/modules/live.md#wp-l1---measured-2026-10-19)): an Android
broadcaster sends **3.08 Mb/s = 1.39 GB/h**, an iPhone **2.32 Mb/s = 1.04 GB/h**. The seal adds 28
bytes and each self-contained segment repeats its ~1.2 kB init: 0.2 %, ignored below.

**So a replay costs 0.9 to 1.4 GB per hour of live**: 0.9 is what production stores, 1.4 the
Android bench, the planning ceiling.

### What three days hold, at realistic usage

The standing footprint is three days of lives (plus at most one hour of the expiry worker and one
30 s live sweep, [section 3](#3-retention-the-three-days-are-durable-state)):

| Scenario | Lives a day x length | Hours a day | Stored a day | **Standing (3 days)** |
| --- | --- | ---: | ---: | ---: |
| S0 - the day measured | 4 lives, 37 min in all | 0.6 | 0.56 GB | **1.7 GB** |
| S1 - ordinary | 4 x 30 min | 2 | 1.8-2.8 GB | **5.4-8.3 GB** |
| S2 - an event week | 10 x 45 min | 7.5 | 6.8-10.4 GB | **20-31 GB** |
| S3 - a phone forgotten on air | 1 x 10 h (no live has a longest duration since 2026-10-31) | 10 | 9-14 GB | **9-14 GB for ONE replay** |

**Against the disk.** A read-only reading of the shared host on 2026-11-09 (figures in the
operators' private notes): the root filesystem is **36 % used**, and its headroom before the 75 %
threshold the host's image-prune rule reads is **about 44 GB**; production's whole media store is
under 1 GB today. S0 and S1 fit easily. **S2 takes half to two thirds of the headroom, and S3 shows
why a byte bound per replay is owed whatever the rest decides**: one forgotten phone is a fifth of
the headroom. The dev estate shares the disk and stores its replays the same way (tests only).

### The backup is the number that decides (finding of this design)

The media store is backed up nightly by restic (`backup-objects.sh`: the Garage volumes, **14
daily, 8 weekly, 6 monthly** snapshots, [backup](infrastructure/backup.md)) into a repository **on
the same disk**, mirrored offsite. Garage keeps an object as content-addressed blocks under its data
directory, not under the object's key, so **the backup cannot leave out the `live/` prefix**: every
replay present at 04:00 enters a snapshot.

A snapshot holds the replays alive that night (3 days' worth, `3D` for `D` stored a day). The
retained union is about: the 14 dailies (replays of the last 17 days, `17D`) + the 6 weeklies
beyond them (`6 x 3D`) + about 4 monthlies beyond those (`4 x 3D`), **about 47 days' worth of
replay**:

| Scenario | Backup repository growth from replays |
| --- | ---: |
| S0 | ~26 GB |
| S1 | ~85-130 GB |

**S1 does not fit beside the 44 GB headroom.** And a replay promised "deleted after 3 days" would
survive up to six months in a backup (the register already says so of every media,
[register section 7](compliance/register-of-processing.md#7-cross-cutting-hosting-backups-logs)).
**Recommendation: replays stay OUT of the backup** - a three-day item lost in a disaster loses
nothing anybody was promised - by giving the live segments a store of their own
([WP-R3](#wp-r3---the-segments-leave-the-backup-infrastructure)). The owner's question 2.

**Egress.** A replay viewer pulls what a live viewer pulls (~2-3 Mb/s), through the same nginx
segment location (per-address limits, the `live_segments` cache), but takes NO seat: replays are
uncapped like reels, so many replay viewers can crowd a live's 24 seats out of the uplink. Owed a
reading once replays exist ([readings](#the-readings-owed)).

## 2. How the segments are kept, and how they become one reel object

### Today

The broadcaster's phone seals each ~2 s segment (AES-256-GCM under the live key, AAD = label + live
id + index, [seal v1](frontend/modules/live.md#the-segment-seal-format-v1)); each segment is
**self-contained** (the recorder's init `ftyp`+`moov` then ONE fragment `moof`+`mdat`,
[why](frontend/modules/live.md#every-segment-is-self-contained)). media-service stores it in Garage
under `live/<liveId>/<random uuid>`; `live_segments` keeps `(liveId, index, name, bytes, sha256,
createdAt)`. After each confirmed segment `LivesService.trim` deletes the objects and rows older than
the newest 20; at the end `purgeEnded` deletes the whole prefix, proves it empty by a second listing,
then deletes the row ([lives](services/lives.md#what-one-broadcaster-may-store)).

### The three ways to make a reel object, compared

| | A - one MP4 concatenated at the end | B - re-sealed as a `segmented-v1` reel blob | **C - the live's own segments, served as a replay (CHOSEN)** |
| --- | --- | --- | --- |
| Who does the work | the server (decrypt, drop repeated inits, re-mux, re-seal) or the broadcaster's phone (re-upload) | a client: download, open, re-seal under a new CEK, upload | nobody: the bytes already stored stay |
| Bytes written again | the whole live (1 h = 0.9-1.4 GB), a second copy during the work | the whole live | **none** |
| Fits the reel pipeline | **no**: one blob is capped at 50 MB of ciphertext (`MEDIA_MAX_SIZE_MB`) = **~3.5 minutes** of live at the measured rate | no, same cap | n/a - the live path has no total cap |
| Rules it breaks | C3 ("the server only stores"; a server re-mux decrypts every byte) | a 1.4 GB upload from a phone, after the fact, for a live that may have ended by a dropped connection | none |
| Valid file? | a byte concatenation of self-contained segments repeats `moov` (not one valid MP4); a re-mux must handle a changed init (a camera re-acquired) and the background gaps | yes | the viewer already plays exactly these bytes |
| Reuses | the reel worker | the reel player and worker | **the seal and its index binding, the key at rest and its one reader, the segment store, the nginx segment cache, the purge and its empty-listing proof, the MSE player, the post row (comments, reactions, reports, feed)** |

**C is chosen**: it writes nothing again, breaks no rule, and its pieces are proven ones. The
property built so a viewer can JOIN at any index - every segment self-contained - is exactly what
a SEEK needs. The reel's `segmented-v1` path is not reused for PLAYBACK because it is one blob
under one CEK with ranged reads; the live's segments are already independent objects, each fetched,
opened and discarded on its own.

### C in detail

1. **The trim keeps the replay, bounded in bytes.** For a live that keeps a replay
   (`lives."keepsReplay"`, fixed at the start, [WP-R1](#wp-r1---the-schema-and-the-switch-plain-migrations)),
   `trim` deletes the OLDEST segments while `storedBytes` exceeds `LIVE_REPLAY_MAX_BYTES`, never
   the newest 20; everything else of the trim is unchanged (media delete first, then the rows and
   `storedBytes` in one transaction, idempotent from durable state). Proposed bound: **3 hours at
   the planning ceiling, 4.2 GB** (owner's question 1): what one live stores becomes at most that,
   whatever its duration, and a 10-hour live keeps its last three hours. A live with
   `keepsReplay = false` keeps today's 20.
2. **The end creates the replay, in the sweep, idempotently.** `purgeEnded`, for an ended live with
   `keepsReplay`, no `live_cuts` row, a broadcaster that is not `DELETED_ACCOUNT`, its drain over
   (the same seat rule as today) and at least `LIVE_REPLAY_MIN_MS` of media (owner's question 4),
   inserts the replay POST instead of purging: `kind = 'replay'`, `"liveId"`, author and association
   from the live, `publishedAt = endedAt`, `"expiresAt" = endedAt + 3 days` (database clock),
   `"durationMs"` from the first and last kept segment, the live's title as caption. **A UNIQUE
   partial index on `posts."liveId"`** makes the insert idempotent (`ON CONFLICT DO NOTHING`): two
   replicas, a crash, a retry - one replay. In the SAME transaction the live's chat rows and
   reaction bursts are deleted (**the chat stays ephemeral**; a reported line is in its own table
   and stays under its own rule) and its arrival keys are deleted after the commit, as at a purge.
3. **The purge waits for the replay post, and nothing else.** An ended live whose replay post
   EXISTS is kept (a `debug` line, no clock); once the post is gone - expired and deleted by the
   worker, deleted by its author or staff - the next 30 s sweep purges the live exactly as today
   (delete the prefix, list it again, delete the row only on an empty listing). A cut or an erasure
   purges at once AND deletes the replay post first, through the same per-post deletion the reel
   worker uses (below), whatever the post's expiry.
4. **The replay is read through ONE new route**, `GET /api/lives/:id/replay?from=<index>`:
   `{ liveId, postId, key, durationMs, expiresAt, segments: [{ index, name, bytes, atMs }], nextFrom }`,
   200 segments a page, `no-store`, **no seat**. `key` comes from `openLiveKey` (the one reader of
   the key at rest); `atMs` is `createdAt - first createdAt` on the database clock, the seek map
   (the media time stays the fragments' own `tfdt`, the player's truth). It answers `404
   LIVE_NOT_FOUND` to anyone the replay post is not visible to, a block either way, a viewer the
   broadcaster removed, and once `expiresAt` has passed - the same 404 an outsider gets, asked
   before anything else.
5. **The segment fetch is unchanged**: `GET /api/media/public/live/<liveId>/<name>`, token-free,
   ciphertext, answered by nginx's `live_segments` cache. The protection is the same as a live's:
   the key and the names are served only to the audience.
6. **The player gains a replay mode** (`livePlayer.ts`, its API injected): it starts at index 0,
   appends in order, keeps a bounded buffer ahead and removes what is behind (the MSE quota on iOS),
   and seeks by taking the last segment whose `atMs` is at or before the target, appending ITS init
   and fragments - the join logic, at any index. The existing gap seek covers a background pause
   inside the live, and the init comparison covers a camera re-acquired.
7. **Download, like a reel.** The rail's save, for every viewer of the replay, builds ONE
   fragmented MP4 on the device: the first init, then every fragment, written segment by segment
   into the gallery staging (`reels/gallery.ts`, 768 KiB chunks, offset-checked) - never the whole
   replay in memory. When a segment's init DIFFERS from the one written (a rotation, a lens), the
   file is closed and a second part starts (`canari-replay-<day>-<id8>-2.mp4`): two `moov` in one
   file is not a valid MP4. The size is said before the save (20 minutes is ~300 MB). Whether a
   native player crosses a background GAP in the `tfdt` timeline is not known: a reading.

## 3. Retention: the three days are durable state

**One column, one predicate, two existing sweeps, no timer.**

- **`posts."expiresAt"`**, written ONCE at the replay's creation (`endedAt + 3 days`), exactly as a
  reel's (`createdAt + 30 days`). The CHECK `posts_kind_shape` gains the `replay` shape (`durationMs`,
  `expiresAt` and `liveId` all present).
- **Every read already excludes an expired reel**; the clause `posts.kind <> 'reel' OR "expiresAt" >
  NOW()` becomes `"expiresAt" IS NULL OR "expiresAt" > NOW()`, which covers every kind that expires.
  An expired replay is never served, whether the worker reached it or not; the replay route asks the
  same.
- **`ReelRetentionScheduler`** (hourly, [reels (server)](services/reels.md#the-worker-reelretentionscheduler-social-service))
  selects `"expiresAt" <= NOW()` instead of `kind = 'reel' AND ...` (the partial index follows the
  predicate), and its per-row step is unchanged: purge the blobs (a replay has none of its own -
  only its comments' media, by the commenter's ownership), then delete the row and its
  `post_notifications` only if no blob failed. **The replay's segments are NOT its blobs**: the post
  row's deletion is what lets the live sweep purge them, with its own proof (section 2, step 3).
- **Worst case**: a replay is gone **3 days + 1 hour + 30 s** after its live ended; its bytes leave
  Garage at the same moment. Observed by `[REEL_GC]` (the replays counted apart) and `[LIVE_GC]`
  (`kept=` grows by the replays waiting; a new `replays=` field), and a `replayCount` /
  `replayBytes` line on the admin storage panel - **a count that does not follow the lives of the
  last three days is the sweep stopped.**

**What goes with a replay when it is deleted**, the reel's rule unchanged: its comments and
reactions (columns of the row) and its comments' media; its notifications; a link to it shared in a
conversation then shows "unavailable", as for any deleted post; a copy a member SAVED to their
gallery stays theirs, as with a reel. A pending report on it is left pointing at a post that no
longer exists, as for a reel. **Reposts and republications of a replay are refused at creation**
(the owner's question 7), so none can outlive or widen it.

**Who may delete it earlier**: whoever may delete the post (`DELETE /api/posts/:id`: the
broadcaster, a `POST_AS_ASSO` holder for an association's live, a moderator, an admin) - the live's
segments follow within 30 s. A staff CUT of the live, accepted while the live row exists (so during
the three days), deletes the replay at once and counts on the strike ladder as a cut of the live
(the owner's question 8).

## 4. Audience and visibility: exactly the live's

**The replay's audience is the live's** - `liveVisibleToUserSql` and the post rule are built from
the same fragments ([lives](services/lives.md#who-may-watch-the-rule-of-a-post)): the broadcaster;
a member's live: a reader sharing a space with them or their ACCEPTED follower; an association's
live: a reader who sees that association (member, its rules, or a nominative read grant). The post
rule has three doors the live rule lacks, and the replay closes each:

| Door of the post rule | On a replay |
| --- | --- |
| Member repost (WP-F6) | refused at creation, like a live (owner's question 7) |
| Republication by another entity / a personal carrier | refused at creation |
| "Entre étudiants" (`studentsOnly`) | the live has no such switch today, so the replay is created with it OFF: it has exactly the live's audience (owner's question 6) |

On top of the post rule, the replay route and every feed read apply what the live applied:

- **A block, either way**, hides the replay (the feed's blocked-author filter, the route's 404).
- **A viewer the broadcaster REMOVED from the live** does not see the replay: `live_removed_viewers`
  rows stay with the live row (they cascade at its purge) and the replay's reads add `NOT EXISTS`
  on them (lead decision: a removal was the broadcaster's statement about that person, and a replay
  served to them would undo it).
- **A named reader whose "voit les commentaires" is off** watches the replay and sees no comments,
  the comments rule unchanged; there is no chat to withhold (it is not replayed).
- **An association that is archived** keeps its replays until they expire (lead decision; the live
  was legitimate when broadcast).
- **No push**: the live already announced itself once; a replay appearing is not news (lead
  decision).
- **Older clients never receive a replay.** The feed and the CanaReels list include `kind =
  'replay'` only when the client sends `withReplays=true` - the precedent of `singleMedia`,
  `multiMedia` and `withLinks`, so a build that cannot draw one never draws it wrong, and a server
  that does not know the parameter strips it.

## 5. What a CanaReel is: the audit, and a proposed model

### Every kind of item the CanaReels tab shows (read on `origin/main`, 2026-11-09)

The list is `GET /api/posts?kind=reel&multiMedia=true&withLinks=true` (`reels/allReels.ts`), drawn
by `fullScreenPageOf` (`reels/fullScreenPost.ts`):

| Item | How it gets in | Kept | Where the rule lives |
| --- | --- | --- | --- |
| **Reel** - filmed with the Canari camera, 90 s at most | `kind = 'reel'` | **30 days from publication**, then the post, its comments and reactions | `REEL_RETENTION_DAYS` (`posts/reel.constants.ts`), each row's `expiresAt`, `ReelRetentionScheduler`; the file in media class `reel` ([reels (server)](services/reels.md)) |
| **One picture** (a feed post of exactly one photo) | `SINGLE_PHOTO_POST_SQL` | **as long as the post** - never expires | the feed's media class `archive`, never swept ([storage-forecast 6b](infrastructure/storage-forecast.md#6b-reopened-and-moved-2026-09-23-90-days-and-the-feed-leaves-the-clock-entirely)) |
| **One video not filmed with the Canari camera** | `SINGLE_MEDIA_POST_SQL` | as long as the post | same |
| **A carousel**, 2 to 10 pictures and videos | `MULTI_MEDIA_POST_SQL` | as long as the post | same |
| Any of the three above **with a link in the text** | `LINKED_MEDIA_POST_SQL` (`withLinks`) | as long as the post | same |
| **A repost** of any of these (WP-F6) | the same row, reaching the reposter's followers | the ORIGINAL's rule | the original row |

Not in the tab, for completeness: a **reel sent in a conversation** (kept while a chat hold on the
file lasts, [media-service holds](services/media-service.md#holds-one-file-for-the-feed-and-the-chats-rc-14-2026-11-01));
an **open live** (its card in the feed, deleted at the end today).

**What the audit shows.** "CanaReel" names two different things the screen does not tell apart: an
**ephemeral** item born in the Canari camera (30 days), and a **permanent** feed post that happens
to have a full-screen shape. Two visually identical pages - a camera reel and a gallery video - have
lifetimes of one month and for ever, and nothing on screen says which. The rule of each lives in a
different place (a constant and a column; a media class).

### Proposed model

1. **A CanaReel is any post the viewer can draw full screen** - the definition the code already
   has (`fullScreenPageOf`); the tab is a WAY OF READING the feed, not a kind of content.
2. **Expiry is a property of an item's ORIGIN, held in ONE column**: `posts."expiresAt"`, set once
   at creation, NULL for a permanent post. Two origins expire: the **camera** (30 days) and the
   **live** (3 days). One predicate in every read (`"expiresAt" IS NULL OR "expiresAt" > NOW()`), one
   worker (`"expiresAt" <= NOW()`), whatever the kind - adding the replay costs no new mechanism, and
   any future ephemeral kind none either.
3. **Showing the time left** (the owner's "à voir"): the chip was removed on 2026-10-02 as "pas
   discret". The recommendation is to show it **where it is news: on a replay only** ("Rediffusion
   - encore 2 j", from `expiresAt` and the server's `serverNow`, never the phone's clock), and keep
   the age on a reel, whose month nobody is surprised by. The owner's question 3.
4. **A replay looks like a reel and says what it is**: the live's last preview image as its cover
   (kept until the purge, opened by the derived poster key), a "Rediffusion" mark, its duration,
   the title as caption. In the feed the card shows the cover and plays nothing inline (a replay is
   minutes long); a tap opens the CanaReels viewer on it.

## 6. Migrations, work packages, readings

### Migrations (numbered after `origin/main` of 2026-11-09: social-service ends at `153`, core-service at `020`; take the next free number at build time)

| File | What | Held? |
| --- | --- | --- |
| core-service `021_platform_config_live_replays_mode.sql` | `live_replays_mode varchar(16) NOT NULL DEFAULT 'off'` on `platform_config`, the calls/lives pattern; fail closed | plain (additive) |
| social-service `154_live_replays.sql` | `lives."keepsReplay" boolean NOT NULL DEFAULT false` (fixed at the start from the switch: a flip mid-live never makes half a replay); `posts."liveId" uuid NULL REFERENCES lives(id)` (no cascade: the purge deletes the post first, and a live deleted under its replay is an error, not a silent loss); a UNIQUE index on `"liveId"` `WHERE "liveId" IS NOT NULL`; `posts_kind_shape` re-created with the `replay` shape (`DROP CONSTRAINT` + `ADD`); the expiry index re-created on `WHERE "expiresAt" IS NOT NULL` (`DROP INDEX <name>` + `CREATE`) | **plain** - every statement is on the allowlist of `migration-hold.sh`. The CHECK validates `posts` under the migrations' lock timeout; the author may still mark it held for that lock, and the table is small |
| (only if the owner says yes to question 6) `lives."studentsOnly"` | the switch on an association's live, copied onto its replay | plain |

**No held migration**: nothing is dropped, renamed or deleted, and no backfill runs.

### The work packages, in order (one pull request each)

#### WP-R1 - the schema and the switch (plain migrations)

The two migrations; `live_replays_mode` read like `lives_mode` (`GET /api/version` carries it;
`/admin/platform` moves it); `keepsReplay` written at the start; the `[LIVE]` start and end lines
gain the live's duration and bytes, so lives per day and their length become measurable on
production BEFORE anything is kept. Proof: the migrations applied twice on a real PostgreSQL, the
CHECK refusing a replay stated in pieces.

#### WP-R2 - keeping, creating, expiring (server)

The byte-bounded trim; the replay creation in `purgeEnded` (idempotent on the unique index), the
chat deleted at the end; the purge waiting for the post; a cut or an erasure deleting the post then
purging; the replay route; `withReplays` on the feed and the CanaReels list; the read clause and the
worker generalised to `expiresAt`; reposts and republications of a replay refused; the storage
panel's `replayCount` / `replayBytes`. Proof: `lives.integration.spec.ts` and
`reel-retention.integration.spec.ts` on a real PostgreSQL - a replay created once by two sweeps, a
cut live and an erased broadcaster leaving none, a 404 for an outsider, a block, a removed viewer and
an expired replay, the live purged only after the post, `expiresAt` moved by SQL (never a wall
clock).

#### WP-R3 - the segments leave the backup (infrastructure)

If the owner answers question 2 as recommended: a second Garage instance in Canari's own compose
(its own two volumes, NOT in `backup-objects.sh`), media-service's live-segment store pointed at it
by its own endpoint and bucket variables; `MIGRATION.md`, the env manifest, the storage panel and
[backup](infrastructure/backup.md) updated. No host install: it is one more container of the
estate. **It must ship before the switch is flipped**, and it also takes today's in-progress lives
out of the nightly snapshot.

#### WP-R4 - watching a replay (client)

The replay mode of `livePlayer`, the replay page in `fullScreenPageOf` and its feed card (cover,
"Rediffusion", duration, time left per question 3), the broadcaster's end screen ("Rediffusion
visible 3 jours"), the pre-live sheet saying the live is kept, and **the first-live rules raised
to version 3** (`LIVE_RULES_VERSION`): every broadcaster accepted rules that said "no replay", so
each re-accepts the new ones before their next live. Strings in Paraglide.

#### WP-R5 - saving a replay (client)

The segment-by-segment MP4 writer, its parts on an init change, the size before the save, the
gallery staging reused.

#### WP-R6 - the texts, then the flip

The register C19 (the 3 days, the post row, the chat deleted at the end, no backup if WP-R3), the
privacy page and `/legal/cgu#directs` ("supprimé peu après sa fin" becomes "gardé 3 jours en
rediffusion pour le même public, la discussion non conservée"), then `live_replays_mode = on` on
dev, the readings, then production.

### The readings owed

1. **Bytes per hour by platform**: one 10-minute live from the Mi 9T and one from the iPhone 12,
   `storedBytes` read at the end, against the 0.9-1.4 GB/h above.
2. **A replay plays end to end** on both phones, including a background pause inside the live (a
   gap) and a camera flip (a new init), and a seek to the middle and back.
3. **A saved replay plays** in the Android Gallery and in Photos - across a gap, and as two parts
   after a flip.
4. **Expiry**: on dev, a replay's `expiresAt` moved into the past by SQL is gone within an hour and
   30 s, its Garage prefix listed empty, `[REEL_GC]` and `[LIVE_GC]` saying so.
5. **A cut during the three days** removes the replay at once and records a strike.
6. **The audience**: an account sharing no space and not following, a blocked one and a removed
   viewer each get `404` on the replay route.
7. **The backup**: after WP-R3, the next restic snapshot holds no replay byte (the repository's
   growth that night against the replays stored that day).
8. **The first week in production**: `replayBytes` on the panel against this page's scenarios, and
   the egress during a replay watched by several members while a live is on air.

## The owner's questions (in French, four at a time)

Each has the recommended option first. Plain words; the details are in the sections above.

**Lot 1**

1. **Un direct très long (téléphone oublié, soirée entière) : que garde la rediffusion ?**
   - *(Recommandé)* Les 3 dernières heures au plus (environ 4 Go) : un direct de 10 h garde sa fin.
   - Tout le direct, quelle que soit sa durée (un direct de 10 h prend 9 à 14 Go à lui seul).
   - La première heure seulement.
2. **Les rediffusions doivent-elles entrer dans les sauvegardes du serveur ?**
   - *(Recommandé)* Non : elles ne sont jamais sauvegardées. Une panne grave les perdrait, mais
     elles n'existent que 3 jours, et rien n'en reste ensuite nulle part.
   - Oui, comme les autres médias : elles resteraient jusqu'à 6 mois dans les sauvegardes, et
     celles-ci grossiraient d'environ 85 à 130 Go dans un usage ordinaire, plus que la place libre.
3. **Afficher le temps restant avant suppression ?**
   - *(Recommandé)* Sur les rediffusions seulement (« encore 2 j ») ; les CanaReels gardent leur âge.
   - Sur les rediffusions et sur les CanaReels filmés (« encore 12 j »).
   - Nulle part, comme aujourd'hui.
4. **Un direct très court devient-il une rediffusion ?**
   - *(Recommandé)* Seulement s'il a duré au moins 30 secondes (un faux départ ne s'affiche pas).
   - Toujours, dès qu'une image a été envoyée.

**Lot 2**

5. **Si les rediffusions de tous les directs dépassent ensemble une limite de place (par exemple 20 Go) :**
   - *(Recommandé)* La plus ancienne est supprimée plus tôt que prévu, et c'est signalé aux admins.
   - Les nouveaux directs ne sont plus gardés tant que la place n'est pas revenue.
   - Pas de limite totale.
6. **L'interrupteur « Entre étudiants » pour les directs d'association :**
   - *(Recommandé)* Pas maintenant : la rediffusion a exactement le public du direct.
   - L'ajouter au lancement d'un direct d'association, et la rediffusion le reprend.
7. **Un membre peut-il republier une rediffusion chez ses abonnés ?**
   - *(Recommandé)* Non, comme un direct : le public ne s'élargit jamais.
   - Oui, comme un CanaReel.
8. **Quand la modération retire une rediffusion pendant ses 3 jours :**
   - *(Recommandé)* Cela compte comme une coupure du direct (avertissement, suspension au 2e).
   - Simple suppression, sans avertissement.

**Decided by the lead on the way, reversible** (written here, not asked): the replay is published
at the live's END and expires 3 days after it; it sends no push; the chat is deleted at the end;
a viewer the broadcaster removed does not see it; an archived association keeps its replays until
they expire; the feed card does not play inline; any member who may see a replay may save it.

## See also

[lives](services/lives.md) (the server half), [live](frontend/modules/live.md) (the client and the
seal), [reels (server)](services/reels.md) and [reels (client)](frontend/modules/reels.md),
[storage-forecast](infrastructure/storage-forecast.md), [backup](infrastructure/backup.md),
[register C19](compliance/register-of-processing.md), [engagement](engagement.md) (who a live
notifies).
