# Live replays - a finished live kept three days and shown as a CanaReel (design, 2026-11-07)

**State: DESIGNED, nothing built.** The owner's decisions of 2026-11-07 are verbatim in
[backlog](../../backlog.d/live-replays-kept-three-days-as-canareels.md): a finished live is kept and
watchable for **3 days**, then deleted; it is **always** kept, and *"il doit apparaitre comme un Reel
dans les feed et l'onglet CanaReel"*, to the audience that could see the live; a live cut by
moderation or ended by an erasure never becomes one (lead); download follows the rules of a Reel; the
live chat is not replayed. This page is the design: every claim below was read against the code at
`origin/main` `02b81c272`, and each section names the file it read.

What it reverses: L3 and Q10 - "no replay", the segments and the row deleted at the end
([lives](../../services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3)) - and the trim to
`LIVE_RETAINED_SEGMENTS` = 20 that bounds a live's storage to 80 MiB whatever its duration
([lives](../../services/lives.md#what-one-broadcaster-may-store)).

The design in one paragraph: **the live row and its stored segments stay after an eligible end, a
`posts` row of kind `live_replay` points at the live so the feed and the CanaReels list carry it with
their existing reactions, comments, reports and saves, the viewer plays it over a VOD list of the
stored ciphertext segments with the live key the replay route serves, and the existing live sweep
deletes everything at `replayExpiresAt` with the existing purge (prefix delete, listing proof, row
delete, the posts row going by cascade).** No transcoding, no re-encryption, no new media object.

## 1. Storage

### The bytes per hour

From the WP-L1 bench ([live](live.md#wp-l1---measured-2026-10-19), and the table in
[lives](../../services/lives.md#the-numbers-and-where-each-is-the-one-copy)):

| Broadcaster | Measured uplink | Per hour | Per live-hour kept 3 days |
| --- | --- | --- | --- |
| Android (Mi 9T, app WebView) | 3.08 Mb/s (`LIVE_PLANNING_VIEWER_BPS` rounds it to 3.1) | **1.39 GB** (1.29 GiB) | 1.39 GB held for 72 h after the end |
| iPhone 12 | 2.32 Mb/s | 1.04 GB | 1.04 GB |
| Planning target | 2.5 Mb/s | 1.13 GB | 1.13 GB |

The seal adds 28 bytes per segment and every segment repeats its ~1.2 kB init
([live](live.md#every-segment-is-self-contained)): 1800 segments an hour cost ~2.3 MB, 0.16 %. The
`live_segments` rows (~100 bytes each) are noise. **So: about 1.4 GB per broadcast hour, held for
three days after the live ends.**

What that means with no cap: lives have no longest duration (owner, 2026-10-31) and one account may
hold one live open at a time, so ONE account broadcasting without a break holds up to 72 h x 1.39 GB
= **~100 GB** of replays at the end of three days, and the total grows with the number of
broadcasters. Today the trim makes that 80 MiB per live; a replay must have a bound of its own.

### How to bound it - three places, one recommended

| Option | What it bounds | Mechanism | Cost |
| --- | --- | --- | --- |
| **A. Per account (recommended)** | the replay video one BROADCASTER (the person, also for a live in an association's name, as the strike ladder counts) holds at once: `LIVE_REPLAY_ACCOUNT_MAX_SEGMENTS`, 3600 segments = 2 h of video (2.8 GB Android) | (1) during a live, the existing trim ([lives](../../services/lives.md#what-one-broadcaster-may-store)) keeps the newest `LIVE_REPLAY_ACCOUNT_MAX_SEGMENTS` instead of 20, so a 5 h live keeps its last 2 h; (2) when a live becomes a replay, the account's OLDER replays are deleted whole, oldest first, until the account's retained segments fit - a durable `SUM(storedBytes)`/count over the account's replay rows, under the account's lives rows lock, never a clock | one constant, two uses of mechanisms that exist; never deletes another account's replay |
| B. Per replay only | one replay | the trim alone | an account starting a new live every 2 h still holds 36 of them |
| C. A total | the whole store | delete the oldest replay anywhere past a total | a destructive control on everyone's content driven by someone else's; needs the disk figure to set |

**Recommended: A, plus a total that REPORTS and deletes nothing** - the `[LIVE_GC]` line and the
admin storage panel carry `replayCount`, `replayBytes`, `replayOverdue` and `oldestOverdueMs` (the
reels panel's shape, [reels](../../services/reels.md#the-worker-reelretentionscheduler-social-service)),
and the panel's alarm compares `replayBytes` with the free space measured below. The figure is the
owner's (question R1).

**Which part is kept when a live outruns the cap - the newest.** That is what the trim already
does; keeping the FIRST 2 h would need a second mechanism (stop storing, but the viewers still need
the live edge). The replay of a 5 h live is its last 2 h, and its card says so by its duration.

### The one read-only measurement owed

**The free and total bytes of the filesystem that holds production's media store data, read once
with `df` by the lead under the read-only rule, the FIGURE written here (never the host, the path or
the mount).** The only disk figure in the repository is a code comment in
`apps/media-service/src/media/media.service.ts` (above `RETENTION_MS`): "the bucket held 66 MB
against 73 GB free", measured 2026-09-23 - before the estate moved
([estate-migration](../../infrastructure/estate-migration.md)), so it is not today's. Nothing touches
production or the shared host to build this design.

## 2. Becoming a reel

### What a live segment is, on Android and on iOS

Read from `frontend/src/lib/live/`:

- **The encoder is the engine's `MediaRecorder`** on both platforms (`liveRecorder.ts`): the Android
  app WebView (Chromium) and WKWebView on iOS, plus desktop Chrome/Edge from 126 for a screen
  broadcast. One container, `LIVE_RECORDER_MIME` = `video/mp4;codecs=avc1.42E01F,mp4a.40.2` (H.264
  Constrained Baseline + AAC-LC in **fragmented MP4**, `constants.ts`); an engine that cannot record
  exactly that cannot broadcast. 720p, 2.0 Mb/s asked, a timeslice and a keyframe every 2 s.
- **A stored segment is ONE init + ONE fragment** (`fmp4Segments.ts`, `composeSegment`): the
  recorder's `ftyp` + `moov` (~1.2 kB), then one `moof` + `mdat` (~600-800 kB, ~2 s). Android's first
  chunk is the init alone, iOS's is init + media; the splitter makes both the same.
- **A new recorder per camera acquisition** (a return from the background, a re-acquired lens): a
  new init, and media time restarting at zero - which `rebaseFragment` shifts by the time since the
  live started, so `tfdt` stays monotonic and a background is a GAP in the timeline.
- **Sealed** with AES-256-GCM under the live key, AAD = `canari-live-v1` + live id + index
  ([live](live.md#the-segment-seal-format-v1)): a segment opens only at its own index.

### Does a straight concatenation play as one file? Measured locally

A proof built 2026-11-07 with the repo's OWN `Fmp4Splitter`, `composeSegment`, `rebaseFragment` and
`initSegmentEnd` over three ffmpeg encodes with the live's profile (H.264 baseline level 3.1, AAC-LC
64 kb/s, 2 s keyframes, `frag_keyframe+empty_moov+default_base_moof`, so one fragment per keyframe as
the recorders produce), each fed to the splitter in 64 KiB chunks. Generation A: 6 s at 1280x720;
B: 4 s at 1280x720, rebased by 10 s (a 4 s background); C: 4 s at 720x1280 (another frame size),
rebased by 18 s. Judged by decoding each result to the end with ffmpeg 8.0.1 and `ffprobe
-count_frames`:

| Joined file | Inits | Result |
| --- | --- | --- |
| A + B, every segment end to end (init repeated 5 times) | identical (1271 B, byte-equal) | 300 frames, 0 decode errors, 14.02 s, the 4 s gap kept as a timestamp gap |
| A + B, an init only when it differs (the viewer's rule) | identical | the same: 300 frames, 0 errors |
| A + C, an init only when it differs | **different** | **725 decode errors**: every frame decoded at 1280x720, C's pictures read with A's SPS/PPS |

**The finding.** A replay is **one valid fragmented MP4 by plain byte concatenation - the first
init, then every fragment - as long as every init in it is the same**; repeating an identical init
did not trouble ffmpeg either, but a strict parser (Photos, MediaStore, ExoPlayer) is not asked to
accept it. **Where a new recorder wrote a DIFFERENT init, one file cannot hold both**: an MP4 has one
`moov`, the second is ignored, and the second generation's frames are decoded against the first's
parameter sets. MSE (the viewer) does not have that limit - it accepts a new init mid-stream, which
is what the live player already appends ([live](live.md#every-segment-is-self-contained)). **What
was NOT read**: real recorder output (whether two generations of one phone write byte-equal inits -
Chromium and WebKit may stamp a creation time, and a lens change may change the frame size), and any
player other than ffmpeg. Both are rows of WP-R0 below.

### What the reel pipeline expects, against a live's per-live key

A feed reel ([reels](../../services/reels.md)) is ONE media object: a client-made CEK, the file
sealed in `segmented-v1` (1 MiB AES-GCM segments, STREAM nonces, [media-streaming-upload](../../services/media-streaming-upload.md#31-the-format-is-the-one-already-shipped---only-the-writer-changes)),
uploaded with `retentionClass: 'reel'`, CLAIMED for its author, at most `MEDIA_MAX_SIZE_MB` (50 MB
in production, never above the 100 MB policy, `media.controller.ts`); the CEK and IV travel in the
post row's `media[0]`. A live is many objects under `live/<liveId>/`, each sealed under ONE live key
that the row keeps SEALED at rest and only `openLiveKey` opens
([lives](../../services/lives.md#the-live-key-at-rest)).

They do not meet without a cost: **an hour of replay is ~1.4 GB, 28 times the reel object cap**, and
turning segments into a `segmented-v1` object means decrypting them somewhere - the server (which
holds the live key, but the design forbids it plaintext media: "the backend sees opaque blobs") or
the broadcaster's client (which may have quit, and holds no copy of the hour).

### The smallest path: a VOD list over the stored ciphertext (recommended)

**Nothing is re-encoded, re-encrypted or re-uploaded.** The segments stay where the ingest put them,
under the live key, served by the same token-free, cached nginx route
([lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4)). A viewer allowed to
watch the replay is given the key and the LIST of segment names by social-service, and plays them
through MSE as the live viewer does, in VOD mode: no live edge, no seat, seeking allowed.

Concatenating at the end into one reel file is rejected: the size cap, the decryption, and the
different-init case above all stand against it, and it would double the bytes during the copy.

**The traps of the VOD path, each a line of the work packages:**

1. **The key stays sealed in `lives`, never copied into the post row** - a reel's CEK sits in
   `posts.media` in the clear; copying the live key there would undo migration 110. The replay route
   serves it through `openLiveKey`.
2. **The trim must not run past the cap** on an eligible live, and it runs on EVERY live today: the
   cap of section 1 becomes its retained count. A live ended while the replay switch is off keeps the
   20 of today.
3. **The seek index**: the server cannot read `tfdt` (ciphertext). The list gives each segment its
   `index` and `atMs` = `live_segments."createdAt" - lives."startedAt"` (the database clock), which is
   the scrubber's position; the player corrects it from the first `tfdt` it opens. A gap (a
   background) is a jump in `atMs` that the player seeks over, as the live player does.
4. **A replay may start past index 0** (trimmed by the cap): the player starts at the first listed
   segment's time, not zero.
5. **A different init mid-replay**: MSE takes it (append the init, then the fragment); the download
   cannot (section 5).
6. **The init-repeat economy**: the viewer appends an init only when it differs - unchanged.
7. **Egress**: a replay viewer is as heavy as a live viewer (3.1 Mb/s) and takes no seat, like a reel.
   The per-address bounds of the segment location stay (`limit_rate 750000`, `limit_conn` = the cap),
   which also makes a full DOWNLOAD of an hour slow (~30 min on one connection, section 5).
8. **The storage panel's "back to zero between lives"** stops being true: its live line splits into
   the running lives (still back to zero) and the replays (section 1's counters).
9. **The live key rotation note** ("keep the old secret until the last row of the old version is
   purged - an hour after its start") becomes three days after its END
   ([lives](../../services/lives.md#the-live-key-at-rest)).

## 3. Audience and moderation

### One predicate for who may see a replay

`replayVisibleToUserSql(live, user)` in `spaces/reader-spaces.ts`, built from
`liveVisibleToUserSql` (the rule of a post minus republication, plus the admin's cohort clause for one
live by id) AND:

- the replay is live: `lives."replayExpiresAt" > now()`;
- no `live_cuts` row for the live, and the broadcaster is not `DELETED_ACCOUNT` (the purge's own
  "removed" facts, `lives.service.ts` `purgeEnded`);
- the reader is not in `live_removed_viewers` - **the removal outlives the end for the replay's
  three days** (today it goes with the row at the end);
- no block either way (the feed's existing block filter; the replay route asks it as `assertMayWatch`
  does).

**It gates the four paths together**, as the live rule does: the feed and CanaReels arm of
`listPosts` (the post rule is NOT used for a `live_replay` row: its arm is this predicate over the
joined live), `GET /api/posts/:id`, the replay key route and the replay list route. A named reader
who sees the association only through a read grant watches the replay; the replay's COMMENTS follow
the comments rule for them (`commentsWithheldFromViewerSql`), as the live chat did.

**A replay cannot be reposted or republished** (WP-F6 reaches posts and reels; register C19 states
"a repost never widens a live's audience"): the repost and republication routes refuse
`kind = 'live_replay'`, and the predicate reads no repost or republication anyway. A replay's caption
cannot be edited (it has none; `PATCH` refuses the kind).

### Report, delete, staff, broadcaster, erasure

| Action | Path | What it does |
| --- | --- | --- |
| **Report the replay** | `POST /api/moderation/reports` `contentType: 'post'` on the replay's post id | exactly a reel's: the threshold hides it (`hiddenByModeration`), the queue shows it as a post |
| **Report the live, after its end** | `contentType: 'live'` | accepted while the live row exists - now three days; the queue's `state` gains `replay` |
| **Staff deletion** | `DELETE /api/posts/:id` by a moderator | sets `replayExpiresAt = now()` on the live (one statement), so every read refuses it at once; the sweep purges it within 30 s. No strike (question R4) |
| **Staff cut, of a reported live that became a replay** | `POST /api/lives/:id/cut` | as today for "a live that just ended and is not purged yet": the cut is recorded with its strike and the purge removes the replay at once (`live_cuts` is a "removed" fact) |
| **The broadcaster deletes their replay** | `DELETE /api/posts/:id` by the author (or a `POST_AS_ASSO` holder of the association) | the same statement as staff deletion |
| **Account erasure** | `LIVES_ERASURE_STATEMENTS` (`internal/account-erasure.ts`) + `DELETE FROM posts WHERE "authorId"` | the erasure already rewrites the broadcaster of EVERY live row of the account to `DELETED_ACCOUNT`; that is a "removed" fact, so the replay is invisible at once and purged by the next sweep. The posts row goes with the account's posts (and by cascade with the live row) |

**ONE deletion path for every cause**: the author, staff, a cut, an erasure and the three days all
end in the live sweep's existing purge (prefix delete, listing proven empty, then the row - the
`posts` row by `ON DELETE CASCADE` on `posts."liveId"`). What decides is durable state - an expired
`replayExpiresAt`, a `live_cuts` row, a `DELETED_ACCOUNT` broadcaster - never a timer.

### A cut or an erased live never becomes a replay

Already true by the facts `purgeEnded` reads: `live_cuts` or `DELETED_ACCOUNT` means "removed" and
purges at once. The replay is created only by the FINISH step (section 4), which runs under the
live's row lock and re-reads both facts, so a cut that commits first wins, and a cut that commits
after finds a replay and removes it. A live whose `endReason` is `cut` or `erased` is never eligible
whatever the order; `broadcaster` and `dropped` are.

## 4. Deletion at three days

### The durable state

Migration (social-service, plain): `lives."replayExpiresAt" timestamptz NULL` and
`lives."finishedAt" timestamptz NULL`, a partial index on `"replayExpiresAt" WHERE "replayExpiresAt"
IS NOT NULL`; `posts."liveId" uuid NULL REFERENCES lives(id) ON DELETE CASCADE` with a unique partial
index; `posts_kind_shape` re-created to allow `kind = 'live_replay'` (with `durationMs` and
`expiresAt` NOT NULL and `"liveId"` NOT NULL; a `post` or `reel` keeps `"liveId"` NULL).

### The finish step - the end's purge, for an eligible live

Today an ended live is purged once its viewers drained (seat lease) - one step. It becomes two:

1. **Finish** (`LivesService.finishEnded`, called where `purgeEnded` is called today, same drain
   rule): ONE transaction under the live's row lock -
   - eligible (no `live_cuts`, broadcaster not `DELETED_ACCOUNT`, at least one stored segment, the
     replay switch on): delete the chat (`live_chat_messages`, `live_reaction_bursts`; reported lines
     are another table and keep their own rule), set `"finishedAt" = now()`, `"replayExpiresAt" =
     "endedAt" + interval '3 days'` (the database clock, written once), apply the account's cap
     (section 1, older replays get `replayExpiresAt = now()`), and insert the `posts` row (`kind
     'live_replay'`, author = broadcaster, `associationId` = the live's, `publishedAt` = `endedAt`,
     `expiresAt` = `replayExpiresAt`, `durationMs` from the retained segments, `media` = `[]`); the
     unique index on `posts."liveId"` makes a re-run a no-op;
   - not eligible: the purge of today, unchanged.
   Then, outside the transaction: the seats and the arrival keys forgotten (today's purge does it).
2. **Purge at expiry**: the sweep selects `"replayExpiresAt" <= now()` (and, as today, every ended
   live with no `finishedAt` that is not eligible) and runs the existing `purgeEnded` on it. The
   comments' media of the replay post are purged first through `reel-purge` with the commenter as
   owner (the reel worker's rule, [reels](../../services/reels.md#the-worker-reelretentionscheduler-social-service)),
   since a cascade would skip the media store; the `post_notifications` of the post are deleted with
   it.

**The sweep's step 2 changes its selection, not its proof**: today it purges "every ended live"; a
replay row must not be re-listed on the media store every 30 s for three days, so the selection is
`"endedAt" IS NOT NULL AND ("finishedAt" IS NULL OR "replayExpiresAt" <= now())`. The termination is
still the listing proven empty.

**No clock as a correctness crutch.** The three days are the product's rule, written once from the
database clock at the end; every read asks `replayExpiresAt > now()`, so a replay is invisible the
moment it expires whatever the sweep is doing (the reels' `liveReelFilterSql` pattern); the sweep only
reclaims bytes, and what it reclaims is chosen by the row, retried by the row, and proven by the
listing.

### What the feed shows during the window

The `live_replay` row is a reel slide in the CanaReels viewer and a reel card in the feed, its
picture the first frame of its first retained segment (as a reel shows its first frame,
[reels](reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31)), with a
"Rediffusion" mark, the broadcaster's identity, its duration, the time it ended (`timeAgo`), and -
if the owner says yes (question R5) - **the time left**: "encore 2 j", "encore 5 h". The label is
computed from `expiresAt` against the SERVER's now: the list answer carries `serverNow`, stamped
outside the feed cache (a cached per-row "time left" would be stale), and the client keeps the offset
to its own clock for display only. A replay past its time is never in an answer, so the label never
has to say "expired".

An older client must never draw one: a `live_replay` row is served only to a list request carrying
`withReplays=true` (the `withLinks` pattern, [reels](../../services/reels.md#reading)), and `GET
/api/posts/:id` answers `404` for it to a client that does not declare it (the live's own client
version gate, `lives/live-client-version.ts`, is the precedent).

## 5. Download - the rules of a Reel

**Who**: whoever may see the replay (a reel's save is for EVERY reel, public or not,
[reels](reels.md#saving-before-the-deletion-c6)). **Where**: the same rail button, the same native
staging (`reels/gallery.ts`: 768 KiB base64 chunks, each at its offset, then `save_video`), the
browser's download on the web. **What file**: the first init, then every fragment, in index order -
segment by segment fetched, opened with the live key, its init dropped when equal to the previous one,
its fragment appended to the staged file. Memory is one segment (~1 MB) at a time; nothing builds
the 1.4 GB in RAM.

**Where an init changes, the save writes a NEW file** - "partie 2", "partie 3" - rather than one file
a strict player would decode wrong (section 2). How often that happens on real phones is WP-R0's
reading; if two generations of one phone always write byte-equal inits, the case is a background
only and it never splits.

**What is new against a reel's save**: the size (show it before the save: "1,4 Go"), the time (the
per-fetch rate of the segment location bounds one connection to ~6 Mb/s, so ~30 min for an hour; two
fetches in flight halve it), and MediaStore's `duration` = 0 for a fragmented file, already known for
reels.

## 6. The chat is not replayed

**Deleted at the finish step** (section 4): `live_chat_messages` and `live_reaction_bursts` of the
live, at most one seat lease (30 s) plus one sweep (30 s) after the end - the same bound as today's
deletion with the row. A hidden message's ciphertext is still erased at the hide. The arrival lines'
Redis keys go at the finish step too. **Kept, by their own rules**: a REPORTED chat line
(`live_chat_reported_lines`, until handled or 90 days, C20) and the removed viewers (until the
replay's purge, section 3). A live that does not become a replay deletes its chat with the row, as
today. Database backups may hold the rows of a live that crossed a nightly dump, as today.

The replay player draws no chat, no reaction stream and no viewer count; its rail has a reel's
reactions and comments (question R2).

## 7. Privacy texts that must change

Describe the new retention only; no legal substance is rewritten here. **They merge before the
replay switch is turned on**, in the pull request of WP-R5.

| Text | Where | What says the opposite today |
| --- | --- | --- |
| CGU, section "Directs", "Pas d'enregistrement" | `frontend/src/routes/legal/cgu/+page.svelte` | "Canari n'enregistre pas les directs et n'en propose aucune rediffusion : la vidéo et le chat sont supprimés à la fin du direct" |
| Privacy policy, section 2 "Directs" | `frontend/src/routes/legal/privacy/+page.svelte` | "Un direct n'est pas enregistré et n'a pas de rediffusion" |
| Privacy policy, section 6, the "Direct" row | same file | "Supprimés à la fin du direct (...)" - also still says "au bout d'une heure", stale since the owner removed the longest duration (2026-10-31) |
| Privacy policy, section 6, the CanaReels row | same file | "CanaReels du fil : 30 jours" - gains the replays' 3 days |
| Register of processing, row C19 | [register-of-processing](../../compliance/register-of-processing.md) | "no replay, L3"; "nothing outlives the live, and a running live keeps only its newest 20 segments"; the removed viewers and the nginx cache sentences |
| Register, row C20 | same | "a cut may target an open live or one that just ended and is not purged yet" - now three days |
| The pre-live screen, shown before every live | `frontend/messages/fr.json` / `en.json`, `live_rule_audience_member`, `live_rule_audience_association` | "et seulement pendant la diffusion. Rien n'en est gardé après la fin." `LIVE_RULES_VERSION` need not rise: these lines are on the screen before EVERY live |
| [live-production](live-production.md#5-the-privacy-policy-and-the-terms---written-2026-10-29-owed-the-owners-reread) | wiki | its list of the pages' live paragraphs |

## 8. An audit of what a CanaReel is today

### Every kind of item the CanaReels tab or the feed reels show

The CanaReels list is `GET /api/posts?kind=reel&multiMedia=true&withLinks=true`
(`frontend/src/lib/reels/allReels.ts:24`), drawn page by page by `fullScreenPageOf`
(`frontend/src/lib/reels/fullScreenPost.ts:46`); the server's clauses are in
`apps/social-service/src/posts/full-screen-post-sql.ts:69-112`.

| Kind | Shown in | Retention and expiry | Where the rule lives | What is deleted, and when | A "time left" label? |
| --- | --- | --- | --- | --- | --- |
| **Camera reel** (`kind = 'reel'`) | feed (reel card), CanaReels (reel page) | **30 days** from publication, `expiresAt` set once | `REEL_RETENTION_DAYS` `apps/social-service/src/posts/reel.constants.ts:28`, stamped `posts.service.ts:1168`; hidden past it in every read `posts.service.ts:336` and `posts/space-pins.ts:51` | `ReelRetentionScheduler` hourly (`posts/reel-retention.scheduler.ts:68`, due `:98`, row `:184`): the row with its comments and reactions, its `post_notifications`, its blob (`reel-purge` reason `retention`: the post's hold released, the file kept while a conversation's hold lasts) and its comments' media; a deletion by the author or staff purges at once (`posts.service.ts:2367`) | **Yes**: `expiresAt` is on every row; needs `serverNow` with the list. **Removed by the user's decision of 2026-10-02** (*"ce n'est pas discret"*, [reels](reels.md#saving-before-the-deletion-c6)) |
| **One photo post** | feed (post card), CanaReels (photo page) | **none**: kept until deleted | the list clause `SINGLE_PHOTO_POST_SQL` `full-screen-post-sql.ts:69`; the media class `archive`, never swept (`apps/media-service/src/media/media.service.ts:2663` `isSweepable`) | the author, staff or the account erasure delete the row; the media is RELEASED to `ephemeral` (`post-media-retention.service.ts:280`) and the idle sweep takes it 90 days later (`media.service.ts:42`) | No: nothing expires |
| **One video post** (not filmed with the Canari camera) | feed (post card), CanaReels (reel page) | **none** | `SINGLE_MEDIA_POST_SQL` `full-screen-post-sql.ts:72`; "a video post never expires" ([reels](../../services/reels.md#reading)) | as a photo post | No |
| **Carousel** (2-10 photos and videos) | feed (post card), CanaReels (carousel page) | **none** | `MULTI_MEDIA_POST_SQL` `full-screen-post-sql.ts:106` | as a photo post | No |
| **Any of the three above with a link in its text** | the same | **none** | `LINKED_MEDIA_POST_SQL` `full-screen-post-sql.ts:112` | as a photo post | No |
| *Outside the tab, for the model:* **reel sent in a conversation** | the conversation (tile, full-screen viewer) | **30 days from upload**, by age, never by reads | `CHAT_REEL_RETENTION_MS` `apps/media-service/src/media/media.service.ts:51`; the client's hint `frontend/src/lib/reels/chatReelWriter.ts:38`, its tombstone `chatReel.ts:25` | media-service deletes the file by age (holds: [reels-in-chat](reels-in-chat.md#153-retention---the-file-lives-as-long-as-its-longest-hold)); the message stays as a tombstone | **Yes**: the sender's `expiresAtMs` is already on the message |
| *Outside the tab:* **an open live** | the feed's live card (`frontend/src/lib/live/openLives.ts`) | until its end | [lives](../../services/lives.md#the-end-is-the-rows-state-q5) | at the end, after the drain | Not applicable (it is "en direct") |
| **Live replay** (this design) | feed (reel card), CanaReels (reel page) | **3 days from the END** | `lives."replayExpiresAt"`, section 4 | the live sweep, section 4 | **Yes**, the same way as a reel |

### The proposed model - one sentence, one column, one label

**A CanaReel is anything drawn full screen in the CanaReels viewer. Only what was MADE to be
ephemeral expires - a camera reel (30 days), a live replay (3 days) and a conversation reel (30
days); a post of photos or videos is a post and stays until someone deletes it.** In the code:

- **One column, one filter**: every post row's `expiresAt` - NULL means permanent - and ONE read
  clause `(posts."expiresAt" IS NULL OR posts."expiresAt" > now())` replacing `kind <> 'reel' OR ...`
  in `posts.service.ts:336` and `space-pins.ts:51` (the CHECK already guarantees a `post` has NULL).
- **A sweep per storage, one predicate**: the reel worker deletes `kind = 'reel'` blobs, the live
  sweep deletes `live_replay` prefixes - two storages, two allowlists, the same "due" predicate.
- **One label, if any**: one component reads `expiresAt` against `serverNow`, the same on a reel, a
  replay and a conversation reel - or none anywhere. Which is the owner's (question R5); the
  recommendation is the replay only, because three days surprise and thirty do not.

### The owner's questions - in French, recommended option first, four at a time

**Lot 1 - les replays**

- **R1. Combien de vidéo de replay un même compte peut-il garder en même temps ?**
  (1) *Recommandé* : 2 heures au total par compte ; un direct plus long ne garde que ses 2
  dernières heures, et quand un nouveau replay dépasse, les plus anciens replays de ce compte sont
  supprimés en premier (environ 2,8 Go au plus par compte qui diffuse). (2) 4 heures par compte.
  (3) Pas de limite par compte, seulement une alerte quand le disque se remplit.
- **R2. Sous un replay, peut-on réagir et commenter comme sous un Reel ?**
  (1) *Recommandé* : oui, comme un Reel (le chat du direct, lui, n'est pas repris). (2) Réactions
  seulement, sans commentaires. (3) Ni réactions ni commentaires.
- **R3. Les abonnés reçoivent-ils une notification quand le replay est disponible ?**
  (1) *Recommandé* : non, ils ont déjà été prévenus « X est en direct ». (2) Oui, « Le replay de X
  est disponible ».
- **R4. Quand la modération supprime un replay signalé, cela compte-t-il comme une coupure de direct
  (avertissement, puis suspension du droit de diffuser) ?**
  (1) *Recommandé* : non, c'est une suppression comme pour un Reel ; la modération peut toujours
  « couper » le direct depuis son signalement, et là la coupure compte. (2) Oui, toute suppression
  d'un replay par la modération compte comme une coupure.

**Lot 2 - ce qu'est un CanaReel**

- **R5. Faut-il afficher le temps qu'il reste avant la suppression ?**
  (1) *Recommandé* : seulement sur les replays (« encore 2 j »), discret, car trois jours c'est court
  ; rien sur les Reels de 30 jours, comme décidé le 2 octobre. (2) Sur les replays, et sur les Reels
  pendant leurs 7 derniers jours. (3) Partout où quelque chose expire, tout le temps. (4) Nulle part.
- **R6. Qu'est-ce qui expire dans l'onglet CanaReels ?**
  (1) *Recommandé* : seulement ce qui est fait pour être éphémère - les Reels filmés avec la caméra
  Canari (30 jours) et les replays (3 jours) ; un post de photos ou de vidéos reste tant qu'on ne le
  supprime pas, même s'il s'affiche dans CanaReels. (2) Tout ce qui s'affiche dans CanaReels expire,
  posts photo et vidéo compris.
- **R7. Un direct au nom d'une association : son replay compte dans la limite de qui ?**
  (1) *Recommandé* : de la personne qui a filmé, comme les coupures de la modération. (2) De
  l'association.
- **R8. Les 3 jours se comptent à partir de quand ?**
  (1) *Recommandé* : de la fin du direct. (2) Du début du direct.

## 9. Work packages, in order

Each lands on the draft pull request that carries this page first (WP-R1), then on its own branches.
Every migration is marked; [held](../../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)
means it carries `-- canari:hold-for-owner`.

| WP | What | Proof | Migration |
| --- | --- | --- | --- |
| **WP-R0** | Readings, no code: the disk figure (section 1); the owner's answers R1-R8; on both phones, two recorder generations of one live (a background, a lens change) - are their inits byte-equal (a digest of each init in the broadcaster's summary line, WP-R1 adds it) | the figures written here | none |
| **WP-R1** (server) | `live_replays_mode` (platform_config `off`/`on`, default `off`, read at the finish step, fail closed = today's purge); the finish step and the chat deletion at it; the sweep's new selection; the trim's cap per eligible live and the account cap; `GET /api/lives/:id/replay` (the key through `openLiveKey`, first and next index, `replayExpiresAt`) and `GET /api/lives/:id/replay/segments?from=&limit=` (`index`, `name`, `bytes`, `atMs`), both behind `LiveEnabledGuard`, no seat; `replayVisibleToUserSql`; the erasure and the cut re-read; `[LIVE_GC]` and the storage panel's replay counters; the broadcaster's init digest | `lives.integration.spec.ts` on a real PostgreSQL: an ended live becomes a replay once (re-run no-op), its chat is gone and its reported line kept; a cut before or after the finish leaves no replay; an erasure hides it at once; a removed viewer and a blocked one are refused; an expired replay is refused before the sweep runs and purged after it; the account cap deletes the oldest of that account only; switch off = today's purge | social-service: `lives."replayExpiresAt"`, `"finishedAt"`, the partial index - **plain**; core-service: `platform_config.live_replays_mode` - **plain** |
| **WP-R2** (server) | the `posts` row: `kind = 'live_replay'`, `posts."liveId"` with `ON DELETE CASCADE`, `posts_kind_shape` re-created; the list arm under `withReplays=true` (feed and CanaReels), `GET /api/posts/:id` 404 to a client without it; repost, republication and edit refused; `DELETE /api/posts/:id` sets `replayExpiresAt = now()`; report as a post; comments' media purged before the cascade; the one `expiresAt IS NULL OR > now()` filter | `posts.service.reels.spec.ts` and `full-screen-post-sql.integration.spec.ts` extended: the replay in every arm only with the flag, never to an older request; the predicate is `replayVisibleToUserSql` and not the post rule (a reposter's follower does not see it); an author's and a moderator's delete; the cascade takes the row and the purge takes the comment media | social-service: the `posts` column, FK, index and CHECK re-create - **plain** (`DROP CONSTRAINT` + `ADD CONSTRAINT` is on the allowlist; the CHECK scans `posts` under its lock, so the lock-timeout spec decides whether the author adds the marker) |
| **WP-R3** (client) | the replay slide and card: a VOD mode of `livePlayer.ts` over the segment list (MSE, init on change, seek by `atMs`, start past index 0), the "Rediffusion" mark, the time-left label per R5, `withReplays=true` sent, the rows dropped while `livesAvailable` is false; Paraglide strings in `fr.json` and `en.json` | unit tests of the VOD list and the seek; the player against a recorded fixture; then a dev reading on both phones (a live of a few minutes with a background, replayed and scrubbed) | none |
| **WP-R4** (client) | the save: the streamed join, a new file at an init change, the size shown first, the native staging reused | the join's unit test reusing this page's fixtures (equal inits, a gap, a different init); then a save of a real replay on each phone, played by Photos and the Android gallery | none |
| **WP-R5** (texts) | section 7's list, and `register-of-processing` C19/C20 in the same pull request | the owner's reread of the CGU and privacy pages (his to merge) | none |
| **WP-R6** | turn `live_replays_mode` on, dev first: two readings on both phones (a live ended by its broadcaster and one dropped, each replayed, downloaded, deleted by its author, and one left to expire past three days); then production, by the lead once the readings pass and WP-R5 is merged | the readings, written here | none |
| **WP-R7** (model) | per the owner's R5/R6: the label on reels and conversation reels or not; the one filter of WP-R2 already serves | the label's unit test with a skewed device clock | none |

## 10. What this page does not decide

- **A replay seen by many**: egress is unchanged per viewer and nothing caps replay viewers, as
  nothing caps reel viewers; if a replay draws a crowd, the host's uplink is shared as for a reel
  ([live-scaling](live-scaling.md)).
- **A "Revoir" button on the live's end screen** for viewers who were watching: possible from the
  replay route, not asked.
- **Desktop screen broadcasts**: a window resized mid-live writes a new init per generation only if
  the recorder restarts; measured with WP-R0's digest, not assumed.

## See also

- [lives](../../services/lives.md) - the server half this changes
- [live](live.md) - the client: the recorder, the segment, the player
- [reels](reels.md), [reels (server)](../../services/reels.md) - what a replay is drawn and deleted like
- [live-production](live-production.md) - the texts' previous pass
