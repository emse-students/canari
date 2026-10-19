# Lives - the server half (WP-L2, WP-L3, and WP-L7's push)

The server half of the live chantier planned on [live](../frontend/modules/live.md): the `lives` row
and its key (WP-L2), the segment ingest, the manifest viewers poll and the deletion at the end
(WP-L3), and the push to the broadcaster's followers when a live goes on air (WP-L7's server half,
[below](#the-push-to-the-followers-wp-l7-server-half), 2026-10-19). WP-L2/L3 were built 2026-10-18 on the plan's RECOMMENDATIONS, which the user said to take ("take the
decisions"): architecture **C** (segmented HTTP, no transcoding), key design **Q4**, durable end
**Q5**, retention **Q10**. **No client calls any of it yet** (WP-L5), and **it is switched OFF on
production** (below).

Code: `apps/social-service/src/lives/` (row, key, manifest, ingest, sweep, `live-announcer.ts`),
migrations `091_lives.sql` and `094_live_announced_at.sql`, and `apps/media-service/src/media/live-segments.service.ts` (the bytes).

## The switch: `LIVE_ENABLED`

Every `/api/lives` route and the two media routes that serve or store segments answer **404 unless
`LIVE_ENABLED` is exactly `true`** (`live-enabled.guard.ts`, `isLiveEnabled` in media-service).
`render-env.sh` computes it per estate (`compute_live_enabled`): **`true` on dev, `false` on
production**, asserted on the rendered files by `deploy-env.test.sh`. The local compose defaults it
to `true`. Three things run whatever it says, on purpose: the live sweep and the media purge and live-list routes, so
a live started while the switch was on is still ended and deleted after it is turned off.

## The numbers, and where each is the ONE copy

| Number | Value | Lives in | Clients read it from |
| --- | --- | --- | --- |
| Largest segment | 4 MiB of ciphertext | `LIVE_SEGMENT_MAX_BYTES`, `lives/live.constants.ts` (and the store's own refusal in media-service) | `GET /api/lives/limits` |
| Reconnect window (Q5) | 60 s without a segment ends the live | `LIVE_RECONNECT_WINDOW_MS`, same file | same route |
| Longest live (L4) | 60 min | `LIVE_MAX_DURATION_MS`, same file | same route |
| Manifest window | 10 segments | `LIVE_MANIFEST_WINDOW`, same file | same route |
| Byte budget per live | 1 687 500 000 B = 2.5 Mb/s (`LIVE_PLANNING_BITRATE_BPS`) x 60 min x 1.5 (`LIVE_BYTE_BUDGET_MARGIN`: encoder overshoot, container, AEAD tag) | `LIVE_BYTE_BUDGET`, same file | same route (`byteBudget`) |
| Segment rate | segment `index` accepted only while `index < 15 + floor(age / 1 s)` | `LIVE_SEGMENT_BURST`, `LIVE_SEGMENT_MIN_DURATION_MS` | same route |
| Starts per account | 6 in a rolling hour; ONE open at a time (the partial unique index) | `LIVE_STARTS_PER_HOUR`, `LIVE_START_WINDOW_MS` | same route (`startsPerHour`) |
| Ingests storing at once, per instance | 4 (the database pool is 10) | `LIVE_INGEST_MAX_CONCURRENT` | - |
| Store timeout / reservation age | 30 s / 35 s | `LIVE_STORE_TIMEOUT_MS`, `LIVE_RESERVATION_TTL_MS` | - |

The 60 s window, the bitrate, the margin and the one-second segment floor are planning figures,
**to be confirmed on the WP-L1 bench**.

## The API contract (`/api/lives`, signed-in members, social-service)

Refusals are typed: the body's `code` is the discriminator, never the message.

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/lives/limits` | any member | the four numbers above |
| `GET /api/lives` | any member | the open lives the caller may watch ([the rule of a post](#who-may-watch-the-rule-of-a-post)), newest first, at most 50, **no key** |
| `POST /api/lives` `{ key, associationId? }` | any member (L1) | `201` the live with its key. `400 LIVE_KEY_INVALID` (not 64 lower-case hex), `400 LIVE_ASSOCIATION_INVALID`, `403 LIVE_MUTED`, `403 LIVE_ASSOCIATION_FORBIDDEN` (no `POST_AS_ASSO` there), `409 LIVE_ALREADY_OPEN`, `429 LIVE_START_RATE` (6 starts in the hour) |
| `GET /api/lives/:id` | a member who may watch | `{ id, broadcasterId, associationId, startedAt, lastSegmentAt, nextIndex, key }` |
| `GET /api/lives/:id/manifest?from=<index>` | same | `{ liveId, nextIndex, lastSegmentAt, serverNow, segments: [{ index, name, bytes }] }` - the newest 10, or from `from` on |
| `PUT /api/lives/:id/segments/:index` raw `application/octet-stream` | the broadcaster | `{ index, name, nextIndex }`. `409 LIVE_SEGMENT_OUT_OF_ORDER` (with `nextIndex`), `409 LIVE_SEGMENT_CONFLICT` (a stored index sent with other bytes), `409 LIVE_SEGMENT_IN_PROGRESS` (that index is still storing: retry, the repeat then answers), `409 LIVE_SEGMENT_RESERVATION_LOST` (its reservation was taken over as abandoned), `413` over 4 MiB, `413 LIVE_BUDGET_EXHAUSTED`, `429 LIVE_SEGMENT_TOO_FAST`, `429` from nginx (no `code`), `400 LIVE_SEGMENT_EMPTY`, `503 LIVE_STORE_UNAVAILABLE` (nothing recorded, the index released), `503 LIVE_INGEST_BUSY` |
| `POST /api/lives/:id/end` | the broadcaster | `{ id, endedAt, endReason }`, idempotent while the row exists; once the end's purge deleted it, a repeat is `404 LIVE_NOT_FOUND`, which the client reads as "ended and deleted" - nothing keeps a deleted live's end to answer with (no replay, L3) |
| `POST /api/lives/:id/removed-viewers` `{ viewerId }` | the broadcaster | `{ liveId, viewerId }`, idempotent; `400 LIVE_VIEWER_IS_SELF` |

### Who may watch: the rule of a post

**A live respects spaces like a post** (decided by the lead on review, 2026-10-19 - a safe default,
reversible; it narrows L2's "the whole network"). `liveVisibleToUserSql` in
`spaces/reader-spaces.ts` states it ONCE, built from the same fragments as `postVisibleToUserSql`:
the broadcaster; a member's live, a reader sharing at least one space with the broadcaster; a live AS
an association, a reader who sees that association (a member, its rules reaching one of their spaces,
or - on the watch paths only - a nominative read grant). A live has no republication, the one
disjunct of the post rule it lacks. An admin is a reader like any other, as when browsing posts.

It gates the four paths together: `GET /api/lives` (the list), the key and the manifest
(`assertMayWatch`, `liveVisibleToViewerSql`, read grants counted as on every post READ path), and the
push's audience (`liveAudienceSql`, the PLAIN predicate - a named reader is never notified for their
perimeter, as for a post's announcement). Pinned on a real PostgreSQL by `lives.integration.spec.ts`
(a follower with no shared space, a follower sharing one, an association reached by its rules or its
membership, a read grant that watches without a push).

**The answers** (the key and the manifest, the same rule): absent, NOT VISIBLE to the viewer, or a
block between the viewer and the broadcaster in either direction, is `404 LIVE_NOT_FOUND` (invisible,
as the feed hides a post it does not show) - asked BEFORE the end, so an outsider never reads a `410`
that would say a live existed; an ended live is `410 LIVE_ENDED` to everybody else, the broadcaster
included; a viewer the broadcaster removed is `403 LIVE_VIEWER_REMOVED`. **A write on another
member's live** (a segment, the end, a removal) **is `404 LIVE_NOT_FOUND`**, the answer to a live that
does not exist - a `403` there would tell any signed-in account which live ids are real (review,
2026-10-19).

**A segment is read from media-service**, `GET /api/media/live/<liveId>/<name>` (JWT), by the `name`
the manifest gives. Serving it from Canari's own nginx without reaching media-service is WP-L4; until
then it is `Cache-Control: no-store` and streamed by media-service from the store.

### Reading a segment: why the route checks an account and nothing more

Decided 2026-10-18 on review, not overlooked, and unchanged by the spaces rule of 2026-10-19: a
segment's NAME is learned only from a manifest, and the manifest is refused to a reader the live is
not visible to, so a signed-in account outside the audience has no name to ask for. The only account
a further check could refuse is one removed (or blocked) AFTER reading the key - and it can ask only for names it already
learned from a manifest, i.e. segments it was allowed to fetch and decrypt at the time; a NEW name is
learned only from the manifest, which social-service refuses it. A per-fetch call to social-service
(one every few seconds per viewer) would buy nothing beyond that and put a cross-service round trip on
the hottest path, which WP-L4 moves into nginx's cache anyway. There is no token audience to narrow
by: one HS256 token, no `aud` claim, serves every service.

## The key (Q4): served like a post CEK, removal enforced by the server

The key is 32 random bytes **generated by the broadcaster's client** (the client generates every
content key) and sent at `POST /api/lives` as 64 hex characters; the server checks its shape and
stores it in the row. Every member who may watch reads it. It protects the segments against the
store, a cache and anybody without an account - **not against a viewer the broadcaster removed, who
already read it**. Rotation is deliberately NOT the mechanism (the plan's Q4): the server refuses a
removed account the key, the manifest and the listing, and **segment names are random uuids chosen
by the server at ingest**, so the address of the next segment is learned only from the manifest a
removed viewer is refused. What a removed viewer can still do is keep the segments it already
fetched, and fetch an older one whose name it already had.

## The end is the row's state (Q5)

`endedAt` and `endReason` are written ONCE, together (a CHECK ties them), by whichever comes first:

| `endReason` | Written by |
| --- | --- |
| `broadcaster` | `POST /api/lives/:id/end` |
| `dropped` | the sweep, when `COALESCE(lastSegmentAt, startedAt)` is 60 s old |
| `max_duration` | the sweep, or the ingest that finds the hour up (it writes the end and answers 410) |
| `erased` | the account erasure (below) |

`lastSegmentAt` is written by the ingest ONLY - the broadcaster's own liveness, which is the column
the drop predicate reads. "Reconnecting" on a viewer's screen is the client's to show from
`lastSegmentAt` and `serverNow` (both the database's clock); the END is never a client timer.

**Every write takes the live's row lock, and none holds it across the network.** Until the review
of 2026-10-18 the ingest held `SELECT ... FOR UPDATE` - a pooled connection - while it posted up to
4 MiB to media-service, up to the 30 s timeout: ten broadcasters on a slow Garage would have parked
every connection of the pool (10) and stalled every other route of social-service. The ingest is now
THREE steps:

1. **Reserve** - one short transaction: every check under the row lock (owner, end, hour, order,
   repeat, rate, budget), then `pendingName` / `pendingSha256` / `pendingAt` written and COMMITTED.
2. **Store** - no transaction open, no connection held.
3. **Confirm** - one short transaction: under the row lock, insert the segment, advance `nextIndex`,
   add to `storedBytes`, clear the reservation. A failed store CLEARS it instead (the index is free at
   once).

**The lock-order argument, restated for the reservation:**

- *Only the next index, gapless*: the reservation is of `nextIndex` and nothing else; only the
  confirm that holds `pendingName` advances it, and a second ingest of a reserved index is
  `409 LIVE_SEGMENT_IN_PROGRESS` while the reservation is younger than `LIVE_RESERVATION_TTL_MS`.
- *Same bytes idempotent*: unchanged - a repeat of an index below `nextIndex` is answered from
  `live_segments`' `sha256`.
- *An end against an ingest in progress*: an end (the route, the sweep's `UPDATE`) takes the row lock
  only for its own statement, so it waits at most for a reserve or a confirm, never for a store. The
  confirm that follows an end records NOTHING (410) and clears the reservation; the drop predicate
  still reads `lastSegmentAt`, written only by a confirm, so a live that just took a segment is never
  ended by a sweep that started before it.
- *No orphan*: the purge reads the row first and is `kept` while a reservation younger than the TTL is
  set - before it touches the store - and no reservation can be taken once the end has committed (the
  reserve checks `endedAt` under the lock). So when the purge proceeds, the only store of this live
  that can still land is one past its own 30 s timeout; the confirm that met the end purges at once.
- *A reservation whose ingest died* (a crash between reserve and confirm): older than the TTL (the
  store timeout + 5 s, so the HTTP call cannot still be waiting in this process), it is taken over by
  the next ingest with a `warn`, and ignored by the purge.

On top of it, **at most 4 ingests store at once per instance** (`503 LIVE_INGEST_BUSY` beyond, a
`warn`): no connection is held across a store any more, but each holds up to 4 MiB and a
media-service request. Proven on a real PostgreSQL by `lives.integration.spec.ts`: a stalled store on
a pool of ONE connection does not block another query on it; a failed store leaves nothing pending;
an end during a stalled store answers at once, the ingest then gets 410, and nothing outlives the
purge; a purge waits for a live reservation and ignores an abandoned one.

## What one broadcaster may store

Decided 2026-10-18 on review (nothing limited it before). Four bounds, each a typed refusal:

- **A byte budget per live**, `storedBytes` on the row against `LIVE_BYTE_BUDGET` (table above). A
  segment that would cross it is REFUSED (`413 LIVE_BUDGET_EXHAUSTED`) and the live is NOT ended by
  it: nothing more is accepted, so it ends by its broadcaster or, with no segment for 60 s, by the
  sweep - one end path, not a second one for a case only an abusive client reaches.
- **A segment rate held as a COUNT in durable state**: `nextIndex` is the number of segments taken,
  compared with the live's age read from the database clock (`index < 15 + floor(age / 1 s)`), so
  one segment a second on average, whatever retries do, with a burst that covers a reconnect's
  backlog. `429 LIVE_SEGMENT_TOO_FAST`. The specs move `startedAt` by SQL; no wall clock is asserted.
- **Lives per account**: one OPEN at a time (the partial unique index, `409 LIVE_ALREADY_OPEN`), and
  6 STARTED in a rolling hour (`429 LIVE_START_RATE`), counted in `live_starts` because a live's own
  row is deleted at its end. The sweep deletes the rows older than the hour.
- **At the edge**: nginx's `lives_ingest` zone, 2 r/s burst 20 per client address on `PUT` only, and
  `client_max_body_size 5m` ([nginx](../infrastructure/nginx.md)).

## Deletion: at the end, plus a sweep (Q10, L3)

There is no replay. At the broadcaster's end the segments and the row are deleted at once; every
other end, and any purge that failed, is finished by `LiveRetentionScheduler` (every 30 s):

1. end every open live past the reconnect window or the hour;
2. for every ended live: media-service deletes everything under `live/<liveId>/` and **lists the
   prefix again**; social-service deletes the row (segments and removed viewers cascade) **only when
   that listing is empty and no delete failed** - termination from a proof, not from a call that
   returned. A refusal keeps the row, invisible (410), for the next run; a `try` per live. A live
   with a segment still storing is kept too (above), and an OPEN live is never purged by this path;
3. **the orphan reaper**: media-service lists the `live/` folders (`POST /media/internal/live-list`,
   a delimiter listing, one entry per folder) and every folder with NO live row behind it is purged
   and proven empty the same way. A ROW-STATE RULE, NOT A CLOCK: a folder is written only under a
   reservation, which needs the row, and a row is deleted only once its prefix proved empty with no
   reservation in flight - so a folder with no row was written after its purge, by a store that
   outlived its own timeout. The listing is read BEFORE the rows, so a live started in between is not
   in it. Reported as `orphans=` on the `[LIVE_GC]` line, each one a `warn`;
4. the `live_starts` rows older than the hour are deleted.

Observed by `[LIVE]` / `[LIVE_GC]` lines, and the storage panel's `liveSegmentCount` /
`liveSegmentBytes` (media-service `getStorageStats`): segments are outside the media metadata index
by design (a segment every few seconds would rewrite the whole JSON index every few seconds), so the
idle sweep and the account-deletion fan-out never see them, and the panel gives them their own line
instead of `untracked`. **A count that does not fall back to zero between lives is the sweep
stopped.**

## A deleted account

`LIVES_ERASURE_STATEMENTS` (social `account-erasure.ts`): a live the account broadcast is ENDED
(`erased`, unless already ended) and its broadcaster becomes `[deleted]` **in one statement**, so an
open live never carries the tombstone and the one-open-live index never sees two; the sweep deletes
its segments and row within one run. The account's place on another live's removed-viewer list is
deleted, and so are its `live_starts` rows. `broadcaster` and `viewer` were added to the shared account-column pattern
(`libs/contracts/account-reference-columns.json`) so the coverage spec sees both columns. Register
row C19 ([register-of-processing](../compliance/register-of-processing.md)).

## The push to the followers (WP-L7, server half)

The user's question, 2026-10-19: *can a follower get "X est en live" the way they get "X a publie"?*
Decisions L5 and L10 of the [plan](../frontend/modules/live.md): a push ONLY to the followers of the
member or association broadcasting. Built in `LiveAnnouncer` (`lives/live-announcer.ts`); **the
client half - the LIVE card in the feed and the app route the tap opens - is NOT built** (below).

| Question | Answer, and where it is decided |
| --- | --- |
| **When** | At the **first STORED segment**, not at `POST /api/lives`: a row alone has nothing to watch, and a start the client abandons (camera refused, app killed, an immediate end) would ring every follower for nothing. So a refused start, and a live ended before its first segment, are never announced. |
| **Once per live** | `lives."announcedAt"` (migration 094). Segment 0's CONFIRM stamps it in the SAME transaction, under the same row lock, as the segment itself (`WHERE "announcedAt" IS NULL`), and the push follows the commit. A repeat of segment 0, a reconnect, every later segment: the same stamped row, no second push. A NEW live (a new row) is a new announcement. No timer and no sweep: there is no second path to reconcile. |
| **The trade** | Stamp before send, as `PostAnnounceScheduler` does: a crash between the commit and the send loses ONE announcement (`[LIVE_ANNOUNCE] ... NOT announced` at warn when it is an error rather than a crash); the other order could repeat it. A failing announcement never fails the segment. |
| **Not awaited** | The ingest STARTS the announcement after segment 0's commit and answers without waiting for it, so segment 0 and its ingest slot (`LIVE_INGEST_MAX_CONCURRENT`) never wait on the audience query or the fan-out. Once per live is untouched - the claim is the commit, not the call. `LivesService` tracks the announcements in flight: `announcementsSettled()` resolves when they have (awaited at module shutdown, and by the integration spec before it reads a push - a proof, never a delay); a rejection reaching it would be a defect in `announce`, logged at error. |
| **Who** | A member's live: `user_follows` (followers of the broadcaster). A live AS an association: `association_follows` of that association - the member's own followers are NOT told. Both minus the broadcaster, minus a follower the live is not VISIBLE to ([the rule of a post](#who-may-watch-the-rule-of-a-post): a member's follower with no space in common, an association's follower its rules and membership do not reach), minus either side of a block with the broadcaster and a viewer the broadcaster already removed: exactly who `assertMayWatch` lets in (read grants aside, which never notify), narrowed to followers (`liveAudienceSql`). |
| **The name** | The association's `name`, or the member's display name from `PostNotificationsService.resolveDisplayName`. **A member with no name to give (no `users` row, or no name in it) is NOT announced** - `[LIVE_ANNOUNCE] ... NOT announced: broadcaster ... has no display name` at warn - rather than titled with the 64-hex user id, the fallback `resolveActorName` keeps for its other callers. A lookup that FAILED is a different outcome, classified where it happens: `resolveDisplayName` throws (only `null` means "no name"), and the one warn line carries that cause instead. Either way the claim is committed, so it is not retried. |
| **Mutes** | `association_push_mutes`: `live_started` is in `MUTABLE_PUSH_TYPES`, applied by `PostNotificationsService` like an association's post ([social-service](social-service.md)). A member's live has no association, so no mute applies. |
| **Notification levels** | The push's `contentKey` `social_live_started` is filed under the reader's **`posts`** category in chat-delivery (`push-category.ts`): the switch that silences the posts of the people you follow silences their lives too. No new category (it would need a settings row on the client). |
| **The pipeline** | `PostNotificationsService.pushNotice`: the same content mapping, icon rule (the association's logo, the member's face), mute and bounded per-recipient fan-out as `createNotifications`, sharing one private `fanOutPush`, but **no `post_notifications` row** - a live is deleted at its end (L3), so a bell row would be a 404 for ever after. |
| **Language** | Composed ON THE DEVICE from `contentKey`, as every social push since 2026-08-19: `notif_social_live_started_*` (Android, fr + en) and `notif.social.live_started.*` (iOS app and NSE, fr + en) - FR "X est en live" / "Appuyez pour regarder", EN "X is live" / "Tap to watch". The server's French `title`/`body` ride along for builds older than the key. Pinned by `push-content.spec.ts` and `nativeStrings.test.ts`. |
| **Payload** | `{ type: 'social', liveId, associationId?, deepLink: 'fr.emse.canari://live/<liveId>', contentKey, actorName, contentArg: '', iconUserId or iconMediaId }` - `socialDeepLink` writes the link. |
| **The switch** | Nothing is sent unless `LIVE_ENABLED` is `true` (checked by the announcer itself, on top of the ingest route's own guard): **off on production**. |

Observed by `[LIVE_ANNOUNCE] <liveId> by <broadcaster> kind=member or association followers=<n>`.

**The tap, and what the client still owes (WP-L7's other half, with WP-L5):** `appRouteForDeepLink`
(`frontend/src/lib/mobile/deepLinkRoutes.ts`) owns the `live` host and sends it to the FEED
(`/posts`), and `tauri.conf.json` declares it (Android's deep-link plugin drops an undeclared host)
with its intent filter in the committed `AndroidManifest.xml`, as #1635 did for the agenda hosts
(`deepLinkHostsDeclared.test.ts` pins both).
A build older than that change does not route the tap: Android opens the app and stays where it was,
and a link that reaches the hook lands on `/notifications` with the unknown-host warn. Owed: the
`live/<id>` case reading the id once WP-L5's viewer page exists; the LIVE card at
the top of the feed (L5) reading `GET /api/lives`; and the store builds carrying the new native
strings (an installed build without them shows the server's French wording, with a warn).

## The migration: `091_lives.sql`

Four new tables (`lives`, `live_segments`, `live_removed_viewers`, `live_starts`), nothing existing
changes; idempotent (applied twice by the integration spec), and
`synchronize` against it changes nothing on a live table (asserted). User ids are `varchar(255)`.
No foreign key to `associations`: an association deleted during a live leaves a live that still ends
and is still deleted.

`094_live_announced_at.sql` adds `lives."announcedAt"` and, in the same step that creates the column,
stamps every existing row with its start; a re-run touches nothing. Nothing sweeps for unannounced
lives - only segment 0's confirm claims one - so what the backfill changes is narrow: a live caught
MID-START by the deploy (row written, segment 0 not yet confirmed) is never announced. 094 because it
is the next free number on `main` (093 its highest on 2026-10-19).

## What is not proven

- **Nothing on a phone, nothing through nginx, nothing on a real media-service and Garage**: the
  specs are a real PostgreSQL with an in-memory store, media-service unit specs over a fake bucket,
  and the HTTP client over a fake transport. The first reading is a dev deploy plus a scripted
  broadcaster.
- **A store that outlives its own timeout** is no longer left behind: while the live lasts it is
  under the live's prefix and the end's purge takes it; one that lands after the purge is a folder
  with no row, which the next sweep's reaper takes. What is not proven is the reaper against a real
  Garage listing (the delimiter listing is exercised on a fake bucket).
- **The ingest semaphore is per instance.** social-service runs one replica (two for a moment during
  a rolling deploy); a second permanent replica would double the bound.
- The 60 s window, the 4 MiB bound, the 2.5 Mb/s budget and its 1.5 margin, and the one-second
  segment floor are planning figures until WP-L1 measures segment sizes and reconnect times.

## See also

- [live](../frontend/modules/live.md) - the plan, the decisions, the work packages
- [reels](reels.md) - the server model this copies (state is the row, blobs then row, a `try` per item)
- [media-streaming-upload](media-streaming-upload.md) - the 8 MiB body invariant the segment bound sits under
- [account-erasure](../account-erasure.md)
