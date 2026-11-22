# social-service

**Stack**: NestJS  
**Port**: 3014  
**Source**: `apps/social-service/`

## Responsibilities

The social-service manages all community features:

- **Posts**: news feed with Markdown, polls, reactions, comments, reports, pinning.
- **Channels**: encrypted workspaces with role-based access, HKDF-derived per-channel keys, server-assisted key distribution.
- **Associations**: club management, members, documents, calendar events, boutique products,
  partnership cards (partner discounts, claimed by code, shared code, or a static instruction).
  Every association-scoped right goes through one predicate, `AssociationsService.mayAct` - see
  [Association permissions](../association-permissions.md).
- **Forms**: dynamic form builder with optional Lydia payment, cash payment validation.
- **Cotisations**: membership dues as time-bounded `user_tags`, granted via boutique products, manual grants, or paid forms - see [Cotisations](../cotisations.md).

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Channels, workspaces, memberships, Graine sessions, forms, submissions, associations, products, partnership cards and codes, **and posts, comments and reactions** |
| Redis | `chat:channel_events` pub/sub (publishes to chat-gateway) |

This table said "MongoDB - posts, comments, reactions" until 2026-08-18. It was never true: the
posts module is TypeORM entities in PostgreSQL, and there is no MongoDB client anywhere in this
service. The `mongo` container it described is deleted.

## Channel encryption model

**A channel message is sealed with a Graine message key, and the server holds none of it.** The
protocol, its derivation, its measurements and its rejected alternatives are on
[channel-encryption](../protocols/channel-encryption.md); this page carries only what the SERVICE
does, which is now almost nothing:

1. A message names `senderSessionId` and `messageIndex`, and the row is refused without them
   (`CHANNEL_SESSION_REQUIRED`, `CHANNEL_MESSAGE_INDEX_REQUIRED`). The key is
   `HKDF(seed, sessionId, index)` and the seed never leaves the sending devices, so a row missing
   either is a row NOBODY can open - including its own author. It must also carry a Graine v2
   `signature` (64 bytes, base64), refused otherwise with `CHANNEL_SIGNATURE_REQUIRED` since every
   client the floor admits signs ([channel-encryption 21.8](../protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13)).
   The service checks its shape and cannot verify it.
2. Seeds travel over the community's MLS distribution group, whose `groupInfo` this service serves
   to members only (`/workspaces/:id/distribution-group`). That GroupInfo IS the capability to read
   every seed on the group, which is why the membership check lives here: `channel_workspace_members`
   is this service's table, and chat-delivery could not answer the question about it.
3. What a newcomer reads of the past is `channel_workspaces.historyVisibility` (`shared` | `joined`),
   stored and broadcast here and ENFORCED on the answering client - the only place that holds a seed
   to withhold.

**Until WP-50/51 (2026-08-18) the server could read every channel message, and that was the design.**
`channels.masterSecret` sat in Postgres in the clear, every epoch key was `HKDF(masterSecret, ...)`,
and a member received that derived key as raw base64 over an authenticated REST call. Migration `041`
drops `masterSecret`, both `keyVersion` columns, the legacy `channel_members.keys` jsonb and the
`channel_key_distributions` ledger; `deriveEpochKey`, `buildChannelBootstrap`, the two key routes,
`rotateChannelKey` and `pushKeyToUser` are gone with them. Dropped rather than left nullable: while
the root secret exists, a future read path can derive from it.

**Three refusal codes went with the epoch, and nothing replaced them.**
`STALE_CHANNEL_KEY_VERSION` and `CHANNEL_KEY_VERSION_REQUIRED` named an epoch the server derived and
could therefore be behind; it now knows a session's NAME and nothing more, so a sender can never be
stale against it. `ChannelKeyUnavailableError` and the vault that raised it are gone too - a missing
seed is `GraineSessionUnavailableError`, and it is REPAIRABLE (a request to one named member) rather
than re-bootstrappable.

**The code is the contract, the sentence beside it is for humans** and may be reworded freely.
Until 2026-08-16 the client read the sentences instead - five `includes()` on `Error.message`, one of
which (`'Sync required'`) was only the tail of another - and `channelCrypto.test.ts` now pins that an
untyped error carrying that exact prose is NOT retried. The client half is `ChannelApiError`
(`ChannelService.ts`), which carries the status and the parsed `code` while leaving `message` as the
raw body, the same shape `DEVICE_REVOKED` uses on [chat-delivery](chat-delivery.md).

A related note for anyone auditing this file: `soft-crypto.ts` (`encryptSoft` / `decryptSoft`) had no
call site anywhere in `apps/`, `frontend/src` or `libs/` and was deleted 2026-08-17. It was a second,
unused derivation sharing the `canari-channel-e2ee-v1` info string with the live one, which is
exactly the shape that gets mistaken for the real mechanism while reading.

## A query at boot runs BEFORE the migration that adds its column (2026-10-02)

**The deploy starts the containers and only THEN applies the migrations**
(`infrastructure/deploy/deploy-environment.sh`: `up -d`, wait for PostgreSQL, `apply_migrations`, then
require every service to be running - and for that check `Restarting` is fatal). So on the deploy that
ships a migration, anything a service reads at BOOT runs against the OLD schema.

It happened the first time a boot query read a new column: `PostMediaRetentionService.onModuleInit`
(the `archive` and `reel` backfills) selects `p.kind` and `p."expiresAt"`, which migration 069 adds. On
`v1.0.1-alpha.2` the rejection left `onModuleInit`, the process exited 1, `social-service` went to
`Restarting (1)`, and the dev deploy failed - production would have failed identically on the stable.
The restart policy had it healthy seconds later, which is why the dev estate was fine by the time it was
looked at: **the deploy read the loop, not the outcome**. (The dev deploy cannot show the fix, either:
its migrations are already recorded, so the query succeeds there whatever the code does.)

- **A backfill is a repair, never a precondition of serving.** Each pass in `onModuleInit` now runs in its
  own `try`: a failure is logged at ERROR, naming the pass, and the service starts; the next boot repeats
  it. The two are independent, so a failing `archive` pass does not skip the `reel` one.
- **The rule for the next boot-time read of a new column:** either it is best-effort and loud like these, or
  the migration must reach the database before the service starts. The second means changing the order in
  the deploy script and is NOT done here - it is the structural answer, and a decision for a deploy whose
  failure costs more than a retry.
- Tests: `post-media-retention.reels.spec.ts` (both passes failing, only one failing, a healthy schema).

**UPDATE 2026-10-30 - THE ORDER ABOVE IS NO LONGER THE DEPLOY'S (checked while reviewing #2707, which adds `post_notifications.meta`, migration 117).** `deploy-environment.sh` now brings up ONLY postgres, runs `apply_migrations`, and only then replaces the services one by one (`rolling.sh`, #1563), so new code never reads a column before its migration on a deploy: a new column the whole API selects (`meta` on every notification read and insert) has NO few-seconds window of 500s. The two exposures that remain are narrower - a ROLLBACK across a migration (old code on a newer schema: harmless for an additive nullable column the old entity never names, as here) and a migration that fails (the script stops before any service is replaced). The 2026-10-02 incident above (069, and 090's deploy-window text) predates that order; no other column has been found exposed since it, so no backlog entry is opened for a general gap that the script no longer has.

**A column every request would read (migration 090, 2026-10-17; the deploy-window reasoning below is HISTORICAL - since #1563 the deploy applies the migrations BEFORE it replaces any service, so only a rollback across a migration meets old code on a newer schema).** `channel_messages."clientMessageId"` is the salon send's idempotence key: a partial unique index on `(authorId, channelId, clientMessageId)`, and a repeated `POST /api/channels/:id/messages` with the same `messageId` is answered with the stored row - nothing written, published or pushed; two racing repeats are settled by the index, the loser answered with the winner's row. On the entity it is `select: false, update: false`, so no history read and no pin names it before the migration. **Every INSERT does**: TypeORM lists each insertable column in its INSERT (`DEFAULT` for an absent value), so on a schema without 090 EVERY salon INSERT fails - a send with or without a client id, an edit, a reaction, a system notice - whole, storing nothing. A `messageId` that is not a UUID is refused 400 `CHANNEL_CLIENT_MESSAGE_ID_INVALID`. The answer echoes `clientMessageId`, which is how a client learns a repeat is safe. A message delete first writes the id's tombstone (`channel_message_client_tombstones`, cascaded with its salon), and a repeat that meets it is refused 410 `CHANNEL_MESSAGE_DELETED` - so a delete, too, fails whole on such a schema. The delete locks the message ROW before the client id's advisory lock (`deleteChannelMessage`), so a delete racing an account erasure waits for it and writes no tombstone of the erased author. A tombstone is kept **30 days** (decision 2026-10-18): `ChannelRetentionScheduler.purgeExpiredClientTombstones`, daily at 03:50, deletes the ones whose `deletedAt` is older, at the instant it is handed. Tests: `channel.service.spec.ts`, `channel-message-client-id.integration.spec.ts` (needs `SOCIAL_IT_DATABASE_URL`; the deploy-window case fails without `select: false`). Why: [offline-and-weak-network](../frontend/offline-and-weak-network.md#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17).

**A salon row's broadcast and push come from an outbox (migration 093, 2026-10-18).** `sendMessage` inserts the row AND a `channel_message_fanout` entry (`messageId`, a `payload` holding the cleartext mentions and the seed frame the push carries) in ONE transaction, answers, then publishes `channel.message.created` and rings the phones off the request path; the entry is deleted only when BOTH were handed off (each failure is logged by branch). The entry cascades with its message. **What it covers: PROCESS DEATH and DATABASE failures (an audience, member or workspace read that throws) - NOT a Redis outage**: `RedisService.publish` swallows its own errors, so the frame counts as handed off and the entry is deleted.

**Who finishes a fan-out that did not complete.** (1) A normal deploy is the commonest process death: the old replica is told SIGTERM after its successor is healthy, and its last requests were answered BEFORE their fan-outs ran. `ChannelService` tracks every in-process fan-out by message id and `drainOnSigterm` awaits `settleFanouts()` before `process.exit` (bounded only by the stop timeout), so a deploy leaves no entry. (2) `onApplicationBootstrap` drains the entries left by a real crash, once per boot (a failure is logged at ERROR, retried at the next boot, never fatal). (3) A repeat of a send (WP-OFF-3) drains its own entry at once, skipping one whose fan-out is running in this process. No clock decides any of it. **Accepted, not fixed:** an entry kept by a DB failure waits for the next boot, where it rings phones for an old message. The client facts that make a late duplicate or a late push imperfect: the web client shows a weeks-old message with unloaded history as a new bubble; Android's duplicate-push dedupe keeps only 128 keys (`ALERTED_PREFS`); the iOS notification extension has no channel-push dedupe. A cross-replica claim is out of scope: a boot drain on a new replica can repeat a fan-out the old replica is still finishing (one duplicate frame, settled by message id). Both pull requests may ride the same release: the deploy migrates before it replaces services, and a rollback leaves a harmless unread table. Tests: `channel.service.spec.ts`, `drain-on-sigterm.spec.ts` in chat-delivery-service, which proves this service's byte-identical copy (an owed fan-out is awaited before exit), and `channel-message-client-id.integration.spec.ts` (an incomplete fan-out leaves its entry and the boot drain finishes it; a send whose entry cannot be written leaves no row).

## Storage and retention: a channel message costs one row, forever

Two facts that decide every capacity question about communities, both verified against production:

- **A channel message does NOT fan out.** `ChannelService.sendMessage` inserts exactly **one**
  `channel_messages` row whatever the member or device count; online clients are served over Redis
  pub/sub and offline ones get a direct FCM push through chat-delivery's
  `/internal/push/notify`, which never touches `queuedMessageRepo`. Measured on prod:
  `queued_message` holds **0** rows for any channel id. This is the opposite of a DM, where a copy of
  the ciphertext is stored per recipient *device* - see [chat-delivery](chat-delivery.md).
- **`channel_messages` expires after a year** (`ChannelRetentionScheduler`, daily at 03:45, since
  2026-08-19). `CHANNEL_MESSAGE_RETENTION_DAYS = 365` is the ONLY copy of that number: the client
  never compiles one in, it asks. **Pinned messages are exempt** - pinning is somebody deliberately
  saying this one outlives the scroll, and pinned sets are small and bounded per channel. The other
  removals are unchanged: deleting a community drops its rows outright (since 2026-08-18), account
  deletion rewrites `authorId` to `[deleted]` and keeps the row, and `deleteChannelMessage` is
  explicit. A row costs ~960 B including indexes, `content` averaging 137 B because a channel
  ciphertext carries no MLS framing.
- **The Graine seeds are swept on the SAME window, derived rather than timed.**
  `POST /api/channels/graine/live-sessions` answers which of a device's sessions are still named by
  a stored message; the device forgets the rest. One window, one clock - and it is what makes the
  pinned exemption safe, since a pinned message keeps its session alive by still naming it. The
  refusals that carry the design (a young session is never dropped, an unanswered chunk sweeps
  nothing) are in [channel-encryption](../protocols/channel-encryption.md#8-retention-one-window-and-the-seeds-derived-from-it---shipped-2026-08-19).

Posts still have the OLD shape: no TTL, no cron, removed only by an explicit delete or account
deletion. The retention above is `channel_messages` only.
The numbers and what they imply are in
[storage-forecast](../infrastructure/storage-forecast.md).

## Routes

### Path parameters are declared, and one global guard reads the declaration (2026-11-14)

**The rule.** A controller says what each of its path parameters IS, once, with
`@RouteParams({ id: 'uuid', userId: 'opaque', ... })` (`src/common/route-params.ts`), on the class
or on one handler (which adds to its class and wins over it). `RouteParamsGuard`, registered through
`APP_GUARD` in `AppModule`, answers `400` naming the parameter when a `uuid` is not one. It reads the
declaration and the path, never the database. **"A uuid" means what the column takes** - the
canonical 8-4-4-4-12 text, whatever its version and variant bits (`isUuidShaped`): Postgres stores
any 128 bits, and a stricter RFC check would put an existing row out of reach behind a `400`.

**Why not `ParseUUIDPipe` on each `@Param`.** Nest runs guards BEFORE pipes.
`GlobalAdminOrAssociationRoleGuard` reads `:id` and asks the service whether the caller may act on
that association, so on its routes the raw string reached a Postgres `uuid` column from inside the
guard, whatever pipe the handler carried: a `QueryFailedError`, answered `500`. A global guard runs
before every guard a controller names, which is the earliest point that covers them. A filter turning
that database error into a `400` was refused: it would learn by failing what the route already knows.

**Why a declaration and not a convention on names.** `id` means a uuid in one controller and may
not in the next, and a user id is NOT a uuid in this service (see
[below](#a-user-id-is-not-a-uuid-and-one-partnership-column-said-it-was)). `opaque` is therefore
written down too: an unvalidated parameter is a choice somebody made, never an omission.

**`400` comes before `401`, on purpose (decided 2026-11-14).** The global guard runs before
`NginxAuthGuard`, so an unsigned request with a malformed id is answered `400`. A malformed path
reveals nothing about any row, and nginx authenticates before the service is reached.

**One status changed that was not a `500`.** `GET /api/associations/<not a uuid>` was a `404` (the
service checked the id itself); it is a `400` now, like every other route of the controller. The
frontend's and core-service's callers pass row ids and treat any failure alike.

**The declaration is the ONE mechanism (2026-11-14).** No path parameter carries a `ParseUUIDPipe`
any more: every controller of the service declares its parameters, and the per-parameter pipes the
declaration made redundant are gone. A `ParseUUIDPipe` on a QUERY parameter stays (two exist); the
guard reads the path only.

**What holds it** - specs that need no database:

- `src/route-params.coverage.spec.ts` walks `AppModule`'s own module graph and fails on a path
  parameter no declaration names, on a declaration naming a parameter its routes do not have (a typo
  would otherwise validate nothing while looking like it does), on a path parameter that carries a
  `ParseUUIDPipe` again (two mechanisms would drift), on a name declared `uuid` in one controller
  and `opaque` in another (the spec cannot read a column, it can read a contradiction; the two
  decided exceptions are listed in it), and on `AppModule` not providing the guard. It
  judges EVERY controller: the list of controllers not converted yet is gone.
- `src/common/route-params.spec.ts` holds the guard alone: what it refuses, that `opaque` is never
  looked at, and that a handler's declaration wins over its class's.
- `src/associations/associations.route-params.http.spec.ts` boots the real controller and the real
  guards over HTTP: a malformed association id is a `400` and none of the role guard's questions
  (`mayAct`, `isMember`, `isAssociationSuperAdminOf`) was asked; the same route with a uuid reaches
  the role guard, then its handler. `channels.route-params.http.spec.ts` and
  `booking-calendar.controller.spec.ts` do the same for their routes. **A spec that boots a
  controller by itself and expects the `400` provides `ROUTE_PARAMS_GUARD`**, as `AppModule` does.

**What `opaque` names, so nobody "fixes" it.** A user id (never a uuid in this service, see
[below](#a-user-id-is-not-a-uuid-and-one-partnership-column-said-it-was)), a slug, an invite token,
a follow `kind`, a seat `index`, and the ids of a poll and of a comment, which are keys inside a
`jsonb` document and not rows. **Two are opaque although they name a uuid row, by decision
(2026-11-14):** `memberId` and `postId` of `PublicController`, the anonymous surface (a member's
avatar, a post's link preview). Their service already answers a malformed id with the same bodyless
`404` as an unknown one, so a caller with no session learns nothing from the shape of what it sent;
a `400` naming the parameter would tell the two apart for no reader.

**Routes whose malformed id was a `500` and is a `400` since every controller declares
(2026-11-14):** the internal channel read, the internal routes taking an association id, the
internal form-submission route, a minesweeper score submission, a moderation report, a post's
calendar link, and the public member list. No request that worked changed status. One refusal
moved: the guard takes any canonical 8-4-4-4-12 text where `ParseUUIDPipe` also read the version
bits, so an id of that shape with bits the pipe refused is a `404` from the query, no longer a `400`.
And a malformed id is answered before the per-address throttles a handler names, which no longer
count it: the answer is a `400` built from the path alone, with no query behind it.

**Where it stands.** social-service is whole: 32 controllers with a path parameter, all declared.
[core-service](core-service.md#path-parameters-are-declared-2026-11-14),
[media-service](media-service.md#path-parameters-are-declared-2026-11-14) and
[chat-delivery](chat-delivery.md#path-parameters-are-declared-2026-11-15) carry the same guard and
a coverage spec of their own: the four Nest services are whole (call-service and chat-gateway are
Rust). Query parameters are not covered: they are optional and typed by their DTOs.

**One file, one copy per service.** The Nest services share no TypeScript package, and their common
guards have always been a copy each, so `src/common/route-params.ts` is copied and declared in
`.github/scripts/lib/declared-duplicates.mjs`: `declared-duplicates.test.mjs` holds the copies
byte-identical, and the one spec of the guard sits beside the first copy, here. What is per service
is the wiring, held by `.github/scripts/tests/route-params-wired.test.mjs`: a service that carries
the guard provides it in its `AppModule`, has its own coverage spec, and is in the declared group.

### Posts (`/api/posts`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/posts` | List paginated posts (feed types: all / followed; `kind=reel\|post` optional; an expired reel is never served) |
| GET | `/api/posts/reel-limits` | CanaReels numbers: max duration, retention, warning window ([reels](reels.md)) |
| GET | `/api/posts/my-reels` | The caller's live reels with `expiringSoon` and `serverNow` ([reels](reels.md)) |
| POST | `/api/posts` | Create post (Markdown, optional poll or form, optional payment; `kind: "reel"` + `durationMs` publishes a CanaReel, see [reels](reels.md)) |
| GET | `/api/posts/:postId` | Get single post |
| PATCH | `/api/posts/:postId` | Update post (author only) |
| DELETE | `/api/posts/:postId` | Delete post (author or admin) |
| POST | `/api/posts/:postId/reactions` | Add/toggle emoji reaction |
| POST | `/api/posts/:postId/comments` | Add comment |
| PATCH | `/api/posts/:postId/pin` | Pin the post in ONE space, body `{ spaceId }` (WP-PIN, `SpacePinsService`): the platform admin, or `MODERATE` in that space's BDE; at most 3 shown per space ([spaces-and-audiences-reform](../spaces-and-audiences-reform.md#11-wp-pin---a-pin-is-a-promotion-per-space-not-a-global-flag-decided-2026-11-03)) |
| PATCH | `/api/posts/:postId/unpin` | Unpin the post from ONE space, body `{ spaceId }` |
| GET | `/api/posts/space-pins/:spaceId` | The governor's pins of a space, `shown` then `pending` ("en attente") |
| POST | `/api/posts/:postId/republication-requests` | Ask the AUTHOR of a personal post to let an association carry it (D38b; `POST_AS_ASSO` held, typed `REPOST_PERSONAL_*` refusals, [profiles-and-access](../profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built)) |
| GET | `/api/posts/me/republication-requests` | The caller's inbox of requests to answer (D38b); answered through `POST /api/associations/proposals/:id/accept` or `/refuse` (409 `PROPOSAL_SENDER_GONE` when the asker no longer speaks for the association) |
| GET | `/api/posts/me/republication-requests/count` | `{ pending }`, the count alone, for `/notifications` (D38b); like the inbox, it leaves out a request whose asker no longer speaks for the association |
| DELETE | `/api/posts/:postId/republications/:associationId` | Withdraw a republication: the republishing association, or the author of a personal post (D38b) |

**`:postId` is parsed as a UUID on every route (`ParseUUIDPipe`), so a malformed id is a `400`.**
`posts.id` is a Postgres `uuid`. Before 2026-10-02, a path segment that was not a UUID reached the
query, and Postgres's `invalid input syntax for type uuid` became an unhandled 500. A newer client
asking an older server for a route it lacks (`/api/posts/reel-limits`) landed on `GET :postId` and
logged a server ERROR. `posts.controller.post-id.spec.ts` reads Nest's route metadata, so a handler
added later without the pipe fails there.

### Channels and workspaces (`/api/channels`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/channels/workspaces` | Create workspace. `name` is a display name (trimmed, 1-80 characters, no control character - `validateDisplayName`, the rule a salon name shares), `slug` is what the client derives from it (`a-z0-9` groups joined by single hyphens, at most 48; the server appends `-2`, `-3`... to keep it unique); anything else is a 400 before any read or write, coded `COMMUNITY_NAME_INVALID` or `COMMUNITY_SLUG_INVALID`. Two limits are COUNTED FROM THE `workspaces` TABLE at each creation, so they hold across replicas and deploys (`community-limits.ts`): ten created by one account in the last hour (429 `COMMUNITY_CREATION_RATE`), and twenty held by one account as their creator (403 `COMMUNITY_OWNED_LIMIT`; the server setting `COMMUNITY_OWNED_MAX`, default 20). The client names all four through `describeCommunityRefusal` |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces; each carries `viewerCanManage` (true iff the caller holds MANAGE_WORKSPACE) and `viewerCanManageChannels` (`roleGrantsChannelManagement`: `channel.manage` or `workspace.manage`) so the client can gate admin controls without deriving permissions itself. Ordered by the caller's personal `sortOrder` |
| PATCH | `/api/channels/workspaces/reorder` | Persist the caller's top-to-bottom community order (`{ orderedIds }`, workspace ids). Personal per-member setting, stored on `channel_members.sortOrder` (migration 024) - not shared across members of the same workspace |
| GET | `/api/channels/workspaces/:workspaceId/members` | The whole community roster. Exists for the caller that holds no channel id - a device that has just joined the Graine distribution group and must name who to ask for history |
| GET | `/api/channels/workspaces/:workspaceId/nicknames` | Every nickname state of the community, set and cleared (dated), for a member of it ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)) |
| PUT | `/api/channels/workspaces/:workspaceId/nicknames/:userId` | `{ nickname: string \| null }`. A moderator names a member; the member may clear their own. Refusals `nickname_too_long`, `NICKNAME_REQUIRES_MODERATION`, `NICKNAME_TARGET_NOT_MEMBER`, `USER_BLOCKED`; announced on `workspace.updated { nickname }` (migration 149, columns read and written by raw SQL only) |
| PATCH | `/api/channels/workspaces/:workspaceId/history-visibility` | Set what a newcomer may read: `shared` or `joined`, MANAGE_WORKSPACE only. Stored on `channel_workspaces."historyVisibility"` (migration 039) and broadcast as `workspace.updated`. **The server enforces nothing here** - it holds no seed; members apply the rule ([channel-encryption](../protocols/channel-encryption.md)) |
| GET | `/api/channels/workspace/:workspaceId/user/me` | List channels in workspace for caller |
| POST | `/api/channels` | Create channel in a workspace |
| POST | `/api/channels/:channelId/messages` | Send encrypted channel message |
| GET | `/api/channels/:channelId/messages` | List messages newest-first (`limit`≤200, `before` ISO cursor) |
| POST | `/api/channels/:channelId/members/invite` | Invite user to channel |
| POST | `/api/channels/:channelId/members/leave` | Leave a **private** channel (drops the caller from `allowedUsers` and rotates the key). A public channel answers 400 - see "A channel-scoped action never touches community membership" |
| GET | `/api/channels/:channelId/members` | Roster of THIS channel (private = `allowedUsers` + admins); `?scope=workspace` for the whole community |
| DELETE | `/api/channels/:channelId` | Delete a salon outright - its row, its `channel_messages` and its distribution group. MANAGE_CHANNEL **or** MANAGE_WORKSPACE, and no confirmation argument - see "Deleting a channel" |
| DELETE | `/api/channels/workspaces/:workspaceId` | Delete a whole community for every member, irreversibly. MANAGE_WORKSPACE **only**, and the body must carry `{confirmationName}` equal to the community name or it is refused with `WORKSPACE_CONFIRMATION_MISMATCH` - see "Deleting a community" |
| DELETE | `/api/channels/workspaces/:workspaceId/members/:userId` | Remove a member from the whole workspace (MANAGE_WORKSPACE / MANAGE_CHANNEL / KICK_MEMBERS). Optional `?actorDevice=`: the actor's committing device, echoed as `actorDeviceId` in `channel.member.kicked` |
| POST | `/api/channels/workspaces/:workspaceId/members/:userId/removal-released`, `/api/channels/:channelId/members/:userId/removal-released` | The actor of a removal RELEASES the key-group Remove it claimed and knows it did not commit; `?actorDevice=` (the releasing device) required, same permission as the removal, `409` while the person is still in the scope, `503` when it cannot be announced, throttled per user (60/min). Publishes `channel.member.removal-released` with `releasedBy` and `releasedByDevice` ([channel-encryption](../protocols/channel-encryption.md#the-actor-of-a-removal-commits-it---2026-10-27)) |
| PATCH | `/api/channels/workspaces/:workspaceId/members/:userId/role` | Set a member's workspace role, replacing existing roles (MANAGE_WORKSPACE / MANAGE_ROLES) |
| GET \| PATCH | `/api/channels/:channelId/access` | Get/set channel visibility (`isPrivate`), `allowedUsers`, and `writePolicy` (MANAGE_CHANNEL to write) |
| GET \| PATCH | `/api/channels/roles/:roleId/permissions` | Read a role's base permissions; **PATCH** grants/revokes ONE key (`{key, granted}`). The whole-list PUT is gone since `minClientVersion` 1.2.7. MANAGE_WORKSPACE / MANAGE_ROLES |
| DELETE | `/api/channels/:channelId/messages/:messageId` | Delete a channel message: own always, someone else's with `channel.moderate` |
| POST | `/api/channels/:channelId/messages/:messageId/pin` | Pin or unpin a message: `channel.moderate` for EVERY message, own included (2026-10-05) |
| POST | `/api/channels/:channelId/messages/:messageId/poll/vote` | Vote on a poll (empty = retract) |
| PATCH | `/api/channels/:channelId/messages/:messageId/poll/close` | Close a poll now (author or moderator); forces the deadline + unpins. Answers the poll with `closed: true` - see "Channel polls" |
| GET | `/api/channels/:channelId/notification-level` | Caller's push level for the channel |
| PATCH | `/api/channels/:channelId/notification-level` | Set push level (`all` \| `mentions` \| `none`) |

#### Roles, membership and channel access

Communities use a deliberately simple, two-level model (no per-channel permission overrides):

- **Workspace roles.** Every workspace seeds three roles - `Administrateur` (priority 100, all
  permissions incl. `workspace.manage`), `Modérateur` (50), `Membre` (10) - stored in
  `channel_roles.permissions` (unified keys, e.g. `channel.moderate`, `role.manage`). Admins/roles are
  managed from the community settings modal: invite + assign a role, change a member's role
  (`PATCH .../members/:userId/role`, replaces all held roles), remove a member
  (`DELETE .../members/:userId`), and edit each role's base permissions
  (`PATCH roles/:roleId/permissions`, one key at a time). `workspace.manage` implicitly grants
  every permission. **The write is a DELTA on purpose**: a grid cell IS one key, and sending the
  role's whole list made two administrators' compatible edits erase one another - COMM-20 measured
  it on production, with the loser's grid left showing a permission the server had dropped and one
  it had never stored. Every change is announced on `workspace.role.permissions`, so no open grid
  keeps drawing what a role used to grant.
- **Channel access.** `canAccessChannel`: a **public** channel is readable by every workspace
  member; a **private** channel is readable only by users listed in `channels.allowedUsers` **plus**
  any admin (`workspace.manage`) - admins reach every channel without being explicitly added.
- **Making a salon private grants whoever did it** (2026-09-27), in `updateChannelAccess`, as
  `createChannel` grants the creator of a salon created private. The settings panel writes the
  allowlist ONE MEMBER AT A TIME, AT ONCE - "Ajouter" is final like the trash beside each row - and
  offers it only once the server holds the salon private, so a flip always arrives with an empty
  list. Before that, "Ajouter" only staged a local list that "Enregistrer" sent: production showed
  a member added, a reload, and no `PATCH /access` in five hours of edge log.
- **"Enregistrer" is gone from the panel entirely (2026-09-28).** The visibility toggle and the
  write-policy picker now write themselves the moment they change, the same way the allowlist
  already did: the toggle behind a confirmation dialog (it changes who can read the channel), the
  write policy without one, optimistic and reverting on failure like the per-channel notification
  level. Nothing on the tab is deferred to a button anymore.
- **Channel roster.** `GET /:channelId/members` answers the CHANNEL's members, not the workspace's:
  for a private channel that is the same set `canAccessChannel` admits, resolved from the roles the
  handler already loaded rather than one query per member, and the caller is refused outright if
  they cannot read the channel. `?scope=workspace` returns the community roster instead - the
  channel settings panel needs it, since the picker that grants access to a private channel must be
  able to offer people who are not in it yet. Getting this wrong is visible: the members sidebar
  listed all nine people of a community in a channel only five of them could read.
- **Write policy.** Independent of read access, `channels.writePolicy` (migration 031) gates
  posting: `everyone` (default), `admins_moderators` (roles with `channel.moderate`, `channel.manage`
  or `workspace.manage` - `roleGrantsModeration`), or `admins` (`workspace.manage` only). Enforced in `sendMessage` via
  `writeStandingIn`; used for announcement-style channels. Set from the channel settings "Accès" tab.
  **`writePolicyAllows` in `permissions.ts` is the only definition of the rule**, and every caller
  reads it: `writeStandingIn` per message, `getWorkspaceBySlug` for the `viewerCanWrite` it projects
  on every channel, `writeDecisionsFor` when the policy changes, `writeVerdicts` on a role change and
  `rolesQualifyingFor` for the access panel. The client is sent DECISIONS and never applies the
  policy - it holds no roles to apply one - and `ChatArea` replaces the composer with the line saying
  WHO may write (`writePolicyLine`) when the answer is no. Absent means YES, deliberately: a client
  too old to be sent the field fails open onto the server's refusal, which is the guarantee.
- **A refused post is TYPED and LOGGED (2026-11-10).** Production: a member of a community's
  Moderateur role, in an "admins and moderators" salon, had a composer and every post came back
  "no permission"; the role had been emptied of every permission (each revoke is one grid click,
  logged `[ROLE] revoked <key> role=<id>`), so the rule was right and nothing said so. Now each
  `ForbiddenException` of `sendMessage` logs one `[SEND] refused` WARN naming the cause (not a
  member, no access, or `write policy <policy>` with the sender's role ids and
  `grantsModeration`/`grantsManage`); the policy refusal carries `CHANNEL_WRITE_REQUIRES_MODERATION`
  or `CHANNEL_WRITE_REQUIRES_ADMIN`, which the client maps to "only admins (and moderators) can post
  here" and uses to take the stale composer away (`handleChannelWriteRefused`).
  `workspace.role.changed` carries `canWriteByPolicy` (the verdict for each of the three policies),
  and every salon row keeps its `writePolicy` (listing, `channel.updated`) to look its own verdict
  up - before this, a role edit moved the three cached flags and left every composer where it was.
  **And the sidebar's own listing (`listChannelsForUser`) never carried `viewerCanWrite` at all** -
  only `getWorkspaceBySlug` did - so every load drew a composer in every restricted salon; it now
  projects `writePolicy` and `viewerCanWrite` like the community page, and `channel.member.joined`
  (one helper, `announceSalonJoined`, split by verdict) and `createChannel`'s answer carry both, so
  a row added live knows its policy too.
  The access read (`getChannelAccess`) carries `writerRoles`, the roles each restricted policy admits
  by what they grant; the panel names them under the select and warns when "admins and moderators"
  admits the administrators alone.
- **A change is ANNOUNCED, split by the answer.** A listing is fetched once, so `viewerCanWrite`
  alone left everyone already in the salon holding a stale composer until their next full load -
  COMM-7 failed twice for this, the second time on the fix for the first. `updateChannelAccess` now
  publishes `channel.updated` carrying `viewerCanWrite`, **once per distinct verdict**: one payload
  cannot carry a per-viewer answer, so the audience is partitioned and each half addressed with its
  own. Two publishes at most. `writeDecisionsFor` costs two queries whatever the community's size.
  The audience is read AFTER the save, so a salon that has just become private announces to its new
  roster only. On the client, an ABSENT `viewerCanWrite` means unchanged - `renameChannel` reuses the
  same event and must not silence anybody's composer.
- **A role change is PUSHED to the member it concerns, and to nobody else.** COMM-5 measured that a
  promotion landed correctly on the server while the peer's own client only learned of it on a full
  reload - harmless upward, wrong downward, since a demoted administrator goes on being offered every
  control they just lost for as long as their tab stays open. `workspace.role.changed` carries the new
  role's WHOLE permission set and the client applies it rather than refetching: a refetch can fail, can
  be declined while a load is already in flight, and would return exactly what the event already
  carries. Best-effort and logged - the role is written before the announcement is attempted, so a
  failed publish leaves the member where they were. **The invariant this rests on, written down because
  nothing enforces it:** the client caches exactly three permission-derived values, `viewerCanManage`,
  `viewerCanManageChannels` and `viewerCanModerate`, and the event carries all three as DECISIONS
  (`canManage`, `canManageChannels`, `canModerate`; an absent one means unchanged) - a fourth cached
  flag owes a fourth field here, never a derivation from `permissions` on the client. The invariant
  was already broken once: `viewerCanModerate` was cached and never announced until 2026-10-05.
  **And broken a second time at the other source of the cache: `createWorkspace`'s answer** named
  `viewerCanManage` and `viewerCanManageChannels` and omitted `viewerCanModerate`, so the creator of
  a community was offered no "Epingler" (and no close on another member's poll) until a reload
  (2026-10-13). The answer now derives all three from the seeded Administrateur role through the
  listing's own predicates; any path that inserts a workspace into the client owes all three.
- **Editing what a role grants re-announces its HOLDERS' standing** (2026-09-29). `workspace.role.permissions`
  only redraws the grid, so granting `channel.manage` to Moderateur left every moderator without the
  salon controls until a full load, and revoking it left them offered controls that fail.
  `announceStandingToHolders` sends the same `workspace.role.changed` to the role's holders, split by
  verdict (eight publishes at most - three flags - never one per member).
- **The salon settings panel offers only what the server would accept** (reported by the user
  2026-09-29): a plain member was shown visibility, write policy, allowlist, rename and delete, each
  refused with a 403 behind a confirmation. `ChannelSettingsPanel` reads `viewerCanManageChannels`;
  without it the access tab is read-only (the settings are still READABLE - `GET :id/access` answers
  any reader) and rename/delete are absent. `roleGrantsChannelManagement` (`permissions.ts`) is the
  ONE definition behind create, rename, delete, the access write and the flag, which were four inline copies.
- **Three roles ARE the product** (decided 2026-08-20). The settings grid renders a permission matrix
  over whichever roles a workspace has - the three seeded ones - and offers no way to add a fourth;
  `ChannelService.createRole` was dead client code and is deleted. `POST /channels/roles` is KEPT
  because it is the only way a custom role can exist at all, and the grid renders whatever roles exist,
  so a role made through the API degrades into read-and-edit rather than breaking anything. **The one
  wart:** `normalizeRoleLabelToCanonical` folds any unrecognised role name to `member`, so such a role
  shows in the member list as "Membre" while holding whatever permissions it was given - a display
  fault waiting for the day somebody uses the route.

#### A community may name its three roles (owner, 2026-11-08)

The three roles stay fixed (identity, permissions); each community may give them **display names**
("Presidence", "Bureau", "Musicien"). LABELS ONLY.

- **Storage: a separate nullable column, `channel_roles."displayLabel"` (migration 150, varchar 40),
  never the existing `name`.** `name` is the role's IDENTITY (the names `createWorkspace` seeds:
  Administrateur, the accented moderator name, Membre): `mapRoleInputToWorkspaceRoleName`, invitations, assignment and every client of
  `minClientVersion` 1.6.6 resolve a role from it, and `normalizeRoleLabelToCanonical` folds an
  unknown name to `member`. Writing a free-text label into `name` would show an administrator as
  "Membre" on an old client (and break the by-name lookups). With its own column an old client ignores the
  field it does not know and sees exactly what it saw before; the listing (`roles`) simply carries
  `displayLabel` beside `name`. NULL = no name of its own, every client shows the localized default
  (`chat_role_admin` / `chat_role_moderator` / `chat_role_member`).
- **Write: `PATCH /channels/roles/:roleId/label` `{ label: string | null }`** (`setRoleDisplayLabel`); the `label` KEY is required (`roleLabelOfBody`): a body without it is a 400, only an explicit null or blank resets.
  Only an administrator (`workspace.manage`, read under the community removal lock so a demotion
  committing meanwhile is honoured); anyone else is refused 403 `ROLE_RENAME_REQUIRES_ADMIN`. The
  client receives no role name to decide on: it mounts the editor from `viewerCanManage`, the existing
  decision flag. `validateRoleLabel`: trimmed, at most 40 code points, no control, invisible-formatting (`\p{Cf}`: zero-width, bidi, BOM, tag) or line-separator
  character (400 `ROLE_LABEL_INVALID`); a blank or null value RESETS. One name per role.
- **Live update: the existing `workspace.role.permissions` event** is the role's one public
  publish (`announceRoleToCommunity`) to the whole membership, shared by a permission edit and a rename,
  each carrying only what ITS write changed: a rename adds `label` (string, or null for the default), a
  permission toggle OMITS it, so a toggle's late publish cannot restore an old name. Absent `label`
  means unchanged on every client. A rename changes no standing, so no `workspace.role.changed`.
- **Nothing keys on a label.** Consumers audited: the roster rows and `normalizeRoleLabelToCanonical`
  read `name`; permission checks read `permissions`; invite and assignment lookups read `name`; the
  client folds `name` (never the label) through `canonicalRoleOf`; `mapRoleInputToWorkspaceRoleName`
  receives the canonical English/French input of the client. The ONE client resolver is
  `resolveRoleLabel` (`utils/chat/communityRoleLabel.ts`): the member list badges, the invite and
  role pickers, the permission grid headers and the editor placeholders all call it, from the store
  (`globalChannels.roleLabels`, keyed by role id) that the announcement keeps current. No push or
  notification text names a role. Tests: `role-label.integration.spec.ts` (PostgreSQL),
  `role-label.spec.ts`.

#### Message moderation (`channel.moderate`)

The role matrix advertises this permission as "pin or unpin any message, delete other members'
ones", and that is exactly what it does. `memberCanModerateMessages` is the single check, shared by
every entry point (`deleteChannelMessage`, `setMessagePinned`, `closePoll`); MANAGE_CHANNEL and
MANAGE_WORKSPACE subsume it via `roleGrantsModeration`. For delete and poll close the **author** is
allowed unconditionally and the permission only widens the action to *someone else's* message;
**a pin has no author exemption** (see below). Editing is never moderation - only the author can
edit, in channels as in DMs.

The workspace listing carries `viewerCanModerate` alongside `viewerCanManage` so the client can
decide whether to render the delete affordance on another member's bubble without probing the
API for a 403. It is a UI hint: the server re-checks on every call. `roleGrantsModeration`
(`permissions.ts`) is the one definition behind the check, the listing flag and the
`canModerate` field of `workspace.role.changed`.

##### Who may pin, and what the client offers (2026-10-05)

Reported by the user on 2026-10-05: a plain member pinned a message. **The rule, decided by the
user the same day:** in a salon, pinning or unpinning ANY message - the author's own included -
needs `channel.moderate` (or `channel.manage` / `workspace.manage`), because a pin shows on every
member's screen and an open pin list can be abused. Until then the author was exempt. A refusal is a
403 carrying `code: PIN_REQUIRES_MODERATION`, logged `[PIN] refused ... own=`; an accepted pin is
logged `[PIN]`. DMs and groups are untouched: a pin there is an MLS frame between equals that no
server sees, and anybody may.

**A poll is auto-pinned only when its author may pin (user, 2026-10-05).** `sendMessage` sets
`pinned` from the same `memberCanModerateMessages` grant `setMessagePinned` reads, decided on the
server and never from the client: a moderator's poll is pinned on creation, a plain member's is not
(logged `[POLL] not auto-pinned`). Closing a poll (`closePoll`, author allowed) and its deadline
still unpin it. Groups and DMs do not go through this service and are unchanged.

**What was wrong on the client.** Every menu gated delete on `isOwn || canModerate` and pin on
nothing, so a member was offered "Pin" on every message, saw it pinned optimistically, and had it
reverted silently after the 403 (and a refused UNPIN tying in the same millisecond was never
reverted). `mayPinMessage` (`frontend/src/lib/utils/chat/pinPermission.ts`) is now the one client
rule - in a salon, `viewerCanModerate` alone - read by the bubble menus (through `ChatMessageGroups`), the pinned banner's unpin and
`handleTogglePinMessage`; the revert is strictly later than the optimistic apply and a toast names
the refusal. `workspace.role.changed` also carries `canModerate`, so a demoted moderator stops being
offered pin and delete without a reload - it carried only the two other flags.

**Not settled without production:** which path the report took (own message, poll, or a role that
does grant moderation). The decisive reading is the pinned row - its `authorId` against the member,
`metadata ? 'poll'`, and the member's `roleIds` and those roles' `permissions` - and, from this
version on, the `[PIN]` log line.

Deletion drops the row (the content is a ciphertext the server cannot read, so there is nothing
worth tombstoning) and broadcasts `channel.message.deleted` (`{ channelId, messageId, deletedBy }`)
to the workspace, which is how other members' clients replace the bubble with the local
"deleted message" placeholder.

#### Channel polls, and who decides one is over

A poll lives in its message's `metadata.poll` (`ChannelPollMeta`): the question, the options, the
per-option voter lists and an optional `endsAt`. Voting is `POST .../poll/vote` (an empty selection
retracts), closing is `PATCH .../poll/close`, which stamps `endsAt = now`, unpins the message and
broadcasts the new state on `channel.poll.vote` - the same frame a vote publishes, because both say
the same thing: here is the poll as it now stands.

**HOW A POLL ENDS - TWO WAYS, DECIDED BY THE USER 2026-10-12.** (1) An OPTIONAL end date chosen at
creation (`PollComposerModal`'s deadline field, cleared by default; no maximum and no default
duration), stored as `endsAt`. (2) A manual close, `PATCH .../poll/close`, by the poll's AUTHOR or
anyone holding `channel.moderate` (or `channel.manage` / `workspace.manage`) - the salon's admins;
anybody else gets a 403. A poll with no end date and nobody closing it stays open for ever, which is
the accepted consequence of "optional, no default". Either way the server refuses votes from then on
(`pollIsOver`), serves `closed: true`, and the card shows its results with no vote form. Until
2026-10-12 the client offered "Clore le sondage" to the author ONLY (`MessageBubble` gated it on
`isOwn`), so a moderator could close through the API but not from the app; it now reads
`isOwn || canModerate`, the server's pair. The salon's "N sondage actif" shortcut used to count from
the encrypted message alone, so a poll closed early stayed in it; it now reads this service's
`closed` and `endsAt` (`utils/chat/activePolls.ts`) and drops an end date the moment it arrives,
through the same one-timer `pollDeadlineClock` the card uses. That clock measures the next deadline
from NOW, not from the instant it last moved: `ChatArea` is never remounted, so measured from a stale
instant a poll posted hours later was scheduled hours late and stayed in the shortcut past its end
(`pollDeadline.svelte.test.ts`)
([chat](../frontend/modules/chat.md#the-jump-is-instant-because-a-smooth-one-was-cancelled-by-the-tap-that-asked-for-it-2026-10-12)).

**What a client is served is not what is stored.** `ServedChannelPollMeta` adds one field,
`closed`, and it is the server's own answer to "is this over?" rather than the input a client would
need to compute it. `endsAt` is an instant on the SERVER's clock; a client comparing it to `Date.now()`
is asking the question with a different clock, and the margin is zero exactly when it matters. A poll
closed *now* carries the server's now and is read a few hundred milliseconds later against a client
clock a little behind it, so the comparison comes out false - and since the comparison lives in a
`$derived`, which is not reactive to time, nothing ever re-runs it. Measured on production on
2026-08-25 (COMM-15): both clients rendered a freshly closed poll as "0 min restante(s)"
indefinitely while this service refused every vote into it with a 403. The service already had to
decide closedness to issue those 403s, with the clock that wrote the field; `closed` is that decision
carried to where it is rendered.

`closed` is stamped at every hand-out site - the history page, the `channel.message.created`
broadcast, and the vote and close responses and their broadcasts - by one helper, `servedPoll`. It is
**never persisted**: it is true of an instant, not of the row, and the durable fact stays `endsAt`.
The opportunistic auto-unpin uses the same predicate, so a poll cannot be unpinned for being over
while being served as open.

**AND THE HALF `closed` CANNOT COVER IS THE DEADLINE ARRIVING WHILE THE CARD IS ON SCREEN**, closed
client-side on 2026-09-24. `closed` is true of the instant it was stamped, and a client that is
already holding the card never asks again - so a poll whose `endsAt` simply came round kept showing
its vote form until an unrelated redraw, and a tap then earned exactly the 403 this field exists to
prevent. The deadline is KNOWN, so the moment it becomes interesting is known too: the client
schedules ONE timer per card at the earliest `endsAt` still ahead (`pollDeadlineClock`,
[posts](../frontend/modules/posts.md#a-deadline-that-arrives-while-the-card-is-on-screen-2026-09-24)),
not an interval and not one per poll. **The asymmetry is what makes that safe where the old
comparison was not**: a skewed comparison produced a verdict of "still open" that nothing would ever
revisit, so its error was permanent, while a skewed DELAY moves the moment the form closes by a few
hundred milliseconds, once. The client flip is also one-way - it can only add closure to what this
service said, never remove it - and this service remains the only thing that decides whether a vote
is taken.

#### Message reactions

**A reaction is an encrypted channel message (WP-40, 2026-08-18).** It is sealed under its sender's
Graine session like any other body, so the server counts nothing and stores nothing readable. The
endpoint, the `channel.reaction` broadcast and `channel_messages.reactions` are GONE - the tally used
to be cleartext `emoji -> [userId]` (migration 034, dropped in 040), which meant a server that could
not read "j'arrive" could still see that eight people put a heart on it.

What the server keeps is one boolean, `channel_messages.silent`: whether a row may ring a phone. It
says nothing about what the row contains, and it does two things. A silent row gets **no push
fan-out** - the author is still told, by the client, through the same targeted push a DM reaction
uses. And `GET /:channelId/messages` fills its page with **non-silent rows**, then adds every silent
row newer than the oldest of them: without that split, a burst of reactions would push real messages
out of a 200-row page, and a channel would show less history the more people reacted in it.

Clients merge the frames with the same convergent rule the DM path uses - last-write-wins per
`(user, emoji)` pair on the sender's `at` - so the order a page is read in cannot change the result,
and a frame seen twice changes nothing. The distinct-emoji cap (15) is enforced where the user ACTS
and never in the merge: a frame that arrived is something the community did, and a device that
refused it would drift from one that accepted it. Full reasoning:
[channel-encryption](../protocols/channel-encryption.md).

#### Reading a community by slug

`GET /workspaces/by-slug/:slug` (`getWorkspaceBySlug`) returns one community with its channels,
members and roles, plus the server-computed `viewerCanManage` / `viewerCanModerate`. It is
**members only**, and it must stay that way: a slug is not a secret - it is in every invite link
and the invite preview returns it before you join - so membership, not knowledge of the slug, is
the authorization.

Its channels are **projected field by field** (`id`, `workspaceId`, `name`, `visibility`,
`writePolicy`), never returned as entities. The rule was written after `Channel.masterSecret` - the
32-byte HKDF root every epoch key derived from - reached callers because the read spread the entity,
making a slug sufficient to decrypt the whole channel history. That column is gone (WP-51) and the
rule is not: `allowedUsers` is the private-channel roster, and the next column nobody thought about
will be added by someone who is not reading this page. The list is filtered by
`canAccessChannel`, the same rule `listChannelsForUser` applies, so a private channel the caller
may not read is absent rather than merely unusable - which is also what lets the accepted-invite
page pick a landing channel from it safely.

Any new endpoint returning a `Channel` must project the same way. Nothing in the framework
strips it: there is no `ClassSerializerInterceptor` and the entity carries no `@Exclude`.

#### Deleting a community

`DELETE /api/channels/workspaces/:workspaceId` (`deleteWorkspace`) is the only way a community
disappears. It is **admin-only**: unlike a kick or a channel deletion, MANAGE_CHANNEL is
deliberately not accepted, because the action hits every member at once.

**It is a hard delete, since 2026-08-18.** It calls the same `hardDeleteWorkspace` the last member
leaving calls: one transaction over `channel_messages`, `channel_members`, `channel_roles`,
`workspace_invites`, `channels`, `channel_workspaces`, after the distribution group is deleted in
chat-delivery. Four endings, one code path - so a table added to that list is added for all four.

It used to archive, flipping `channel_workspaces.archived` (migration 033), on the reasoning that
recovering a community deleted by mistake was then two `UPDATE`s. Graine ended that: an archived
community's messages are ciphertext whose seeds no client keeps, so what the two `UPDATE`s would
restore is rows nobody can read - occupying the name and the slug, invisible to every screen, and
no longer deletable through any route, since deleting needs a member and the UI lists only
communities you are in. That is the orphan shape the 2026-08-17 purge had to find by hand.

#### Deleting a channel

`DELETE /api/channels/:channelId` (`deleteChannel`) removes the salon's row, every
`channel_messages` keyed by it, and - first of all - its distribution group. **MANAGE_CHANNEL is
enough**, where the community demands MANAGE_WORKSPACE: a salon is one room, and governing rooms is
what that permission is.

**It archived until 2026-08-20, which was the community's own defect one scope down.** The call set
`channels.archived = true` and, in the same breath, destroyed the group holding the salon's seeds -
so a private salon survived as ciphertext no client keeps a key for: hidden from every listing,
unreachable by every route, with no un-archive anywhere in this service and no way to remove the
rows short of deleting the whole community. `deleteWorkspace` had rejected exactly that shape two
days earlier. Both `archived` columns went with it (migration 046): `channel.archived = true` was
the last writer of either, so `channel_workspaces.archived` had been a constant that a dozen `WHERE`
clauses still consulted since 2026-08-18.

**The group is destroyed BEFORE the transaction, and is allowed to abort it.** It lives in
chat-delivery and cannot join the transaction, so the alternative is a group nothing on earth still
names - the orphan the 2026-08-17 purge had to find by hand. A failure here leaves the salon whole
and the deletion retryable, and publishes no `channel.deleted`: a client told the salon is gone
drops it and never asks again. Same rule as `hardDeleteWorkspace`, `createWorkspace` and
`ensureChannelDistributionGroup`.

**No `confirmationName`, and the asymmetry is a measurement.** See "Deleting a channel took no new
argument, deliberately" below.

**The event reaches the salon's roster, not the community.** `channelAudience` is snapshotted before
the delete, since it reads `allowedUsers` off the row about to go. An administrator who never joined
a private salon is not on that roster and gets no event - the 2026-08-19 decision working, at the
cost of a stale sidebar entry until their next load ([backlog](../backlog.md)).

**The confirmation is enforced here, not only in the dialog.** The request must carry
`confirmationName` equal to the community's name (both trimmed, otherwise exact) or it is refused
with `WORKSPACE_CONFIRMATION_MISMATCH`, before the distribution group call. The reason is the
fleet, not defence in depth: clients built while this route archived send no such field, and their
"are you sure?" was worded for a reversible action. An argument they do not send is what makes them
fail closed instead of destroying a community behind a warning that no longer describes what
happens. The name is a confirmation token, never a selector - the workspace is chosen by the id in
the path - so the two communities on prod that share a name are not ambiguous here.

The audience is snapshotted **before** deleting, then `workspace.deleted`
(`{ workspaceId, deletedBy }`) is broadcast to it, so connected members purge the community from
their sidebar and drop its channel conversations without polling. Frontend:
`handleWorkspaceDeleted` in `useChannelWorkspaces.svelte.ts`, which shares its
`purgeWorkspaceLocally` helper with the leave and delete UI paths.

The legacy per-channel/per-role override system (`channel_permission_overrides`,
`channels.usePermissionOverrides`) was removed in migration 032.

#### Channel history and full-text search

`GET /:channelId/messages` returns the newest messages first, capped at 200 per page. Passing
`before=<ISO createdAt>` returns only strictly-older messages (keyset pagination on `createdAt`),
so clients page back through the whole channel by following the oldest `createdAt` of the previous
page until an empty page is returned. Channel messages are not persisted one by one client-side (only a copy of the last page a load drew is kept, [F4](../frontend/community-open-budget.md#f4-built-2026-10-15)), so full-text
search fetches and decrypts the entire history on demand (`ChannelService.fetchAllChannelMessages`
-> `useConversations.searchChannelHistory`, capped at ~2000 messages) and merges the decrypted rows
into the open conversation so a hit older than the loaded page can be scrolled to. The server only
ever sees ciphertext; matching happens on the decrypted preview text in the browser.

#### Channel push notifications

Sending a channel message fans out FCM pushes to workspace members (background + app killed), via
chat-delivery's `/internal/push/notify`. Each member has a per-channel level stored on
`channel_members.notifLevels` (`all` default, `mentions`, `none`); `mentions` is routed from a
cleartext `mentionedUserIds` list the sender attaches (metadata-only; content stays encrypted). The
push carries the ciphertext inline; the native layer derives the message key from the Graine seed
mirrored to `graine_seeds.json` and decrypts locally (so plaintext never transits FCM). The mirror is
bounded to the newest sessions per channel: a miss degrades the banner to "new message in #salon",
which is the same outcome an oversized ciphertext already produces. See the frontend chat module for
the mirror and the per-channel level selector.

**The payload is exactly what a client reads: `type, channelId, channelName, workspaceName,
senderSessionId, messageIndex, ciphertext, nonce, senderId` plus a per-recipient `mentioned`.** Three more fields
(`workspaceId`, `messageId`, `createdAt`) travelled with it until 2026-08-16 and were read by none of
the three native handlers - dropped rather than left looking like a contract. `workspaceId` was a
uuid no native surface can turn into a community name (there is no workspace mirror the way
`graine_seeds.json` mirrors the seeds); `workspaceName` replaced it because it is what the title
actually needs. `messageId` / `createdAt` cannot repeat what the MLS path does
with them: that path writes `fcm_message_cache.ndjson` so a background-decrypted message is already
in the store at open, whereas a channel message is DELIBERATELY never persisted one by one
(`useMessaging` skips the DB save for a `channel_` conversation - channels are server-authoritative
and refetched over HTTP; only a copy of the last page a load drew is kept, replaced by every load,
[community-open-budget F4](../frontend/community-open-budget.md#f4-built-2026-10-15)), so the cache
has nowhere to inject. Fewer bytes also buys headroom under
the same ~4 KB FCM cap the inlined ciphertext competes for (over 3000 chars it is omitted and the
notification degrades to the generic body). The whole contract is pinned in both directions by
`frontend/src/lib/mobile/channelPushFields.test.ts`, which reads the four source files.

**The title of a salon notification is `<Communaute> - #<salon>`** (decided 2026-08-16). A salon name
alone is ambiguous - two communities may both have a `#general` - and `workspaceName` is resolved
server-side because nothing downstream can: the payload once carried the workspace uuid and no client
holds a workspace mirror. FOUR processes can put this banner on a screen and each spells the format
itself: `ChannelService.buildChannelPushTitle` (the APNs alert title, which is what an iPhone shows
when the extension cannot run), `CanariFirebaseMessagingService.buildChannelPushTitle`, the iOS
Notification Service Extension and `canari_push.mm`. No compiler spans the four, so
`channelPushFields.test.ts` asserts the separator on all of them. A workspace row that cannot be
found degrades the title to `#<salon>` alone and logs `[CHANNEL_PUSH] workspace=<id> not found` at
ERROR - the community disappearing quietly would be indistinguishable from never having been asked
for.

**`mentioned` is the one fact only the server holds**, and all three clients read it since
2026-08-16: Android posts on `canari_mentions` (IMPORTANCE_HIGH, bypass-DND), both iOS paths set
`interruptionLevel = .timeSensitive`. The MLS path has to scan the decrypted text for `@[<uuid>]`
because the server cannot read it; a channel message carries the sender's cleartext
`mentionedUserIds`, so the device is TOLD - which is also the only answer that survives a push whose
ciphertext was too large to inline, where there is no text to scan.

Tapping a channel notification opens the deep link `fr.emse.canari://chat/channel_<uuid>`. Because
channels live under `/communities` (not `/chat`), the deep-link handler routes by target type
(`chatDeepLinkRoute`): a `channel_` target goes to `/communities` and sets the selected channel so
the sidebar reveals its community and the members panel loads; DM/group targets go to `/chat`.

Cross-device read dismissal: opening a channel that had unread messages calls
`POST /api/channels/:channelId/read`, which fans out a silent `channel_read` push (via the same
internal push path) to the caller's own devices. Every device that receives it cancels that
channel's notification (`cancelConversationNotification("channel_<uuid>")`) - in front as well as
in the background since 2026-11-20 (`ForegroundGuard`, below). This mirrors the MLS DM/group
behaviour, where a self read-receipt push clears the conversation's notification on the user's
other devices.

#### Read receipts in a salon

**A salon had none until 2026-09-29** (reported by the user): a DM's receipt is an MLS watermark, a
salon has no MLS group, and the client simply skipped it - while `READ-6` asserted that absence and
read `PASS`. The same watermark now lives on the server: `channel_members."readMarks"` (jsonb keyed by
channel id, migration 066), one instant per reader, only ever raised.

- `POST /api/channels/:channelId/read-mark` `{ at }` - `advanceChannelReadMark`. `at` is a message's
  server `createdAt` in epoch ms (which IS a salon message's timestamp on every client), BOUNDED by the
  salon's newest message because a max-merge cannot take a future value back. One `UPDATE` whose
  `WHERE` carries the comparison; when it moved, `channel.read` `{ channelId, workspaceId, userId, at }`
  goes to `channelAudience` (the reader's own devices included, which is what moves their badge).
- `GET /api/channels/:channelId/read-marks` - every CURRENT reader's mark; the client reads it beside
  every history page, since live events only carry what moved while it was connected.
- Distinct from `POST :id/read` above, on purpose: that one dismisses this account's notifications
  on arrival; the receipt waits for the same focus guard and leading-edge 2 s throttle (sent at once, burst coalesced) as a DM's
  (`MainChatPage`), so a phone in a pocket never tells a sender it read anything.

The client merges both into the conversation's `readWatermarks`, so "Lu par", the avatars and `+N`
render through exactly the group code. No read tone for a salon.

**A salon row is dated by its `createdAt` on EVERY client path (2026-10-12)**, because every mark is
on that clock. Until then the live path (`channel.message.created`) dated a row by `createdAt` and the
history load (`decodeChannelMessageRow`) dated the SAME row by the author's `sentAt`; the merge takes
the page's copy, so the row's key flipped with whichever path wrote it last. When the author's clock
LEADS the server's, `sentAt > createdAt` and the row lands past the mark of everyone who read it (the
server bounds a mark by the newest row's `createdAt`): the "seen by" heads under the last message
vanished at every history load and came back with the next live write - the flicker the user
reported. Measured in prod the same day: 207 `[CHANNEL_READ] mark past the newest message bounded`
in seven days, 26 distinct messages, 59 readers, gap 0.1 s to over 10 s (193 under 1 s). The same
skew made the reader's own device re-POST the identical mark at every load, since its own mark (the
server's, `createdAt`) never reached the row's `sentAt` key. Pinned by `salonRowClock.test.ts` (heads
under the last message: 2 before the reload, 2 after; 0 before the fix).

**"Mark as read" from a salon NOTIFICATION, app shut (Android, 2026-10-10).** A shut phone has no session, so the two public calls above are out of reach. Its action calls chat-delivery's `POST /api/mls/push/channel-read` `{ userId, deviceId, channelId, at }` under `Authorization: PushSecret` (which proves the caller is a device of `userId`); chat-delivery forwards it with `x-internal-secret` to `POST /api/internal/channels/:channelId/read` (`InternalChannelReadController`, never exposed by the edge), which runs `advanceChannelReadMark` (membership still checked here, `at` bounded by the newest message) and then `markChannelRead` so the user's other devices clear their banner. `at` is the notification's own `createdAt`, never the phone's clock. A refused or failed call is logged on both sides (`[CHANNEL_READ_PUSH]`) and never retried: the banner is already gone locally and the receipt rises the next time the salon is opened. The same controller answers chat-delivery's second salon question, `POST /api/internal/channels/:channelId/reader` `{ userId }` -> `{ reader }` (`ChannelService.isReaderOfChannel`: a public salon's community member, a private salon's reader), which gates a salon reaction's push to its author - a "no" is logged `[SALON_READER] ... is not a reader` once per user and salon, then at each power of ten (`common/log-repeat.ts`) ([chat-delivery](chat-delivery.md#the-relay-routes-ask-the-group-2026-11-01)). Reply is NOT offered on a salon: see [mobile](../frontend/mobile.md#a-salon-mark-as-read-only-and-why-reply-is-not-offered-decided-2026-10-10-android).

**Clearing a community without reading it (2026-10-13).** `POST /api/channels/workspaces/:workspaceId/unread/clear` `{ upTo }` (`clearWorkspaceUnread`) raises `channel_members."clearedMarks"` (migration 082) for every salon the caller may read, in one statement, to `LEAST(upTo, the salon's newest createdAt)` and never lower; `listUnreadCounts` counts from the later of `readMarks` and `clearedMarks`. It never touches `readMarks` and never publishes `channel.read`: only `channel.unread.cleared` to the caller, and one silent `channel_read` push per salon that moved. The column is on the TypeORM entity with `select`/`insert`/`update: false` (raw SQL only): off the entity, `synchronize` DROPPED it at every local boot; as a plain column it would be in every membership `SELECT` during the deploy's window before migrations run. A salon with no message gets no mark (`LEAST` ignores a NULL, so it is filtered first; measured on Postgres). Why: [chat](../frontend/modules/chat.md#mark-a-whole-community-as-read-2026-10-13).

**Unread counts (2026-10-08).** `GET /api/channels/unread-counts` answers `{ asOf, counts: { [channelId]: n } }`
(zero absent): per salon the caller may read (`canAccessChannel`, so a private salon the caller is not in is
never counted), the rows that are not `silent` (reactions, edits and control frames are), not the caller's,
and with `createdAt` after `GREATEST(the caller's mark, the caller's membership, UNREAD_TRACKED_SINCE_MS)`.
`UNREAD_TRACKED_SINCE_MS` is a date, not a migration: seeding marks from the newest message was refused
because a mark is also the "Lu par" receipt other people see. `read-mark` accepts an optional `serverAt`
(the row's own `createdAt`) and stores the later of it and `at`, still bounded by the newest message - the
author's `sentAt` is earlier than `createdAt`, which left the newest message "unread" for ever. A
membership notice is sent silent (2026-10-18) and so is not counted; a salon at level `none` is left out and listed in `muted`
(see [chat](../frontend/modules/chat.md#a-muted-salon-and-a-membership-notice-raise-no-badge-2026-10-18)). The count is one LATERAL
per salon bounded by `createdAt >= since`, riding `IDX_channel_messages_channel_created` (migration 079):
300 ms on 1.5M rows / 300 salons with the old `channelId` index, 6 ms with it (EXPLAIN, `jit=off`). Why the client needs it:
[chat](../frontend/modules/chat.md#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08).

**The cancel keys on the notification's THREAD, not on an identifier we chose.** A conversation's
notification has two possible posters and they do not agree on an identifier: the in-app path
(`CanariShowLocalNotification`) uses `canari-<stableId>`, while the NSE — the only path that runs
when the app is killed, which is exactly when a read elsewhere needs cleaning up — posts under an
identifier the system assigned. Removing by `canari-<stableId>` therefore matched nothing on a
killed iPhone, and the badge was then recomputed from a set still containing the notification. Both
posters do set `threadIdentifier` to the conversation (`groupId`, or `channel_<uuid>`), so
`CanariCancelConversationNotification` enumerates the delivered notifications and removes by thread,
then writes the badge from what remains — computed from the array already in hand, since
`removeDeliveredNotificationsWithIdentifiers:` has no completion handler to wait on. Fixed
2026-08-16, together with the missing `apns` block that had kept the frame from arriving at all
(see [chat-delivery](chat-delivery.md)).

**Android has one KEY but had one cancel TRIGGER against two post triggers (fixed 2026-11-20).**
Both Android posters - the push (`CanariFirebaseMessagingService`) and the WebView's frame
(`notify_native_message` -> `notifyMessageFromWebSocket`, since 2026-09-18) - post under
`getStableNotifId(<conversation id>)`, the MLS group id or `channel_<uuid>`, so the ids always
agreed. The defect was the cancel: only a PUSH triggered it, and two things kept that push from
acting on a banner the WebView had posted while the app was open (owner's report: posted in front,
app sent to the background, read on the web, never removed - DMs, groups and salons alike):

- **a read the WebView took over its socket is never pushed.** The server pushes an MLS frame only
  when the device has not ACKed it within 10 s (`PUSH_DEFERRED`); an own `read_watermark` that the
  live WebView received and ACKed - app in front, or backgrounded and not yet frozen - produced no
  push, and the WebView itself cancelled nothing. Now the WebView is the cancel's second trigger:
  EVERY own `read_watermark` from another device (`systemMessageHandler`) and every own
  `channel.read` (`channelEventHandler`) calls `recordNativeReadElsewhere` -> `record_read_elsewhere`
  -> `readElsewhereFromWebSocket` on `WS_NOTIF_LANE`, with the mark. The call is made whether or not
  the mark MOVED the row: a mark the row already held (learned on a reconnect, before the banner was
  even posted) changes nothing in the WebView and still has to clear the shade. Whether the banner
  goes is decided on the native side, against the shade (below);
- **`channel_read` was dropped in front.** The foreground guard of `dispatchPush` let through only
  what shows in front, on the premise that the device in front is the one reading - but a phone in
  front showing another conversation holds that salon's banner. `channel_read` touches no `mls.bin`
  and now passes (`push/ForegroundGuard.kt`, pinned by `ForegroundGuardTest`).

**Measured on the Mi 9T against dev, 2026-11-20 (DM, before the fix):** a peer's message reached the
app in front over the socket and was posted (`notifyMessageFromWebSocket: queued`, `notifId=1001`);
the app went home (`onPause: isInForeground=false`); the same account opened the DM on the web
6 s later, whose read watermark the gateway routed in REALTIME to the phone's device, which ACKed
it - and chat-delivery logged no `PUSH_DEFERRED` for that send. Not one `FCM silent from self` for
that group followed, while the self receipts of other groups, un-ACKed, were pushed and cancelled;
`id=1001` was still in the shade a minute later. The salon half rests on the code (the guard
above); its bench run did not reach a posted banner.

**THE ORDER OF ARRIVAL DECIDES NOTHING: THE MARK TRAVELS WITH THE CANCEL.** Sharing a lane does
not order the two: the WebView's post is asynchronous BEFORE it reaches Kotlin (the sender's name is
resolved, the name files flushed), while the read covering it is handed over at once. A bare cancel
landing first found nothing to remove, and the post that followed stood for good. So the read
carries its mark (`at`, and whether it is on the server's clock) and Kotlin RECORDS it in
`push/ReadElsewhereMarks.kt` - on every own read, cancelling or not, since a late post of an OLDER
message must be refused even while a newer one stays unread. The comparison is on the server clock
when both the message and the mark carry it, on the stamped clock otherwise (a salon's stamp IS its
server time); a message comparable on neither is posted - a lost banner is a lost message. The
record is in memory on purpose: the race is between a post still being built and a read this
process was told about, and both die with the process.

**THE LINES DECIDE THE CANCEL, NOT THE WEBVIEW'S ROW.** The banner goes only when the mark covers
EVERY line the conversation's notification holds, on the same clock rule. Each line carries its own
instants in its extras (`LINE_SENT_AT`, `LINE_SERVER_AT`, written by `showMessageNotification`,
re-injected with the line on every later post - androidx core keeps a message's extras - and
restamped when a second trigger of the same message knows the server instant the first did not).
A REACTION's line is the exception: it carries no server instant (its `LINE_SERVER_AT` is 0), so no
mark weighs it - its notification follows the conversation instead (below, round 14).

**THE BANNER IS WHAT THIS PROCESS POSTED, NOT WHAT THE SHADE ANSWERS.** `notify` returns before
NotificationManagerService has enqueued the record (it posts a runnable to its handler), so the shade
read right after a post can still show the notification from BEFORE it. Weighed by a read, a banner
holding M1 while M2 was just posted would be cancelled (M2 lost), and a first banner would not be
found at all (a read banner left standing); re-injected by a post, two posts back to back would drop
the first one's line. So every post records the banner it handed to `notify` - its id, its channel,
its messages (`ReadElsewhereMarks.Banner`) - and both the next post and a read start from that
record (`bannerOf`); the shade (`shadeBannerOf`) answers only when this process has posted nothing
for the conversation, i.e. a fresh process whose banner an earlier one left.

- **One lock from the banner a post builds on to the record of what it posted.**
  `showMessageNotification` holds `READ_ELSEWHERE.lock` from the moment it reads the banner it
  re-injects to the end of its post; a read holds it across record, weigh and cancel. The lock is
  reentrant. Under a post it takes three LEAF locks, none of which ever takes it: `ALERTED_LOCK`
  (read only - `rememberAlerted`'s durable `commit()` and `refreshBadgeSummary` run after the lock
  is released), the ring sequencer's lock (`callHoldsSound`) and the `ConversationShortcuts.push`
  monitor (whose shortcut record is committed on purpose: the sign-out relies on it). Its blocking
  work is binder calls (the shade read, `notify`, `cancel`, the shortcut push), that commit, and
  building the notification from bitmaps loaded BEFORE the lock - no fetch under it. It may be
  taken while the generic-banner lock is held (the WebSocket path), never the reverse.
- **The cancel takes the id of the banner it weighed**, whichever source supplied it - the record,
  or the shade looked up by id inside the lock. (Round 5 found the id resolved only on the shade's
  branch, so the usual case cancelled id -1.)
- **The record goes with the banner, in ONE step with its cancel** (both under the lock - a post
  between them would be forgotten while it stands): a cancel by a read drops it, every other cancel
  `withdraw`s it, `cancelAllMessageNotifications` (the app coming to the front) `forgetAll`s, and the
  user's swipe does too, through the delete intent of a conversation banner
  (`ACTION_BANNER_DISMISSED`, then `forgetPostedBanner`) - otherwise the next post would bring back
  the lines the user dismissed.
  BOTH builders of a conversation banner - the message post and the pending reply's re-post - build
  it through ONE helper, `conversationBanner`, which sets that intent: the re-post once had none, and
  the next message rebuilt on swiped lines, a reply already delivered still marked `non envoyé`
  (device reading of #3912). A reaction is built without it.
  The intent names the notification's id and the record is forgotten only when it is that banner's,
  so a swipe of the conversation's reaction notification leaves it; a swipe that cold-starts a
  process with no record logs nothing (`forget` says whether it dropped one). A post whose dismissal
  broadcast has not been delivered yet still builds on the swiped lines once (they do not alert).
- **A banner this process removed is not asked of the shade again** (`ReadElsewhereMarks.withdrawn`,
  and every conversation after `forgetAll`): the shade lags a `cancel` as it lags a `notify`, so its
  copy is stale. A second dismissal of the same banner - a salon's `channel.read` on the socket, then
  its `channel_read` push - finds nothing and says so at debug only (`no notif`), where it used to
  log a second `notif removed`; a post rebuilds on nothing, and the pending reply's re-post does not
  bring the banner back. Two cancels BY ID close what that blind spot could hide (round-7 review):
  `forgetAll` cancels every banner it recorded by id under the lock (the sweep of the shade before
  it misses one posted just before), and `withdraw` with no banner known and nothing to keep still
  cancels the conversation's stable id, silently - the system orders a cancel by id after its
  `notify`, where a shade read is not ordered at all.
- **The pending reply** (`repostReplyPending`) asks the record FIRST, under the lock, for both its
  lines and its template (`Banner.posted`, the notification as handed to `notify`; the shade's only
  in a fresh process), records what it posts, so its bound (`takeLast`) is the record's too. No
  dismissal that cannot weigh lines removes it when the dismissal only announces a read elsewhere:
  the push's silent-from-self cancel passes `keepPendingReply`, and `ReadElsewhereMarks.withdraw`
  keeps a banner whose record (or, in a fresh process, shade) holds a `LINE_PENDING_REPLY` line - it
  removed one while the reply was still queued (device reading of #3912). Its delivery and the "mark
  as read" action remove it.
- **A delivered reply clears its notice, whichever path of a live process sends it.** The pending line carries its
  message id (`LINE_PENDING_REPLY_ID`), and `drainOutboxBackground` - the one drain every native
  send goes through: the quick reply, `OutboxRetryWorker`, a push-woken drain, the boot drain -
  calls `replyDelivered` for each entry it delivered, after the outbox lock and after the ids are
  durable. A LATE DELIVERY IS NOT A READ (round-8 decision, principle 2): only the line carrying that
  id goes - every peer line stays for a later read to weigh, and every other reply still queued
  stays pending. With no line left the banner goes - NOT its reaction notification, which a peer
  may not have seen (round-9 correction); otherwise it is rebuilt silently (`setOnlyAlertOnce`) from
  its own template, and left as it was - logged at WARN - when it has none. A banner the platform
  holds is re-posted with what the delivery LEFT, never with the delivered line (round 14, S-a: r0
  failed offline, the network came back, r2 was answered inline, and the drain delivered both - the
  held re-post used to draw r0's "non envoyé" again). A delivery also honours the read ALREADY
  recorded (round 16): a peer line the mark covers goes with the delivered line - [m1, r0], a read
  covering m1 kept the banner for r0, then r0 delivered: the banner is cancelled (re-posted empty
  when held), and m1 is never shown again.
- **The quick reply's success is ONE function** (`replyAnswered` in the receiver): the cache row,
  the answer on the banner (`answerReplyNotification`, `ReadElsewhereMarks.answerReply`), and the
  watermark. Answering is reading, so the peer lines its watermark covers go and the reaction goes - but a line of
  ANOTHER reply still queued stays, the banner rebuilt silently with only those (round-10 review,
  principle 2: answering r2 never erases r0's "not sent yet"). `handleReply` runs it when THIS reply
  went out, by its own drain OR by another drain meanwhile (the retry worker, 5 ms apart on a Mi
  9T). The reply is AWAITED before its entry is queued (`AwaitedReplies`, its own leaf lock), and a
  drain records the delivery AT THE SEND, still holding the outbox lock - so every drain taking that
  lock after it, the handler's own included, finds it when it returns: the handler's check is
  decided by the lock's order, not by how far the other drain's post-lock loop has got (round-10:
  recorded after the lock, the worker's late step ran after the handler had re-posted the reply as
  pending). Lock order: the outbox lock, then the leaf; the banner record's lock, then the leaf;
  nothing under the leaf. The re-post's own check under the record's lock covers only a drain that
  took the outbox lock after the handler's - a genuinely later delivery, whose late step clears the
  pending line the re-post put up. A drain that throws still ends in that decision. The log says
  what is known, at WARN in every case (`mirrorPresence`, round-11 review): still QUEUED (the send
  failed); ABSENT, meaning adopted by the app's outbox or erased by `store_outbox_mirror`'s whole
  rewrite outside the outbox lock, which cannot be told apart here and leaves a pending line no
  native path clears ([backlog](../backlog.d/p3-a-quick-reply-whose-process-died-leaves-its-banner-spinning.md));
  or UNREADABLE, a failed mirror read told apart by type (`readOutboxMirrorOrNull`) and not read as
  an empty queue. The map holds only replies whose handler is running (removed in a
  `finally`), so it needs no cap. The in-memory record decides rather than the outbox files: both
  are rewritten whole, not atomically, and `outbox_sent` is emptied by the app at login. A process
  that dies between the enqueue and the decision cannot be resolved in-process
  ([backlog](../backlog.d/p3-a-quick-reply-whose-process-died-leaves-its-banner-spinning.md)).
- **A banner the platform holds after an inline answer is never cancelled by the app** (rounds
  11-12; `holdsDirectReply`, `ReadElsewhereMarks.cancelUnlessHeldLocked`). Android 15+ keeps a banner
  answered inline with `FLAG_LIFETIME_EXTENDED_BY_DIRECT_REPLY` (`@hide`, `0x00010000`). Read on a Mi
  9T, SDK 36: `notif removed` logged, and the record kept in dumpsys with the "Vous ..." line on
  screen. What AOSP `NotificationManagerService` does:
  - `cancelNotificationWithTag` puts the flag in an app cancel's must-NOT-have flags (all three
    branches). `CancelNotificationRunnable` looks the record up with `findNotificationLocked`, which
    searches the POSTED list (`mNotificationList`) before the enqueued one. A cancel that meets the
    flag returns and calls `maybeNotifySystemUiListenerLifetimeExtendedLocked`, which posts an
    `EnqueueNotificationRunnable` of the old record straight onto the handler, so the flag survives.
    On android16-release and main that runnable is built with `isAppProvided = false`. On
    android15-release the parameter does not exist, and the strip lives only in
    `enqueueNotificationInternal` (line 7664 there), which this re-enqueue does not go through.
  - `enqueueNotificationInternal` strips the flag from an app's post ("Apps cannot post
    notifications that are lifetime extended"). Its `EnqueueNotificationRunnable` then posts
    `PostNotificationRunnable`, delayed by `DELAY_FOR_ASSISTANT_TIME` (200 ms) when an assistant is
    enabled. So a cancel sent right after the update meets the OLD flagged record and re-extends it.
    The first attempt (31904d65) did exactly that.
  - `setTimeoutAfter` was weighed and REFUSED. Its alarm is armed in `EnqueueNotificationRunnable`
    (`scheduleTimeoutLocked` / `mTtlHelper.scheduleTimeoutLocked`), before `PostNotificationRunnable`
    lands. The `REASON_TIMEOUT` cancel (`mNotificationTimeoutReceiver`) looks the record up with
    `findNotificationByKeyLocked`, posted list first, and excludes the flag. A timeout shorter than
    the post delay would meet the old record, so the duration would carry the ordering.

  The rule, with no assumption about latency: EVERY cancel of a recorded banner (a read's
  `recordThenCancel`, a dismissal's `withdraw`, a delivery's `replyDelivered`, the answer, the app's
  start in `forgetAll`) first asks the shade whether the platform holds it. A held banner is posted
  again, silently and through the one rebuild (`rebuildBanner`), which ends the hold, and it STAYS
  recorded. The next event asks again, and either finds it released and cancels it, or updates it
  again. None forgets it. WHAT THE RE-POST DRAWS IS WHAT THE RECORD HOLDS (round 15):
  - `rebuildBanner` always sets its MessagingStyle explicitly to the lines it is given:
    `NotificationCompat.Builder(context, template)` restores the template's own style, which redrew
    every old line - a held [r0] whose r0 was delivered drew "non envoyé" again. With no line, it
    posts an EMPTY conversation (the title, no text).
  - A read that covers every line, a dismissal and the app's start re-post a held banner EMPTY:
    every line it showed was read or seen, and re-drawing them made the next post bring them back.
    A delivery re-posts what it left; the answer, what it shows.
  - A banner that cannot be rebuilt (no template, no MessagingStyle - no fallback sender is
    invented) was not posted, so its record stays as it was, reported at WARN by the rebuild.

  The other app cancels follow the same rule (round 13):
  - A stable-id cancel for a banner the record does not know (`withdraw`'s NONE, the answer with no
    banner) is not sent to a held one. With nothing recorded, there is nothing to re-post, so it is
    left and reported at WARN.
  - A message post that would switch a held banner's channel (a mention arriving during a slow
    inline reply) posts on the held banner's channel instead. That post ends the hold, and the switch
    is left to the next post. Otherwise the switch's cancel would be dropped, and the re-enqueued old
    record would bury the new line.
  - The app's start takes ONE shade snapshot for every "held?" (only the system sets the flag) and
    leaves held banners out of its sweep. `releaseUnrecordedHold` then asks THE RECORD FIRST (round
    14, B2): a banner it holds was re-posted and kept by `forgetAll`, and that re-post may land at
    once and read as released - cancelling it then left a record of a banner that was gone. Only one
    the record does not hold (a fresh process) is decided by its FRESH shade copy: released since, it
    is cancelled; still held, it is re-posted empty and recorded under its conversation.

  What the answer shows (round-12, S-b) is posted the standard way: the lines that stay (newer than
  the watermark, or another reply still queued), then the answer as this account's own line
  (`answerLine`, `LINE_OWN`). Every read covers that line. The record holds exactly what is shown. A
  held banner with nothing else left shows the answer alone and is `KEPT_UNTIL_READ`. A swipe of it
  forgets it, so the next peer message alerts with only that message. A banner whose remaining
  lines are all own answers counts as empty wherever lines are weighed (round 13). A delivery of r0
  next to "Vous: r2" removes the banner instead of leaving the answer alone.

  What is truly left:
  - A held banner stays until an event about its conversation happens (a read anywhere, a
    dismissal, a new message, a swipe, or the app's start). It shows what was answered, nothing
    unread.
  - A shade that cannot be read is taken as "not held", logged at ERROR, and the cancel goes as it
    always did.
  - A held banner the app's start finds but cannot name a conversation for is left as it is, logged
    at WARN.

  Accepted residuals (round-16 review), each with the reason it is not worth a mechanism:
  - **An empty held banner waits for an event.** A held banner a read covered shows the title only;
    its actions are kept and it counts on the launcher badge. It stays until the next event for its
    conversation: removing it sooner would need a timer, which the standing directive refuses.
  - **A stale reaction base.** Two DISTINCT reactions within the system's processing delay, or a
    legacy reactor sending `sentAt` 0, can make the second post rebuild on the shade's copy from
    before the cancel (`reactionPosted` lets the shade answer again once a post went out, and both
    may still be queued). Closing it costs a full reaction record, for a window of milliseconds.
  - **A reaction posted milliseconds before the app's start sweep.** It is not yet in the sweep's
    snapshot and survives it. The app is open, nothing is lost, and `forgetAll`'s cancel by id
    (round 16) covers every reaction this process recorded.
  - **A late read clears a newer lone reaction.** A read handed over after a reaction it predates
    removes that reaction's notification. This is inherent to the decision that the reaction's alert
    goes with the conversation: a reaction carries no server instant to weigh. The reaction itself
    stays in the conversation (principle 2).
  - **An unreadable shade reads as "not held" / "nothing posted".** It happens only when the system
    server failed (`RemoteException` cause, typed at the catch); the cancel then goes as before and
    the line accuses at ERROR. Anything else is rethrown, not read as an answer.
  - **A banner with no template or no MessagingStyle is not rebuilt.** Every conversation banner is
    built with both; no fallback sender is invented, the record keeps what was posted, and the
    rebuild says so at WARN.
- **Answering is reading UP TO THE WATERMARK** (round-11 review, S2). The answer records the instants
  its watermark announces (`notifiedServerAt` on the server clock, `notifiedAt` on the sender's) as a
  mark, and only the peer lines that mark covers go. A message that arrived while the reply was being
  sent is newer and stays, and the banner is rebuilt silently with it.
- **Coming to the front removes every message, mention, ring and reaction banner, read or not (by
  design, `MainActivity.onResume` -> `cancelAllMessageNotifications`), and says so (2026-11-21).** A
  banner posted in the background was gone about a second after the app came to the front on the Mi
  9T (`1.7.3-alpha.3`) with no line saying why; this sweep was the remover (not the #3912 read
  dismissal). Each removal now logs `cancelAllMessageNotifications: removed id=<n> channel=<c>
  conversation=<ref, "?" when unknown> - the app came to the foreground`. Whether opening the app should clear a
  conversation nobody read is a product question, not settled here: the unread badge still counts
  it. A banner therefore cannot be on screen while the app is in front, which is why the inline-reply
  reading over the open app needs the banner held by a direct reply (the sweep spares those).
- **THE REACTION'S ALERT GOES WITH THE CONVERSATION** (round-14 decision, replacing rounds 12-13,
  `cancelReactionNotification`). Whatever removes OR COVERS the conversation's message banner removes
  its reaction notification too: an answer, a read that cancels the banner or finds it held after
  covering every line (`holds` is asked only then), a dismissal ("mark as read", a silent-from-self
  push). A late delivery is not a read and leaves it. Why not weigh it on its own, as rounds 12-13
  did: a reaction line carries no server instant (`LINE_SERVER_AT` 0), so a server-clock mark never
  covered it and the reaction stayed after every read. Principle 2 holds: the reaction itself stays
  in the conversation - only its alert goes, when the conversation it belongs to is read.
  - THE READ'S OUTCOME DECIDES (`ReadElsewhereMarks.ReadOutcome`, round 15): `CANCELLED`, `HELD`
    (every line covered), `PENDING_ONLY` and `NO_BANNER` remove the reaction; only `UNREAD` - a
    MESSAGE line newer than the read - keeps it. A pending reply is a send of this account's that
    has not gone out, not an unread message: a read covering every other line is `PENDING_ONLY`,
    the banner stays for the reply and the reaction goes, as on a dismissal's `KEPT_PENDING_REPLY`
    (round 16). So a read of a conversation with no message banner standing removes a LONE
    reaction, as a dismissal always did (round-15 decision).
  - The cancel runs IN THE DECISION'S CRITICAL SECTION (`READ_ELSEWHERE.lock`), on the answer, read
    and dismissal paths alike, so a reaction post cannot fall between the decision and the cancel.
  - A reaction post rebuilds on the shade, which lags a `cancel`: a reaction removed a moment before
    came back with the next one. The record now says when the shade's copy is stale
    (`reactionWithdrawn` on every cancel, every reaction at the app's start sweep): the next post
    builds on nothing (`reactionBaseOf`), and the shade answers again once one was posted on that
    fresh base (`reactionPosted`). The app's start also cancels BY ID every reaction this process
    posted since the last sweep (`forgetAll`), as it does the banners: its sweep reads a shade that
    lags a `notify` (round 16).
- **What a line counts as** (`lineOfMessage`, `ReadElsewhereMarks.Line.of`): its stamps, and an
  UNCOVERABLE line for the pending reply (`LINE_PENDING_REPLY`, marked explicitly - never by its
  name, which a peer may share: a read elsewhere says nothing about a send that has not gone out, and
  the banner is the only place that says "not sent yet") and for a line that carries no stamp (a
  banner from a build that did not stamp).

The WebView's row used to decide
(`unreadCount === 0`), and it can lag behind the shade: the WebView is frozen, the account reads on
desktop at t1, a peer sends N at t2 > t1 and the push posts N; on thaw the own read t1 is drained
before N reaches the row, which counts nothing unread - and N's banner was cancelled, its WebView
re-post then refused as already announced (`hasAlreadyAlerted`), so N lost its banner for good
(round-3 review of #3912). A line comparable on neither clock keeps the banner.

**A COVERED POST TOUCHES NOTHING.** `showMessageNotification` asks the record twice:

- EARLY, before any side effect (before an id is minted, a shortcut pushed, the previous banner
  removed) - a covered post returns there;
- AND DECIDING, at the post: every side effect on the shade - the channel switch's `cancel` of the
  previous banner (a mention upgrading a plain post, WP-XP-5), then the `notify` - is ONE step that
  `ReadElsewhereMarks.postUnlessRead` runs only when the message is not covered, under the lock
  `recordThenCancel` (the dismissal: record, then cancel) also takes - the lock described above.

The switch's cancel used to run before the check, so a covered late post (an older mention read on
the web) removed a newer message's banner on its way to posting nothing (re-review of #3912). The
WebView's post (`notifyMessageFromWebSocket`) asks the record before it fetches the avatar or retires
a generic line from `GenericBannerLedger`, so a refused post consumes neither.

What is JVM-tested (`ReadElsewhereMarksTest`, no clock - latches, and the waiting thread's state
bounded by a spin count so a lock that stopped excluding fails instead of hanging; the shade is an
ASYNCHRONOUS fake whose posts show only once the test drains them, driven by the same steps as the
service's - build on `bannerOf` under the lock, `postUnlessRead`, `recordThenCancel` with the shade
lookup and a cancel that receives the id): the comparison, the record's rise, the id the cancel
receives from either source, two posts back to back keeping both lines, the two lag scenarios above, an unstamped foreign line never covered, that a mark older than the
newest line cancels nothing and one covering every line cancels, that a covered post runs none of its steps, and both interleavings - a read
arriving while a post is inside its steps waits, then weighs its line and removes it; a post arriving
while a read is inside its steps waits and is then refused. What only a device proves (pinned as
source by `dismissedNotificationReplay.test.ts`): that the builder hands EVERY side effect to that
step, that the stamps survive `extractMessagingStyleFromNotification`, and the binder calls.

**Windows that remain.** The `channel_read` push carries no mark, so its cancel records none; it runs
on `WS_NOTIF_LANE`, and a post still in flight is covered by the socket's own `channel.read`, which
does. The push silent-from-self cancel (`handleMlsFrame`) cannot weigh the shade's lines: the mark is
inside the ciphertext the service does not open, so it still removes the whole notification - the one
place where a newer message's banner can go with an older read - unless it holds a pending reply.

**The log names a conversation by `ConversationRef.of`**: `ch:` and 8 characters of a salon's own id
(the `channel_` prefix stripped - `take(8)` of the key printed `channel_` for every salon), `g:` and 8
of an MLS conversation; the scheme of the push-outcome line (#3914), which must stay the same.

Pinned by `systemMessageHandler.readState.test.ts` and `channelEventHandler.read.test.ts` (every own
mark is handed over, moved or not, and a peer's is not), `nativeNotification.test.ts`,
`ReadElsewhereMarksTest` and `dismissedNotificationReplay.test.ts`.

### Forms (`/api/forms`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/forms` | Create form |
| GET | `/api/forms` | List caller's forms |
| GET | `/api/forms/:id` | Get form definition |
| POST | `/api/forms/:id/submit` | Submit form (with optional Lydia or cash payment) |
| GET | `/api/forms/:id/submissions` | List submissions (owner only) |
| GET | `/api/forms/:id/held-answers` | An anonymous form's answers waiting for their batch, and the batch size (managers only; [forms](../frontend/modules/forms.md#an-anonymous-forms-answers-are-released-in-batches-2026-11-21)) |
| POST | `/api/forms/:id/image` | Upload form banner image |

A form's `items` holds questions AND text or image blocks (`text_block`, `image_block`): a block is
stored with a block's fields only, refused `FORM_BLOCK_INVALID` when it carries a question's setting,
and any answer keyed by one is dropped at submit and edit (`forms/form-blocks.ts`). A booking space
refuses them (`item-block`). Design and the consumers checked:
[forms](../frontend/modules/forms.md#text-and-image-blocks-between-the-questions-owner-2026-11-21).

### Bookings (`/api/bookings`)

Rooms and slots; every route, its rights and its refusal codes are in
[bookings-chantier](../bookings-chantier.md#wp-b3-as-built-2026-10-17), the only copy.

### Lives (`/api/lives`)

Live broadcasts, behind `LIVE_ENABLED`; every route, its rights and its refusal codes are in
[lives](lives.md), the only copy.

### Associations (`/api/associations`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/associations` | List all associations |
| GET | `/api/associations/:id` | Get association detail |
| POST | `/api/associations` | Create association (global admin or BDE `MANAGE_ASSO` flag) |
| PATCH | `/api/associations/:id` | Update details: each field asks its own right (`UPDATE_FIELD_RIGHTS`: profile `EDIT_PROFILE`, `archived` `MANAGE_MEMBERS`, cotisation `MANAGE_PRODUCTS`, quota and a list's parent the platform admin) - [the field table](../association-permissions.md#edit_profile-bit-12-the-profile-is-not-the-roster-and-patch-id-is-not-one-flag-owner-2026-11-02) |
| GET/PUT/DELETE | `/api/associations/:id/push-mute` | LEGACY (builds older than the bell, engagement WP-3): the caller's bell on one association read as a mute (`none`); `GET /api/associations/me/push-mutes` lists them |
| POST | `/api/associations/:id/members` | Add member to association |
| POST | `/api/associations/:id/events` | Create calendar event |
| PATCH | `/api/associations/:id/events/:eventId` | Update calendar event |
| DELETE | `/api/associations/:id/events/:eventId` | Delete calendar event |
| POST | `/api/associations/:id/products` | Create boutique product |
| POST | `/api/associations/:id/products/:productId/checkout` | Open ONE checkout attempt (a `product_checkouts` row, then the Lydia request) - see [payments](../frontend/modules/payments.md#a-product-checkout-is-a-row-one-per-attempt-2026-10-21) |
| POST | `/api/associations/:id/products/:productId/checkouts/:checkoutId/confirm` | The buyer's return: reads the attempt's own request at Lydia, records it if paid, answers its status (throttled) |
| POST | `/api/associations/:id/partnerships` | Create a partnership card (`MANAGE_PARTNERSHIPS`) |
| POST | `/api/associations/:id/partnerships/:cardId/claim` | Claim a partnership (any logged-in member; `membersOnly` gated server-side) |

### A claimed code is copied by a button, not by a long press (2026-09-29)

Asked for with the defect above it in the same report: *"les codes des partenariats (mettre un bouton
avec l'icone 'copier' peut-etre bien)"*. The value exists to be pasted into a partner's checkout, and
the gesture it took was a long press, two drag handles and the system menu, over a `break-all` string
that wraps mid-token - against an app that disables selection on a coarse pointer
([posts](../frontend/modules/posts.md)). `PartnershipCardList` now draws a copy button beside the
code and marks the code itself `select-text`, so the manual path exists too.

**The write is `utils/clipboard.ts`, and its boolean is load-bearing**: `writeText` rejects on an
unfocused document and outside a secure context, and "Code copie" over an empty clipboard is worse
than no button at all - the student pastes whatever they had before. The toast is shown only on a
resolved write; a refusal leaves the log line that is the sole trace there would be. `copyId` is that
same write with the admin-surface contract on top of it.

### A user id is not a UUID, and one partnership column said it was

`partnership_codes."claimedByUserId"` was created `uuid` by migration 047. A user id in this estate
is the **64-character hex digest** carried in `x-user-id` - every other user-id column in this
service (`association_members`, `channel_members`, `form_submissions`,
`document_reviewer_grants`, `association_role_history`) is `varchar(255)` for exactly that reason.

So `POST /api/associations/:id/partnerships/:cardId/claim` answered **500 for every user, on every
`code_pool` card, from the day the feature shipped**. The failure is in the FIRST statement
`claimPoolCode` runs - the `findClaimedCode` lookup that makes re-claiming idempotent - and Postgres
rejects the parameter before reading a row:

```
invalid input syntax for type uuid: "<hex id>..."   -- SQLSTATE 22P02
```

Three things about the shape of this defect are worth keeping:

- **It was total, not marginal.** No claim could ever have succeeded. Prod confirmed it: one code
  row, zero claimed, against a live card - and *zero rows in the state a feature exists to produce
  is a measurement, not a quiet period.*
- **The tab looked healthy.** `shared_code` and `text` cards return straight off the card row and
  never touch the column, so only the pooled mode broke.
- **Seventeen green unit tests said nothing**, and could not have: `partnerships.service.spec.ts`
  mocks the repository, so no column type is ever exercised. A `uuid`/`varchar` mismatch is only ever
  checked by Postgres, and nothing in CI asks Postgres.

Migration 056 widens the column. `ALTER TYPE` rebuilds the partial unique index
`idx_partnership_codes_card_claimant` and keeps its predicate, so the concurrency guarantee
`claimPoolCode` documents survives untouched; nothing is converted, because no row could ever have
been written. The replacement gate is `user-id-column.spec.ts`, which reads the DECLARED entity
metadata - no database needed - and fails on any user-id-shaped column typed `uuid` anywhere in the
service, rather than pinning the one column that broke.

### The claim that consumed a code and answered without it

Once claiming could reach Postgres at all, it answered the FIRST claim of every `code_pool` card
with `{"mode":"code_pool"}` and no `code` field, while consuming a pool row. Every later claim by the
same student carried the code, because a revisit leaves through `findClaimedCode` - a repository
read - and never re-enters the allocating transaction. On screen that reads as a scheduling bug in
the client; the client is identical on both clicks.

**TypeORM's Postgres driver answers an `UPDATE` or a `DELETE` with the tuple `[rows, rowCount]`, and
only a `SELECT` with the rows themselves** (`PostgresQueryRunner.query`, its `case "UPDATE"` branch).
`claimPoolCode` read `updated[0].code`, so `updated[0]` was the rows ARRAY and `.code` on it was
`undefined`. The `SELECT ... FOR UPDATE SKIP LOCKED` immediately above is correctly shaped for that
same reason, which is what made the pair look consistent.

The measurement that named it is worth keeping, because no application log carried the defect at all:
**nginx's `body_bytes_sent`**. The first claim answered `201` with **20 bytes** - exactly
`{"mode":"code_pool"}` - and every revisit `201` with 39, the difference being `,"code":"XXXXXXXXX"`.
A body size is evidence about a payload's shape, and it is already being recorded for every request.

Two guards replace it. The service destructures the tuple and throws if the UPDATE matched no row -
this transaction holds that row's lock, so an empty result is impossible rather than unlikely, and
returning `undefined` for it is what reached the screen as a blank panel. And
`partnerships.service.spec.ts` stubs every raw UPDATE through one `updateReturning` helper: both
stubs previously returned a SELECT's shape, so the suite was green on precisely the call that was
broken. *A double that encodes the wrong assumption does not miss a defect, it asserts the defect is
correct.* The client half is in `frontend/src/lib/components/shop/PartnershipCardList.svelte`: a
success carrying no code is now refused and logged rather than rendered as an empty code panel.

### An association row carries secrets, and its reads must pass through one projection

Association reads once returned the raw row, which includes secret columns (the document vault master
key and ciphertext notes). **Fixed and shipped**; the exposure window and details are kept in the
private notes. `toSafeAssociation` (`associations/association.projection.ts`) became the single seam
that nulls the secrets, applied at the controller reads. Third instance of one rule, after `Channel.masterSecret`
(since deleted outright) and `AssociationProduct.webhookSecret`: **an entity that carries a secret
needs one projection, and every read has to pass through it.**

The seam is the controller, not the service, on purpose: `findById` is also used by writers
(`update`, `resolvePaymentTarget`), and stripping in the service would hand them a row whose key
column reads null. The three reads are behind `NginxAuthGuard` since 2026-08-05.

**A denylist was the wrong shape, and it leaked the next secret (2026-10-15, fixed).** It named two
columns, so another provider identifier reached signed-in members, and some write routes answered the
raw row. `toAssociationView` replaced it: an ALLOWLIST on
all eight routes that answer a row, so a column added later is private until someone lists it. The
payout account has its own read, `GET :id/payout-account` (`canManagePayoutAccount`). Story and
test: [forms](../frontend/modules/forms.md#what-a-client-reads-of-a-submission-is-an-allowlist-2026-10-15).

**The Lydia Business private token is write-only (2026-10-16, migration 100).** Since enrolment lot 1 it is
written ONLY by the internal `POST :id/lydia-account` at `business/create` (`setLydiaAccountId`); the old
`PUT :id/lydia-business-key` is a shim answering `410 LYDIA_KEY_PASTE_RETIRED` and writing nothing
([legacy-compatibility](../legacy-compatibility.md)). It is stored encrypted (`common/secret-box.ts`, `LYDIA_KEY_ENCRYPTION_SECRET`,
bound to the association and its vendor token) in `"lydiaBusinessKeyCiphertext"`, a column the entity
maps `select`/`insert`/`update: false` and only raw SQL touches; `GET` on the same path answers `{ set }`.
The one route that answers it decrypted is the internal `POST /api/internal/associations/lydia-callback-key`
(`InternalLydiaKeyController`, `X-Internal-Secret`, `no-store`), for core-service to verify a Lydia
callback. Why and how: [payments](../frontend/modules/payments.md#what-confirms-a-payment-2026-10-16).

### The document vault's markers are parsed in two languages, and they disagreed for seven weeks

A vault document's encryption key is never stored. The association holds one
`documentVaultKey` (hex 32 bytes) and each document's CEK is
`HKDF-SHA256(vaultKey, salt=<per-document salt>, info="doc-vault")`. That salt is a random UUID
the client mints at upload - **not** the row's `id`, which does not exist yet when the bytes are
encrypted - so it has to be persisted, and it is persisted as a marker at the head of
`association_documents.description`: `(s:<cekSalt>)`, optionally followed by `(pw:<pwSaltHex>)`
when the document is password-protected.

Two implementations read that marker, in two languages, because there is no shared TS package to
hold one (`libs/shared-ts`, deleted 2026-08-27 - see [libs](../libs.md)):
`frontend/src/lib/associations/vaultCrypto.ts` writes and reads it, and
`associations/vault-markers.util.ts` reads it server-side to derive a per-document key for the
`/documents` reviewer page. **That duplication has been paid for in full, once.**

The client moved from `[s:…]` to `(s:…)` on 2026-07-24 (`d4596da61`), so Tailwind's JIT scanner
would stop reading the brackets as an arbitrary CSS property class. The server was not moved with
it. Every public document uploaded afterwards carried a marker `parseCekSalt` returned `null` for,
and the reviewer listing skipped it. Measured on prod on 2026-09-10, seven weeks later:

```
 marker | visibility | count
--------+------------+-------
 (s:    | public     |     3      -- 3 of 3, all invisible
```

`/documents` had therefore never listed a single document in production. Four things are worth
keeping about the shape of this one:

- **The two halves failed in OPPOSITE directions, and one masked the other.** `parseCekSalt`
  failed CLOSED - a document nobody could see. `hasPasswordMarker`, bracket-only for the same
  reason, failed OPEN: `updateDocument`'s refusal *"A password-protected document cannot be made
  public"* stopped refusing anything. It was only invisible because the first half then skipped
  the row at read time. **Fixing either half alone unmasks the other**, so both move in the same
  commit, and the listing now refuses a `public` + password-protected row defensively as well.
  Prod carried no such row (`pw_protected = f` on all three), so the open guard was never used.
- **The symptom of the read half is an EMPTY PAGE, not an error.** Three `continue`s withheld a
  document its association had deliberately published, in silence. They now log a warning that
  names the document and the reason - *a correct mechanism with no report is found by hand, a day
  late*, and this one was not found for seven weeks.
- **Nothing compared the writer to the reader.** `vault-markers.util.spec.ts` pins the parser
  against the literal strings `buildVaultMarkers` emits, and
  `associations.service.reviewer-documents.spec.ts` pins the seam above it - that a document
  written by the CURRENT client comes back listed, which no parser test would catch if the service
  stopped calling the parser.
- **The entity's own docstring said the salt was the row `id`.** It had been wrong since the
  feature shipped and would have sent the next reader looking in the wrong place.

Both files now carry a header naming the other and the rule: **a change to the marker format lands
in BOTH, in the SAME commit.** A third copy is the signal to reconsider the shared package.

### A post scheduled for later is not readable by id

Every `listPosts` query filters `scheduledAt IS NULL OR scheduledAt <= NOW()`. `getById` did not,
so a queued post was fully readable through `GET /api/posts/:postId` - and would have been
published early by any link preview or share unfurl. It now applies the same rule, letting through
only the post's **author** (so scheduling does not hide a post from whoever wrote it) and a global
admin. Everyone else gets 404, not 403: the existence of an unpublished post is itself the thing to
hide. Pinned by `posts.service.scheduling.spec.ts`.

### Who may READ the feed, and why the edge check was not one

`FeedAudienceGuard` (`posts/feed-audience.guard.ts`) sits on the four read endpoints - `GET
/api/posts`, `/search`, `/:postId`, `/:postId/calendar-link` - paired with `NginxAuthGuard` and in
that order. `health` is deliberately outside it.

**Until 2026-09-10 there was no server-side gate at all**, and the reason it survived is worth
keeping. `/api/posts` carries `auth_request /internal/auth/verify` in the edge config, which is
exactly what an access check looks like; reading that block is what convinced two earlier passes
the endpoint was protected. But `/api/auth/verify` answers **200 for a logged-out caller** as well,
carrying `x-logged-in: false` so signed-out pages can render, and nginx treats any 2xx as
permission granted. Measured that day: an anonymous `GET /api/posts?limit=1` returned 200 with post
bodies. **A gate is only a gate if it can say no.**

The guard asks the database and ignores `x-global-admin`, though that header is trustworthy.
Admins are already inside the audience predicate, so reading the header would state part of the rule
a second time in a second place - the exact shape of the original defect - and campus and cursus are
not in the JWT, so the query is needed regardless.

**Since WP6b the gate and every read rest on spaces** ([profiles-and-access](../profiles-and-access.md), "WP6b as built"):
the gate is `IN_FEED_AUDIENCE_SQL` and which posts each read returns is `postVisibleToViewerSql`,
both in `spaces/reader-spaces.ts`, the only copy. `feed-audience.ts` ("ICM plus global admins") is
deleted.

| Caller | Gate | Posts returned |
| --- | --- | --- |
| no identity | **401**, from `NginxAuthGuard`, before this guard runs | - |
| `admin = true` | 200 | every post |
| at least one space (a cursus formation on their campus) | 200 | the posts whose rules reach one of their spaces, plus D21 below |
| a member of at least one association, no space | 200 | that association's posts (D21), and their own |
| none of these | **403** | - |

403 rather than 404 for the GATE: the client asks `GET /api/posts/audience` (the same SQL) and
redirects a reader outside it away from `/posts`, so a distinguishable refusal is what lets the two
agree. ONE POST the reader may not see is a **404**, before the moderation check whose 403 would
confirm the id.

**Every fragment is parenthesised, and that is load-bearing.** `AND` binds tighter than `OR`; the
old `WHERE id = $1 AND formation = 'ICM' OR admin = true` would have parsed as
`(id = $1 AND formation = 'ICM') OR (admin = true)` - true for every admin row whoever asked
(measured on the local copy of production: 4 rows without the brackets, 0 with them). Who each
fragment admits is proven against PostgreSQL by `reader-spaces.integration.spec.ts`.

**This closes the feed and not the class.** `/api/presence` was the second confirmed hole, closed
the same day by a header check in `chat-gateway/src/presence.rs`, whose docblock is the story. A
guard-coverage assertion for signed-in routes is tracked in the [backlog](../backlog.md).

### A post is announced once, by a sweeper, and the column is the whole mechanism

Until 2026-09-10 **no notification existed for a publication**. `post_notifications` carried only
reactions to a post that already had a reader: an association could announce to the whole school
and reach whoever happened to open the feed. `PostAnnounceScheduler` closes that.

| | Association post | Personal post |
| --- | --- | --- |
| Recipients | everyone who can SEE the post (`announceRecipientsSql`, WP6b), minus its author | the author's ACCEPTED followers (`user_follows`, [WP-F1](#a-follow-of-a-person-is-a-request-first-wp-f1-migration-114-decided-2026-10-25)) who can see it |
| Notification `type` | `association_post` | `followed_post` |
| Push `actorName` | the ASSOCIATION's name | the author's display name |
| Measured rate (17 weeks to 2026-09-10) | 0.53/week to 356 people | ~6.5/week to 2.84 people each |

**Three things decide the design, and the third is the one to keep.**

**It is a sweeper, not a call in `createPost`.** `scheduledAt` exists and **nothing has ever
published a scheduled post** - before this, the column appeared only inside a `WHERE` clause - so
a post can become visible with no request happening at that moment. And a notification sent inline
is one a rollback keeps: the announcement has to be decided from the row's committed state.

**Idempotence is `posts."feedNotifiedAt"` and nothing else.** No window, no reliance on the cron's
period. It is stamped BEFORE the batch goes out, the trade `forms-reminder.scheduler.ts` already
documents: a crash between the stamp and the send loses one announcement, where the other order
re-announces on every tick for as long as it keeps failing - sixty times an hour to 356 people.

**Migration 058 BACKFILLS EVERY EXISTING ROW, and that is the step a revert cannot undo.** A null
means "not yet announced", so shipping the column empty makes the first tick read the whole
archive as new. It stamped 120 rows on the local copy of production. A partial index on the null
rows keeps the once-a-minute query off a growing table.

**Who is told is who can see, since WP6b.** The recipients are `postVisibleToUserSql` - the
predicate every read applies - asked of every user for THAT post, so a notification never points at
a post its recipient would get a 404 for. A post's own rules (D33) narrow its announcement exactly
as they narrow its readers.

**`association_follows` IS DELIBERATELY NOT CONSULTED.** Everyone an association reaches is told
already, so following it adds nothing to what you are told.

**No digest. A per-association MUTE exists since 2026-10-08** - see the next section, which is
where "Suivre" is defined.

Pinned by `post-announce.scheduler.spec.ts`, whose first assertion is the stamp/send ORDER rather
than the recipients.

### Follow, bell and read grants: three different facts (decided by the user, 2026-10-08; the mute became the bell, engagement WP-3, 2026-11-08)

| | What it is | Does it decide who is PUSHED? |
| --- | --- | --- |
| **Follow** (`association_follows`, button "Suivre") | a reading preference: it feeds the "followed" view of the feed | **No** for an association: every association post is pushed to everyone who can SEE it; the follow table is not consulted for announcing (STATUS QUO, chosen on purpose). A PERSON's accepted followers are their announcement audience |
| **Bell** (`account_bells`, migrations 142-143) | what the reader receives from ONE account, a person they follow or an association: posts and lives (no row, the default), `lives`, or `none`. The old association **mute** (`association_push_mutes`, migration 080) is the level `none`, copied by 143 | **Yes - it removes the recipient from the PUSH**, never from the feed or the bell list |
| **Nominative read grant** (`read_grants`) | access to read | **No.** A read grant is access, not subscription: its holders are not announced to |

**Where the bell is applied: ONE place, server-side.** `PostNotificationsService.fanOutPush` asks
`AccountBellsService.withheldAmong(target, recipients)` just before the push loop and drops the
withheld (`bellTargetOf`: the association when the push carries one, the person acting otherwise). The
in-app `post_notifications` row is still written (the bell list is the record, a push is the
interruption), and the announce SQL is untouched. Nothing is filtered by the client, and no cache or
feed key is involved. The full design, the levels and why a new follow resets the row:
[engagement](../engagement.md#the-bell---data-model-and-how-it-combines-with-categories-and-mutes).

**If the bell lookup fails the push FAILS CLOSED and LOUD**: `[NOTIFY] bell lookup failed` at error level, the error rethrown to the caller's own warning, the in-app rows kept. Pushing everyone would override a stated choice. The announce stamp is a CONDITIONAL update (`feedNotifiedAt IS NULL`), so two overlapping instances cannot both announce a post. Account deletion purges the account's bells and every bell on it (`account-erasure.ts`).

**Per type, and the list is an ALLOWLIST** (`BELL_PUSH_KINDS`; a new type is never withheld by
accident):

| Type | Recipient is | Its bell | Withheld at `lives`? at `none`? |
| --- | --- | --- | --- |
| `association_post` | a reader | the association's | yes / yes |
| `association_repost` | a reader the republication newly reached | the REPUBLISHING association's | yes / yes |
| `live_started` | a reader who sees the account broadcasting (WP-L7; push only, no bell row - `pushNotice`, [lives](lives.md#the-push-to-the-followers-wp-l7-server-half)) | the association's, or the broadcasting person's | **no** / yes |
| `followed_post`, `member_repost` | an accepted follower | the author's, the reposter's (L17) | yes / yes |
| `repost_personal_requested` | the author of a personal post an association asks to carry (D38b) | the asking association's | yes / yes |
| `repost_proposed`, `coorganise_proposed` | managers who must accept | - | **never** - operational |
| `event_proposed/validated/rejected/updated/deleted/pending` | validators and proposers | - | **never** - operational |
| `mention`, `reply`, `reaction`, `comment` | addressed to you by a person | - | **never** |

**Routes** (own rows only: the caller's id is the `x-user-id` header, never a body field):
`GET /api/posts/me/bells` (the settings list), `GET|PUT /api/posts/me/bells/:kind/:targetId` (read,
set `{ level }` - idempotent; a person only while followed, accepted). **Legacy, for builds older than
the bell control** ([legacy-compatibility](../legacy-compatibility.md#no-date-yet---an-association-mute-set-by-a-build-older-than-the-bell-designed-2026-11-07)):
`GET|PUT|DELETE /api/associations/:id/push-mute` and `GET /api/associations/me/push-mutes`, which read
and write `account_bells` (mute = `none`, unmute = no row). UI: the bell (`AccountBell.svelte`)
beside "Suivre" on the association page and on a followed person's profile, and the "Notifications
réduites" list with a "Tout recevoir" button in the notification settings
(`SettingsAccountBells.svelte`). The account-wide `posts` switch still applies, in chat-delivery.

**Measured on the local estate (2026-10-08, sandbox accounts, a build of this branch beside the
old container).** Association post, recipients: follower, muted follower, non-follower member. The
new build logged `push withheld from 1 muted of 3` and pushed the other two; the pre-mute container
pushed all three (`[INTERNAL_PUSH]` in chat-delivery), which is the baseline.

### A follow of a PERSON is a request first (WP-F1, migration 114; decided 2026-10-25)

Every personal account is private ([profiles-and-access](../profiles-and-access.md#follow-requests-member-reposts-and-visibility-between-spaces---the-decisions-of-2026-10-25-all-shipped)):
`POST /api/posts/users/:userId/follow` writes a `user_follows` row with `status = 'pending'`, and
only the followed person's answer makes it `accepted`. An association, a list or an institution
(`association_follows`) is followed at once and has no status.

**Only an ACCEPTED row is a follow, and every reader says so through ONE fragment**,
`acceptedFollowSql` in `follows/follow-status.ts`: the Suivis feed
(`FollowsService.getFollowedUserIdsForUser`), the announce sweep (`announceRecipientsSql(true)`),
the personal republication's newly-reached rule (whose follower exclusion must match the sweep's,
or a pending follower is told by neither) and the live push (`liveAudienceSql`). The erasure and
the block severing delete rows whatever their status. A pending row in each of the three
PostgreSQL specs fails its assertion when the fragment is replaced by `TRUE` (control, 2026-10-27).

**The two defaults of migration 114 are deliberate.** The column is added with `DEFAULT 'accepted'`,
which records every existing follow as accepted (decision 3); the default is then set to
`'pending'`, so a writer that forgets the column fails closed - and the old image, serving the
seconds of a deploy, writes requests rather than follows.

**114 also adds `acceptedAt`** (when the person said yes; existing follows backfilled from
`createdAt`, a CHECK keeps every accepted row dated) **and `user_follow_notices`**, the durable
"already told" of WP-F2: one row per (asker, person, kind), so a request deleted and asked again
never notifies twice. The account erasure deletes both sides of it.

**The schema on dev and production comes from this migration alone**: `synchronize` runs only
when `NODE_ENV` is not `production`, and both estates pin `NODE_ENV: production` on
social-service (`docker-compose.dev.yml`, `docker-compose.prod.yml`), so the entity's `pending`
default never reaches an existing table there. A LOCAL database built by `synchronize` does get it,
and its existing follows become requests - local only, and the dev seed writes `accepted`.

**A request is ONE `INSERT ... ON CONFLICT DO NOTHING`** (`FollowsService.recordFollowRequest`),
never a read then a write: a double tap used to read "no row" twice and 500 on the unique key. A
conflict leaves an accepted follow accepted; `created` is true for the one call that wrote, so the
request is notified once. Eight concurrent taps write one row (PostgreSQL spec).

`GET .../follow-status` answers `{ following, status }`; `following` is true for a pending request
too, the meaning a client older than the request screens gives it
([legacy-compatibility](../legacy-compatibility.md)). Answering, listing and removing followers are
WP-F3 (below).

**Answering a request (WP-F2), `follows/follow-requests.service.ts`.** The follow routes moved out
of `PostsController` into `FollowRequestsController` (same URLs), in a module of its own because it
notifies through `PostsModule` - which already imports `FollowsModule`.

- **Ask**: ONE `INSERT ... SELECT ... ON CONFLICT DO NOTHING` whose SELECT carries both conditions,
  so neither is a check-then-insert: the target is a PERSON (a `users` row; an association's id or
  an unknown one is 404 `FOLLOW_TARGET_NOT_FOUND`) and no block stands, either direction (403
  `FOLLOW_BLOCKED` - core-service's block status already tells either side, so refusing hides
  nothing). A MUTED account may not ask (403): a request is a push to a person. The route is
  throttled per CALLER (`FOLLOW_ASKS_PER_MINUTE`, all targets together), and the same SELECT caps
  the asker: `FOLLOW_PENDING_MAX` (100) unanswered requests at once (409 `FOLLOW_PENDING_LIMIT`)
  and `FOLLOW_ASKS_PER_DAY` (50) NEW people told per rolling day, counted from the notice rows
  (429 `FOLLOW_DAILY_LIMIT`; re-asking someone already told costs no push and is not counted). One
  account cannot push its name to the whole directory (review 2026-10-27). **Both caps are counts,
  so they hold only serialised**: under READ COMMITTED two statements counting at once see the same
  total and both insert. Each ask is ONE transaction that first takes a transaction-scoped advisory
  lock keyed by the asker, then inserts the request AND claims its `request` notice row, so the
  next ask of the same account counts both - the daily cap reads the claims exactly, never a push
  still on its way. Asks by different accounts never wait on each other. A request across a block
  is not counted against the pending cap, as it is not in the asker's sent list either. Proof: the
  PostgreSQL spec runs 24 asks at once at 99 pending and at 49 told, and exactly one is written.
- **The block race**: an ask whose statement began before a block committed, and committed after
  the severing ran, re-reads the block once its insert committed - the block committed BEFORE the
  severing was called, so the read sees it - and deletes the row it wrote, refusing 403. The
  notification path re-reads the block too, just before it writes anything, so an acceptance racing
  a block pushes nothing. Both interleavings are forced with a trigger in the PostgreSQL spec.
- **Told once per pair, from durable state**: the first `follow_request` (and the first
  `follow_accepted`) for a pair claims a `user_follow_notices` row and only that call notifies (a
  request's claim is made in the ask's transaction, above; a claim whose notice is never sent - the
  ask retracted, a block landing before the push, a notification that throws - is released, so the
  pair never reads as told when nobody was), so
  ask -> withdraw -> ask in a loop pushes once. Never a clock. A re-asked request gets its bell
  row back WITHOUT a push (deleted and rewritten, so one per pair), since the request is real
  again; a claim whose notification then failed is logged and not retried.
- **Accept**: ONE conditional `UPDATE ... WHERE status = 'pending' AND no block`, which dates
  `acceptedAt` and takes the row lock; a withdraw racing it ends with no row either way (20 races against PostgreSQL). The
  block term is in the statement because the block severing is a best-effort cross-service call.
  The asker gets `follow_accepted`.
- **Refuse**: the row is deleted, nobody is told, the asker may ask again. The request's bell row
  goes with it, as it does on a withdraw; an acceptance keeps its history.
- **Withdraw / unfollow**: ONE `DELETE ... RETURNING status`, so a withdrawn REQUEST's bell row is
  dropped on the status the delete itself returned, never a read a racing accept could outdate.
- **Pushes**: `social_follow_request` / `social_follow_accepted`, mapped by
  `PostNotificationsService.pushContent` (pinned through the REAL mapping in
  `follow-requests.integration.spec.ts`), with their native strings in both languages on both
  platforms. A request carries the `follow-requests` target (`fr.emse.canari://follow-requests`,
  the inbox), an acceptance the `notifications` one (its bell row opens the accepter's profile).
  Both file under the `follows` category in chat-delivery, which the settings screen switches
  (WP-F4).
- **Block severing**: `DELETE /internal/follows/between` removes every row between the two,
  pending or accepted, both directions, and the `follow_request` bell rows between them (an
  acceptance's stays, as history) - pinned in `follow-requests.integration.spec.ts`.

**The caller's own lists (WP-F3).** `GET me/followers` (accepted, the most recently ACCEPTED first,
each dated by `acceptedAt`), `DELETE me/followers/:userId` (the follow is deleted and NOBODY is
told; the removed person may ask again, which is a new request that lands in the inbox without a
second push - the notice is once per pair; a pending request is refused, not removed; the announce
sweep and the live push stop at once, pinned in the reader-spaces and lives PostgreSQL specs,
and the feed cache is dropped as on a block, so the removed person's Suivis does not keep serving
this account's posts for its 30-second TTL) and `GET me/follow-requests/sent`
(the unanswered asks, each withdrawn with `DELETE users/:userId/follow`). Only the caller's own
lists exist as routes: no rule says who may read another person's followers, so none is open. A
pair a block stands between is left out of every list, as of every reader.

### Who may touch a calendar event

One rule, enforced in `updateCalendarEvent` / `deleteCalendarEvent` and mirrored by every UI that
offers the buttons:

| Caller | Scope |
|---|---|
| Global admin (`x-global-admin: true`) | any association's event |
| BDE validator (`mayValidateEvent`: `VALIDATE_EVENTS` in the BDE of a space the event's association reaches - WP6c step 2, [association-permissions](../association-permissions.md#wp6c-step-2-a-bde-governs-the-associations-its-spaces-reach-2026-10-04)) | the events of the associations its spaces reach |
| Anyone else | needs `PROPOSE_EVENT` in the association that owns the event |

`:id` is always the **owning** association - an event never changes owner, so there is no
`targetAssocId` on update the way there is on create.

Two surfaces offer these actions and they gate differently on purpose. An association's own page
(`AssociationCalendarSection`) gates on `PROPOSE_EVENT` *there*, so a BDE validator holding no
membership in that club sees nothing. The global agenda (`/calendar`) gates per event on the full
server rule (`GET /api/associations/me/bde-reach` names the associations it governs), which is the
only place that validator can act - deriving its gate from the other
surface instead of from the server would have kept the right unusable.

### Nothing is validated by the act of creating it

**Every event goes into the queue, whoever asks** - a BDE admin and a global admin included (user,
2026-09-14: *"Un evenement ne doit jamais etre valide automatiquement, il doit aller en pending, y
compris par un admin systeme ou un admin BDE"*). `createCalendarEvent` wrote `validated` on the spot
whenever `isGlobalAdmin` or `isBde` was set, which made a validation a property of WHO TYPED rather
than a decision anybody took: the queue held only the events of members who happened not to hold the
grant, and `/admin/agenda` - the screen that reviews the school's agenda - could not see what its
own managers had put on it.

What the validator grant still buys on the create path is REACH, not a verdict: `targetAssocId` may
name another association, and `kind` may be `break`. `validateCalendarEvent` is the one place a
validation happens, and it is always a separate act. Pinned by
`associations.service.never-auto-validates.spec.ts`, which has a case per caller shape because a
rule with no exception is only proven by the cases that used to be exceptions.

Two consequences worth knowing:

- **A cross-association deposit no longer notifies the target at creation.** It used to, as
  `event_validated`, which was true only while creating and validating were the same act. The
  association hears from `validateCalendarEvent` or `rejectCalendarEvent` - once, when there is
  something to hear - and the calendar managers hear about the proposal itself, as they do for every
  other creation.
- **The column default moved with the code** (migration 060). `createCalendarEvent` names `status`
  on every insert, so the default decides nothing today; a default reading `validated` publishes any
  future insert that forgets the column, school-wide and silently. No existing row is rewritten:
  events already on the agenda were validated under the rule in force when they were created.

### A validation is spent on a DATE, so moving the date asks again

`updateCalendarEvent` wrote seven columns and never `status`. An association admin could have an
event approved for a Tuesday, move it to the Saturday of the gala, and keep it on the public agenda
with nobody told - the BDE's yes was about a date it no longer describes.

A `validated` event whose `startsAt` or `endsAt` MOVES therefore returns to `pending`, clears
`validatedAt` / `validatedBy`, and re-enters the queue by the same route a fresh proposal takes
(`notifyEventValidatorsOfProposal`). Three things decide that behaviour, and each is pinned by
`associations.service.revalidate-on-date-change.spec.ts`:

- **The trigger is a date that MOVED, not a field that was SENT.** Both modals submit every field
  they render, so keying off `dto.startsAt !== undefined` would demote an event whose author fixed
  a typo in the title - putting every correction in front of the BDE and teaching it to approve
  without reading. The comparison is on INSTANTS (`toMillis`), because a `timestamptz` reaches this
  method as a `Date` through the driver and as a string through raw paths, and `!==` on those two
  forms is true for the same moment.
- **Only the dates do it.** A title, a description or a linked form change nothing the BDE reasoned
  about when it said yes. A `pending` or `rejected` event is untouched: there is no validation to
  spend, and a second proposal notice for something already queued is noise.
- **And there is no exception for the authority itself.** A BDE or global-admin caller used to
  re-validate in place, on the argument that they are the authority the demotion would route to.
  That argument re-opened by a second door what the create path closes at the front - propose,
  validate, move the date, and the event keeps a stamp nobody read the new shape to earn - so since
  2026-09-14 every validated event whose dates move is demoted, whoever moved them. The caller is
  notified like any other validator; `createNotifications` drops the actor, so nobody is pushed
  their own request.

**The demotion is not silent, and that is the half that makes it safe.** Without it the event leaves
the public agenda for a queue nobody is told about - worse than the defect it replaces, the event
having at least been visible before. The association's own admins get
`notifyAssocAdminsOfEventAction(..., 'pending')`, which is the sixth key in `PushContentKey`
(`event_pending`) and therefore owes a string in all six native tables
([mobile](../frontend/mobile.md)).

**One announcement, whatever the cause (WP-Q2, 2026-11-03).** The demotion's two notifications now live in `announceEventReopened(event, reason, actorId)`: the validators as for a proposal, and the organiser plus every accepted partner with the reason (`event_pending` for a moved date, `event_pending_coorganiser` when a partner accepted a validated event - [profiles-and-access](../profiles-and-access.md#wp-q2-an-acceptance-on-a-validated-event-reopens-it-2026-11-03)). Both are best effort and run after the write committed.
### A school-wide break is not an association's to declare

`kind` was a free field. `event` renders as a card on the owning association's row; `break` renders
as a full-day background band across the WHOLE school's calendar. Any member holding `PROPOSE_EVENT`
could send `kind: 'break'`, and both write paths accepted it with no check at all - so an
association could publish "there are no courses this week" about a school it does not speak for.
Proposing one has no meaning, and validating one is the wrong question to put to a BDE.

`assertMayDecideKind` now guards both write paths, and **the gate is on the VALUE CHANGING, not on
the field being SENT**: the modal submits every field it renders, so an ordinary edit resends the
entry's existing `kind` on every save, and refusing a field that was merely present would refuse
every edit a non-BDE makes. On the create path there is nothing to resend, so the comparison is
against `event`. It guards BOTH directions deliberately - turning a BDE's band back into an
association card rewrites the same school-wide statement, and one rule with no hole beats two rules
with one.

**The BDE's own route to making one is the association page, and that is the only one there is.**
The `/calendar` deposit modal omits `kind` on purpose, so a band is created from the owning
association's "Proposer un evenement" modal, where the radio is now rendered only for a caller the
server would accept.

The client mirror is a third BDE-derived flag, `isEventValidator()`, published by
`ensureMyAssociations` from the SAME one answer as the super-admin and moderator tiers - a second
probe over the same endpoint would drift the moment one is force-refreshed and the other is not. A
failed probe denies all three rather than leaving them as they were: a screen offering a control the
API will refuse is the shape this repo has already paid for once. Pinned by
`associations.service.break-is-bde-only.spec.ts` and `membershipProbe.test.ts`.

### A date refusal names WHICH rule was broken, as a code

The three date checks - a start that will not parse, an end that will not parse, an end before its
start - threw `BadRequestException` carrying nothing but an English sentence. `endsAt must be after
startsAt` is the one a user actually meets, and the global agenda's deposit modal rendered it
verbatim: `e instanceof Error ? e.message : <fallback>` picks the server's text every time the call
reaches the server at all, so the localized half was dead code and a French reader met English
mid-form. The association page's modal had the opposite failure - one generic "Impossible
d'enregistrer" for all three, so the reader was told something went wrong and never which rule they
broke.

This is the standing rule about never branching on an error MESSAGE, applied one step earlier: the
distinction is classified AT THE THROW, as `CALENDAR_ERROR_CODES`, the same shape
`PARTNERSHIP_ERROR_CODES` already uses in `partnerships.service.ts`. `calendarDateRefusal(code,
message)` builds the `{ code, message }` body; `request()` in `frontend/src/lib/associations/api.ts`
already parses it and throws `SocialApiError(message, code)`.

**Three codes and not one, because they are three different mistakes and a reader can only fix the
one they made.** `associations.service.calendar-date-codes.spec.ts` pins six cases and not three,
because create and update check the same three things in two different places - which is exactly how
one of them comes to drift. The update's END_BEFORE_START case sends only `endsAt`, so the
comparison is against the STORED start, the case a DTO-only check would miss.

**Both modals translate through ONE mapper** (`frontend/src/lib/calendar/calendarErrors.ts`), because
they call the same two endpoints and a second copy is how one of them comes to translate a code the
other does not. Its load-bearing behaviour is the fallback: **a code nobody has translated yet reads
as the generic line, never as the server's English.** Translating the three known codes fixes three
sentences; refusing to print `.message` is what stops the fourth.

The agenda's two OTHER `.message` renders were load failures, closed by deleting the preference - the
fallback each line already declared was the right answer. With those gone `/calendar` and
`lib/components/calendar` have none, so both join `TREES` in
`frontend/src/lib/associations/serverProse.test.ts`, the guard that owns this rule. That is what
stops the next one: the guard is extended by a tree, never by an allowlist entry.

## A post created twice is the same post (2026-11-06)

`POST /api/posts` takes an optional `id` (a UUID minted by the client, `CreatePostDto.id`). The
post's PRIMARY KEY is the idempotency key, so no column and no migration were added. `createPost`
looks the id up first (`replayClientId`): absent, the post is INSERTED under it (`insert`, never
`save`, which would update a row); present and the caller's, the stored post is returned as if just
created (`[POST-CREATE] post <id> sent again`); present and another author's, `409`
(`clientIdVerdict`, `post-client-id.ts`). Two concurrent creates with one id meet at the primary
key: the loser's `23505` is read through `violatesUniqueColumns(e, ['id'])` and answered as a
replay (and the reel claim it made is NOT handed back - it is the winning row's). A request without
`id` keeps the server-generated one. The id must be a random UUID v4 (`@IsUUID('4')`: the nil UUID
and other versions are refused). The client that sends it is the background publish queue
([posts](../frontend/modules/posts.md#the-background-publish-queue)): a create whose answer was lost
is sent again with the same id.

**A deleted post is never created again** (decided 2026-11-06, review of #3061). Migration 135
(additive) adds `deleted_post_ids (id, "deletedAt")` and an `AFTER DELETE ON posts` trigger that
writes it, so EVERY hard delete path writes it - the service's delete, the account erasure, the reel
retention, a cascade, any later one - with nothing for a writer to remember. The table holds the id
and a date and nothing else: no author, no content. A create under a retired id is `410`.
`POST /api/posts/:id/withdraw {mediaIds}` is the queue's Delete: it writes the tombstone FIRST,
then deletes the row if one is there (`{ deleted }` says which), then deletes the named media the
queue uploaded EXCEPT any a live post, comment or salon message cites
(`PostMediaRetentionService.deleteWithdrawnMedia`, one SQL read of `posts.images`, the comments'
media and `channel_messages."reelMediaId"`, then media-service's
`internal/own-archive-delete` under the caller as uploader). A create racing it re-reads the
tombstone AFTER its own insert and removes itself, so in every interleaving the post does not exist
once the withdrawal answered. **Only ever the caller's own post, a platform admin included**: the
author is checked before the tombstone (`409`, nothing written) and again on the row it would
delete; another author's row that appeared between the two reads is left, the tombstone this call
wrote is deleted again, and the answer is `409`. The row is deleted as its author, never with the
admin flag, and WITHOUT releasing the ids the queue named (`deletePost`'s `keep`): released to
`ephemeral` they would no longer be `archive`, media-service would refuse them, and they would wait
out the idle sweep.

**The existence oracle, accepted.** A create naming an id answers `409` (another author's post holds
it) or `410` (a deleted post held it), which tells the caller that a post holds or held that id. Low:
the ids are random v4 UUIDs (122 bits) nobody guesses, and a live post's id is shown to everyone who
can read the post anyway. Tests: `post-client-id.spec.ts`, `posts.service.client-id.spec.ts`.

## Redis events published

The social-service publishes to `chat:channel_events`:

| Event | Emitted by |
|---|---|
| `channel.member.joined` | **channel creation**, join, invite accept, admin join, member added |
| `channel.member.kicked` | `kickFromWorkspace`, `leaveWorkspace` |
| `channel.member.removed` | `removeMemberFromChannel` |
| `channel.member.removal-released` | `releaseWorkspaceRemoval`, `releaseChannelRemoval` - to the scope's remaining members, never the actor; carries `releasedBy` and `releasedByDevice` |
| `channel.message.created` / `.deleted` | send, delete |
| `channel.updated` / `.deleted` | rename, **access change** (carries `viewerCanWrite` and `writePolicy`, one publish per verdict), delete |
| `workspace.updated` / `.deleted` | cover image change, soft delete |
| `workspace.role.permissions` | a role's permission set changed - addressed to the MEMBERSHIP, since every open grid draws it |

**`channel.member.joined` IS THE ACCESS-GRANTED EVENT, AND CREATION IS ONE OF ITS PATHS.** The name
reads as a person arriving, but what every publisher of it actually means is *this audience may now
read this salon, register it*, and the client handler is written to that: it adds the row to the
sidebar, puts the conversation in the store, and - for a private salon - enters its distribution
group through `registerJoinedChannel`. `createChannel` was the one writer of `allowedUsers` that
published nothing, which is why a private salon never reached the creator's other devices; it now
publishes like the other four. The audience always comes from `channelAudience`, so a private salon
reaches its roster and a public one the whole community, and the publish always happens AFTER the
row is saved - the audience is derived from access, so announcing first would address the event to
everyone except the person it is about.
| `channel.typing`, `channel.pin`, `channel.poll.vote` | live UI signals; typing goes to the channel audience MINUS the typist (user ids, so their other devices too) |

The chat-gateway subscribers fan out these events to all connected devices of the affected users.

### Deleting a community is irreversible, and the gate is a SERVER argument

`deleteWorkspace` used to archive. It now destroys, for the reason on
[community-rework](community-rework.md#axis-1---the-server-stops-being-able-to-read-the-reason-for-the-rework):
once Graine seals a channel, the two `UPDATE`s that "restore" an archived community restore
ciphertext no client holds a seed for - a community with its name, its slug and its storage intact,
listed by no screen and deletable by no route. **Recoverability that only recovers unreadable rows
is not recoverability**, and when a soft delete's whole justification is the restore, the soft
delete has become an orphan with a flag on it.

Turning a reversible control irreversible changes what every ALREADY DEPLOYED client is saying: its
"are you sure?" was worded for the old meaning. Shipping the server half alone would make those
clients destroy a community behind a warning that no longer describes what happens. The gate is
therefore a NEW argument they do not send - `confirmationName`, checked against `workspace.name`
server-side - so an old client fails closed. It is checked AFTER the permission checks, so a
non-admin cannot probe whether a name matches, and trimmed on both sides because a copied name
carries whitespace. **A confirmation only the dialog enforces is not a gate, it is a decoration on
one client.**

### Deleting a channel took no new argument, deliberately (2026-08-20)

`deleteChannel` made the same reversible -> irreversible move `deleteWorkspace` made two days
earlier, and did **not** take a `confirmationName` with it. The symmetry is tempting and would be
wrong, because the argument up there was never about symmetry: it was a gate against ALREADY
DEPLOYED clients whose "are you sure?" was worded for the old meaning.

That is a question about the string, and the string answers it. `chat_delete_channel_confirm` has
read "Supprimer definitivement le canal #{channel} ?" since `5babb466` (2026-06-16), the first
version of it that ever shipped. **Every client in the field already promises exactly what the
server now does**, so there is nothing to fail closed against, and an argument would break working
clients for no gain. The rule the community case actually establishes is *check what the deployed
clients say before changing what the server means* - not *add a token whenever a delete becomes
real*.

The two also differ in blast radius, which is why the DIALOG keeps the typed name only on the
community: a salon is one room and its deletion is a moderation gesture, a community is destroyed
for everyone at once.

### Removal events are fan-out, and the payload is the only discriminator

`channel.member.kicked` and `channel.member.removed` go to **every remaining member as well as
the person being removed** - the remaining members need them to keep their own view in sync. So
receiving one means nothing on its own, and two payload fields carry the entire meaning:

- `kickedUserId` / `removedUserId` - the target. A client that acts without comparing it to its
  own user id purges state on somebody else's behalf.
- `isPrivate` - on the channel-scoped removals only. A **public** channel stays readable by every
  workspace member, so removing someone from one changes nothing they hold, and the client must not
  drop it (a reload would bring it straight back).

A community-wide removal (`kickFromWorkspace`) carries **no `channelId`**: that absence is what
tells the client the whole workspace is gone. Client side: `removalOutcome` in
`utils/chat/memberRemoval.ts` is the single place that reads these rules.

### A channel-scoped action never touches community membership (2026-08-17)

Access is stored at two different scopes, and they are not interchangeable:

| Scope | Where it lives | Who it admits |
|---|---|---|
| Community | a `channel_members` row (`workspaceId` + `userId`) | the whole community, and **every public channel in it** |
| Private channel | `channels.allowedUsers` | an existing community member, into that one channel |

A public channel therefore has **no row naming any individual member**. Nothing about it can be
given up, which means "leave this public channel" is not an operation this model can express, and
`leaveChannel` answers `400` rather than pretending otherwise - a `{ success: true }` that removed
nothing is a lie the next refetch exposes, since the channel comes straight back.

It used to delete the community membership row instead, and that is the whole of a user-reported
defect: **leaving one public channel put you outside the community while your client still showed
it.** The list is local until the next refetch, so the community stayed on screen with its
channels, and every workspace-scoped call then answered `NotFoundException: Not a member of this
workspace` - "leave the community" included. Unmanageable rather than gone, which is why it read
as a bug about the *last* channel: that is when the community becomes visibly empty, but any
public channel did it.

Measured on prod the day of the fix: **one user, ejected from six communities** they had written
in, still a member of nine others. The query finds authors of channel messages with no membership
row in that channel's workspace - candidates, never proof, because a deliberate
"leave the community" deletes the same row and leaves the same trace. Nothing can restore them
automatically for the same reason; they have to be re-invited.

`removeMemberFromChannel` already had the rule right, and its docblock is the reference: for a
public channel it only rotates the key, "the user is still a workspace member". The channel-scoped
`kickMember` (`POST :channelId/members/kick`) carried the same defect and was **deleted** - it had
no call site in any shipped client, and the two operations that do exist are correct at their own
scope (`removeMemberFromChannel` for a channel, `kickFromWorkspace` for a community).

### A community always has an admin, or it has no members (2026-08-18)

One postcondition, enforced at every point where a member can stop being one. The full audit that
produced it - with the prod figures - is [community-rework](community-rework.md#axis-2---a-community-can-never-be-left-ungoverned---shipped-2026-08-18);
this is what the code does.

| Operation | What it checks now | Refusal |
|---|---|---|
| `leaveWorkspace` | the leaver is not the sole admin while others remain | `400` early, `409` under the lock: `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `kickFromWorkspace` | the TARGET's roles, which it never consulted before | `400` early, `409` under the lock: `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `updateWorkspaceMemberRole` | the new role still carries `workspace.manage`, or another admin exists | `400` early, `409` under the lock: `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `setRoleBasePermission` (revoking `workspace.manage`) | someone still holds a role carrying it, or the community has no members | `409 WORKSPACE_WOULD_HAVE_NO_ADMIN` (asked under the lock only) |
| `acceptWorkspaceInvite`, `inviteToChannel` (a new member) | the community still has at least one member | `404 WORKSPACE_HAS_NO_MEMBERS` |
| `internal DELETE users/:id` | cannot refuse - repairs instead, see below | - |

**The check is asked twice: early, then under the lock where the write happens (2026-10-26).** The
early answer (`400`) comes before anything is asked of another service, and it cannot see a write
that commits after it. So every write that can shrink the admin set runs inside the community
removal lock (`withCommunityRemovalLock`, or the departure's roster write) and decides again there,
from what holds then; the one that would break the invariant is refused `409
WORKSPACE_WOULD_HAVE_NO_ADMIN` and writes nothing. The client names the code whichever status
carries it (`describeCommunityRefusal`), the role-permission grid and the member role picker
included. What holds, exactly:

- **A leave and a kick** ask `assertExitKeepsAnAdminLocked` in their roster write.
- **Every role change** (`updateWorkspaceMemberRole`) writes under the lock, whatever its early
  reads said. There it reads again the target's row, the actor's row and the roles of both and of
  the new role - the role rows share-locked, so no permission edit lands before the commit - and
  decides from them: the actor's bound (`actorMayGrantRole`, and `role.manage` itself), whether the
  change now DEMOTES (a role that lost `workspace.manage` since the early read makes a promotion a
  demotion), and, if it does, the last-admin postcondition. A target re-roled since the early read
  is refused `409 MEMBER_CHANGED_MEANWHILE`.
- **Every edit of what a role grants** (`setRoleBasePermission`) and **every role creation**
  (`createRole`) write under the lock, taken before the role row. There the actor's row and roles
  are read again, and the actor's right to manage roles and its bound (`actorMayGrantRole`) are
  asked of them. A revoke of `workspace.manage` also recomputes the admin set with the role's new
  permissions, and is refused when it would be empty while the community has members.
- **An account erasure** decides under the lock too, see below.
- **An admission** (an invite link accepted, a salon invitation that creates a membership) asks
  under the lock that the community still has members, and a salon invitation also asks there that
  the inviter still holds a right to invite. **An invite link is written under the lock too**
  (`createWorkspaceInvite`), after the actor's right to invite is asked again there; an erasure that
  closed a community emptied its account's roles under the same lock, which is what refuses a link
  then (the members check that follows is redundant defence). A community with no members therefore admits nobody, and stays empty until it
  is deleted.
- **A community's deletion** (`hardDeleteWorkspace`) asks its premise under the lock BEFORE its
  first call to another service (the key groups): an administrator's deletion, that the deleter
  holds `workspace.manage`; the last member's departure or an erasure, who is still a member. The
  membership premise is asked again in the transaction that deletes the rows, which opens with the
  lock; the deleter's right is not, since the key groups are gone by then and the rows must follow: an admission, a departure or a role change
  commits before it (and is deleted with the community) or waits and finds it gone.

**One lock order: the removal lock, then salon rows, then member and role rows.** A departure locks
its community's private salons (`ORDER BY id`) BEFORE its guard reads member and role rows; a salon
grant (`grantPrivateChannelAccess`) locks the salon before the grantee's row; a role change
share-locks the role rows it decides on before its member `UPDATE`; a deletion deletes salons
before members. So no two of them can each hold what the other waits on. The member rows read under
the lock take no row lock of their own: every departure, every role change (an erasure's promotion
included) and every admission holds the removal lock, and under READ COMMITTED a statement run after
taking it sees the previous holder's commit. Other member-row writes (a voucher, a sort order, a
read mark) take no removal lock; none deletes a row or touches `roleIds`, so none changes the
answer asked here. Proven on PostgreSQL by `last-admin.integration.spec.ts`: each race commits (or
starts) the second operation from a hook inside the first - after one of its reads, or inside its
first call to chat-delivery - and, where the second must be waiting on a lock before the first goes
on, waits for PostgreSQL to report it waiting, never for a clock. Every race case there fails on the
code before 2026-10-26 (two with `40P01 deadlock detected`); the revoke case is a plain refusal, not
a race.

`listWorkspaceAdminIds` is the single definition of "admin": a member holding a role whose
permissions include `workspace.manage`. It is the permission that can grant every other one back,
and therefore the only one whose disappearance a community cannot recover from on its own.

**Every ending goes through `hardDeleteWorkspace`**: the last member leaving, the last member being
kicked, an account deletion that empties the community, and an admin deleting it. One transaction,
six tables in dependency order - `channel_messages`, `channel_members`, `channel_roles`,
`workspace_invites`, `channels`, `channel_workspaces` - because there is not one foreign key on
`channel_workspaces` or `channels` to cascade, so a table left out becomes orphan rows nobody sees.
Those six are the complete set: no other table in the database carries a `workspaceId` or a
`channelId` (checked against `information_schema` on prod, 2026-08-18). `channel_key_distributions`
was a seventh until the Graine rework dropped the table. Attached media are left to the retention
sweep, which collects them once nothing accesses them again. Each caller names who may still be a
member when the rows go (`anyone` for an admin's deletion, `nobody` after the last departure, the
erased account alone for an erasure), asked under the lock; anyone else there refuses the deletion
and is logged at error.

**Account deletion is the one path that cannot refuse.** It bypasses every guard above, because
the account is going regardless. `ChannelService.removeAccountFromWorkspaces` takes each community
in turn (`removeAccountFromOneWorkspace`), and the account's membership row is always the LAST thing
to go, so a failure at any step leaves it and the erasure queue's retry finds the community again
([account-erasure](../account-erasure.md)); a swallowed failure used to strand an adminless
community for ever.

- **The account is the last member** (`closeCommunityOfLastMember`, under the lock): the community's
  invite links are deleted and the account's roles emptied, so neither door admits anyone, then the
  community is hard-deleted, the account's row with it.
- **Otherwise the account departs**, with `promoteSuccessorAdmin` as the departure's guard: under the
  lock, in the transaction that deletes the account's row, a community left with members but no
  admin promotes the survivor with the highest priority, then whose roles grant the most distinct
  permissions, then the lowest user id (custom roles all rank just above the base role, so among
  them what they grant decides). Logged at `warn`, because an automatic promotion is something a
  human should be able to find afterwards. When everyone else left meanwhile, the guard refuses the
  departure (the row stays) and the community is taken again as the last member's, up to three
  times before the queue retries.
- **No role carries `workspace.manage` at all**: the community was ungoverned before the erasure,
  and the erased account was no admin of it, so its departure changes nothing about who governs.
  The departure goes on, and the fault is logged at error - this path cannot repair it.

### One invite link, bounded (2026-08-18)

`createWorkspaceInvite` returns THE community's live token and mints one only when there is none.
`rotate: true` is the only way to get a new token, and it revokes the previous in the same call, so
opening the panel cannot invalidate a link somebody already shared. Tokens still live from before
this rule are revoked on the first call, keeping the newest - the one a human most plausibly shared
last.

`expiresAt` and `maxUses` travel back with the token, because a token alone cannot say whether it
expires. Bounds that would mint a dead link - an expiry already past, a cap below one - are refused
(`INVITE_EXPIRY_INVALID`, `INVITE_EXPIRY_IN_THE_PAST`, `INVITE_MAX_USES_INVALID`) rather than stored,
since `inviteIsValid` would otherwise hand back a token dead on arrival with nothing saying why.

**Invite use counting is atomic (2026-10-22).** `acceptWorkspaceInvite`'s read of the invite is a
preview; what admits is ONE conditional `UPDATE workspace_invites SET uses = uses + 1 WHERE id = $1
AND revoked = false AND (not expired) AND ("maxUses" IS NULL OR uses < "maxUses") RETURNING id`, in
the transaction that writes the membership. The row lock serialises concurrent accepts, each
re-evaluates the WHERE against the committed count, and a claim that matches no row is refused
(`404`) with nothing written. Pinned by `workspace-invite.integration.spec.ts`,
which parks an accept on a held claim through `pg_blocking_pids`, never a sleep.

### An invitation grants only a role the inviter may grant (2026-10-22)

An invite LINK carries no role: whoever minted it, accepting grants the community's base role,
its lowest-priority one (`baseMemberRole`, the one definition). A direct invitation
(`inviteToChannel`) takes a `roleName` in its body, and since inviting is `member.invite` or
`channel.manage` while granting a role is role management, it grants the base role unless
`actorMayGrantRole` (`permissions.ts`) allows the named one: the actor holds
`roleGrantsRoleManagement` - the same predicate every role-management endpoint now reads - and the
role grants nothing the actor does not hold (`workspace.manage` holds everything). Otherwise
`403 { code: 'INVITE_ROLE_NOT_GRANTABLE' }`, decided before the device lookup, never a silent
downgrade. A named role is matched by its own name first, so a role literally named `Membre` above
the base role is granted under the same right as any other (since 2026-11-11, once
`minClientVersion` passed `v1.4.0`); only where no role carries the name does `Membre` (or `member`)
mean the base role. The client sends no `roleName` at all for an ordinary invitation since #2277,
and names a role only when the inviter picked one.

**Role changes are bounded by the actor's own permissions, by the same function.** Every
role-management write goes through `assertActorManagesRoles` (the `roleGrantsRoleManagement` gate,
returning the union of what the actor holds) and then `actorMayGrantRole`:

| Write | Bound | Refusal |
|---|---|---|
| `updateWorkspaceMemberRole` | the new role AND the target's current roles grant nothing the actor lacks - the actor's own membership included | `403 ROLE_CHANGE_EXCEEDS_ACTOR` |
| `setRoleBasePermission` | the role being edited grants nothing the actor lacks (their own role included), and a granted key is one they hold; checked on the LOCKED row | `403 ROLE_CHANGE_EXCEEDS_ACTOR` |
| `createRole` | the new role grants nothing the actor lacks; it ranks just above the base role (`priority` is the server's, the body's is not read) | `403 ROLE_CHANGE_EXCEEDS_ACTOR` |

### Removals are bounded by the actor, and so is hiding a salon (2026-10-24)

**Removals are bounded by the actor's own permissions, by the sibling predicate.**
`kickFromWorkspace`, `removeMemberFromChannel`, every member an access-list rewrite takes the salon
from (`updateChannelAccess`: the audience before - the allowlist, or the whole community while the
salon is public - minus the allowlist after, so going private counts every member left off), and
every member a private salon's creation leaves off (`createChannel`: everyone but the creator) share
one gate, `assertActorMayRemoveMembers`: the actor holds `member.kick`, `channel.manage` or
`workspace.manage`, and `permissionsCover` - the "holds at least as much" that `actorMayGrantRole`
is built on - holds between the actor's permissions and each target's. Otherwise
`403 REMOVAL_EXCEEDS_ACTOR`, which the client names (`COMMUNITY_REFUSALS`, as
`ROLE_CHANGE_EXCEEDS_ACTOR` and `INVITE_ROLE_NOT_GRANTABLE`). An allowlist entry whose user is no
longer a member has nothing to compare and is dropped. **Only high ranks make a salon private while
an administrator exists** (user, 2026-10-24): a member holding only `channel.manage` can neither
create a private salon nor make one private while it leaves off someone who outranks them.

**The gate is asked twice: early, then under the lock.** The early answer comes before any call to
chat-delivery, so a refused removal mints no group and begins no departure. The authoritative one
runs inside the roster write of the departure (`departDistributionGroups`, which opens its
transaction with the community removal lock, `pg_advisory_xact_lock` on
`community_removal:<workspace id>`), or inside `withCommunityRemovalLock` for a private creation,
and reads the actor's and every target's membership and role rows `FOR SHARE`. A role change writing
any of those rows waits for the removal to commit, and a removal that started after a role change
waits for it and reads the committed roles - so what was compared is what holds when the removal is
saved. A refusal there abandons the departure, which is settled `cancelled`. No call to
chat-delivery runs under the lock: the first evictions precede it, the second follow the commit
([channel-encryption](../protocols/channel-encryption.md), "WP-21, and the gate it had nowhere to
live").

**The salon row is re-read `FOR UPDATE` in that transaction.** A roster write (`stripFromChannels`)
removes the user from the locked row, never from the copy read before the lock, so an add granted in
between is kept. An access-list rewrite compares the locked row's `accessRevision` with the one its
removals and first evictions were computed from; if any access write landed since, it is refused
whole with `409 CHANNEL_ACCESS_CHANGED`, which the settings panel names: the visibility, the
allowlist and the write policy are left as the other edit wrote them, and a departure the first
evictions began is settled `cancelled` like any abandoned one.

### A member write updates columns, never saves the row it read (2026-10-25)

**A member write must never insert a row.** A TypeORM `save` of a stale entity inserts it again,
every column included, when the row was deleted in between - and also reverts every column a
concurrent writer changed since the read. So a write to an existing row (`channel_members`,
`association_members`, `channel_workspaces`) is ONE column-scoped `UPDATE` keyed by the row's `id`,
and `affected !== 1` refuses the call with nothing written:

- `setNotificationLevel` merges its one key in SQL (`notifLevels || jsonb_build_object`), so two
  devices setting two salons keep both; 0 rows is `403`.
- `updateWorkspaceMemberRole` and the association `updateMemberRole` are CONDITIONED on what their
  bound was judged against (`AND "roleIds" = :judged`, `AND permissions = :judged`): 0 rows - the
  member was re-roled or removed since - is `409 MEMBER_CHANGED_MEANWHILE`, which the client names.
- `updateWorkspaceImage` and `updateWorkspaceHistoryVisibility` write their one column; 0 rows is `404`.
- The successor an account erasure promotes is chosen under the community removal lock, in the
  departure that deletes the account's row; every departure and every role change holds that lock,
  so the rows it reads are current for that choice without a row lock (see
  [the last-admin section](#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18)).

Proven on PostgreSQL by `member-write-gone.integration.spec.ts` and
`association-member-write-gone.integration.spec.ts`, each committing the other write between the read
and the update. `save` stays for a row the call itself creates.

**The same holds for a user's moderation record, a report and a role history entry:**

- `muteUser` is ONE `INSERT ... ON CONFLICT ("userId") DO UPDATE` (the column's unique index), with
  no read first, so two first mutes leave one record; `unmuteUser` is one `UPDATE` by user, `404` on
  0 rows.
- `reviewReport` writes its three review columns by id with no read first, and re-reads the row for
  its answer: a party rewritten since stays as written, and 0 rows is `404`.
- `updateRoleHistory` is CONDITIONED on the year its range check judged: an edit setting one year
  only bounds its `UPDATE` with the OTHER year as read (`IS NULL` for none); a title-only edit, or
  one setting both years, judged no stored year and is bounded by id and owner only. 0 rows answers
  `404` when the entry is gone or no longer the caller's, and `409` when the judged year changed
  meanwhile.
- A tag's grant or renewal is one statement as well
  ([cotisations](../cotisations.md#a-grant-or-renewal-is-one-statement-never-a-save-of-the-tag-it-read-2026-10-25)).

Proven by `users/user-grant-write-gone.integration.spec.ts`, with the concurrent write committed
from inside the service's own repository call.

### An access rewrite names the revision it edited (2026-10-25)

**The lock only protected the server's own read, never the client's.** The settings panel reads a
salon's access once, when its tab opens, and every gesture there (a grant, the visibility toggle, the
write policy) PATCHes the WHOLE list it holds. With no base in the request, `updateChannelAccess`
diffed that list against its own fresh read, so anyone granted after the panel loaded fell in
`dropped`: cut from the salon's key distribution and its list, answered 200, nothing on either
screen. Reproduced on `1.4.1-alpha.3`: panel A showed two allowed, B granted W4, A granted W5 - W4 was
cut (`reason=access_updated`, a `departed` row). The `FOR UPDATE` comparison could not see it: the
grant had committed before the rewrite's read.

**`channels."accessRevision"`** (migration 111, `int NOT NULL DEFAULT 0`) is raised by one on every
write of `isPrivate`, `allowedUsers` or `writePolicy`, by EVERY writer: the rewrite itself, a grant
(`grantPrivateChannelAccess` - an admin's join, an invitation into a private salon), a roster strip
(`stripFromChannels` - a per-member removal, leaving a salon, a community departure or kick), and the
account erasure's name drop. A writer that changes nothing (a strip of a user not listed) leaves it.

- `GET /:channelId/access`, a successful `PATCH` and the per-member `DELETE /:channelId/members/:userId`
  all answer the same shape, `channelAccessState`: `isPrivate`, `allowedUsers`, `writePolicy`,
  `accessRevision`.
- `PATCH /:channelId/access` takes `baseAccessRevision`. A base other than the row's is refused
  `409 CHANNEL_ACCESS_CHANGED` BEFORE anything is minted or evicted, and again under the row lock;
  the body carries `current`, the access as it stands. Two rewrites at the same base: exactly one
  saves, the other is refused (pinned against PostgreSQL in `removal-bound.integration.spec.ts`,
  together with the reproduced sequence above).
- **The panel follows the revision.** Every gesture sends the one it holds. After a success it adopts
  the answer when the answer is exactly `base + 1` (its own edit and nothing else), and reads the
  access again otherwise; on `CHANNEL_ACCESS_CHANGED` it reads the access again and THEN names the
  refusal, so the admin decides on the real list. Consecutive gestures need no reload.
- **A request with no base (a client older than the revision) is read as the one gesture it can
  be** (`baselessAllowList`). Every client the `1.0.3` floor admits runs the panel of `v0.18.29`:
  Add sends the list it read plus its pick LAST, no write policy; the toggle sends the list and the
  other visibility, empty when going private; the write policy sends the list, the visibility it
  read and the policy. So a salon that stays private gains at most that last name (none on a policy
  save) and loses nobody - an absence is not a removal, and a name present may have been revoked
  since; and a request flipping the visibility WITH a write policy, or going private WITH a list,
  is a panel that read the other visibility and is refused `409`. The shim and its removal are in
  [legacy-compatibility](../legacy-compatibility.md).
- **The per-member `DELETE` answers the row it locked, whole**: `stripFromChannels` copies the
  visibility and write policy with the list and revision, so a panel adopting it at `base + 1` never
  pairs that revision with a visibility read before the lock.
- **The panel makes one access write at a time**: two of its own in flight would share a base, and
  the second would be refused by the first.
- **Rollback:** an image older than migration 111 writes no revision, so after rolling back and
  forward a panel opened before the rollback can save over a write the old image made. A public salon made private gets its distribution group
before the lock; when the change is then refused, the group is left, not retired: its id stays on the
row, inert while the salon is public, reused by the next flip (the mint is idempotent), and possibly
the group of a concurrent flip that did commit.

**Nothing writes a salon row from a copy read without a lock.** TypeORM's `save` re-reads the row
and writes back every column the copy differs on, so a save of a stale copy reverted whatever a
concurrent edit had committed - an admin's flip could make a salon public again, outside any lock,
and the check under the lock would then pass. The group id (`ensureChannelDistributionGroup`,
`retireChannelDistributionGroup`) and a rename write their one column with `update`; a grant (an
admin joining a private salon, an invitation into one) adds the user to the row re-read `FOR UPDATE`
in its own transaction (`grantPrivateChannelAccess`), so it cannot restore a member a removal has
just taken off. The same transaction share-locks the grantee's membership row (and, for an admin's
join, the roles granting `workspace.manage`), so a grantee kicked or demoted since the caller's reads
gets nothing. An invitation into a salon deleted meanwhile answers `404` and announces nothing - a
`public` event would hand the private salon's name to the community. A departure from the community
re-reads its private salons row-locked in its roster write, and a salon granted since its first read
(whose group it never cut) supersedes it. `removeFromWorkspace` retries such a departure inline, up to
three, each from a fresh read; only a race that outlasts them answers `409 DEPARTURE_SUPERSEDED`,
and an account erasure counts that answer as transient, so its queue retries instead of giving up.
An invitation into a salon deleted meanwhile also takes back the membership it created (a departure
with reason `invite_withdrawn`), so the `404` leaves nothing half-made.

**Lock order.** Salon rows are locked before membership rows everywhere: the grant (salon, then the
grantee's membership), a departure (the removal lock, all the community's private salons, `ORDER BY
id`, then its guard's member and role reads and the membership delete), and `hardDeleteWorkspace`
(the removal lock, then salons deleted before memberships). An access-list rewrite takes the removal
lock, then its salon, then the community's membership rows, share-locked.

### Every writer that ADDS to an allowlist asks membership under a lock a kick also takes (2026-10-25)

**The lesson: a check re-asked under a lock must cover what the save ADDS, not only what it
removes.** An access-list rewrite re-checked its stale revision and the members it dropped under the
community removal lock, and never asked whether the people it granted were still members. A kick
that strips no salon does not move the revision, so a kick committed while the rewrite waited on the
lock was invisible to it - and the kick's own re-read sees only a grant committed BEFORE it. Found by
cross-client row RM-5.

**The rewrite asks it, twice, in the order every removal check already uses.** Early, before the
salon's group is minted or any eviction begins, an unlocked preview (`assertGranteesAreMembers`
beside the early `assertActorMayRemoveMembers`) refuses a grant of a non-member outright. Under the
lock, the community's membership rows are read ONCE, share-locked, and handed to both checks: the
actor's first (a kicked actor is answered `403`), then the grantees. Anyone absent refuses the whole
save `409 CHANNEL_GRANTEE_NOT_MEMBER` with `current`, nothing written; the locked answer is the
authority. Matched case-blind (an allowlist entry is lowercased, a membership row keeps its id as
written). Only the names the save adds are judged - every name, when the salon becomes private.
The panel reads the access again on that code, clears its pending pick, refreshes the member list it
offers, then names the refusal (`chat_channel_grantee_not_member_error`); an older client shows its
generic line. Not retryable as sent.

**The other writers, audited - each already asked membership under a lock the kick serialises
with:** `grantPrivateChannelAccess` (an admin's join, an invitation into a private salon) re-reads
the salon `FOR UPDATE` and the grantee's membership `FOR SHARE`, and the kick locks salons before
deleting the membership; a private `createChannel` names only its creator, who is the actor
`assertActorMayRemoveMembers` re-reads under the removal lock. Strips, the per-member `DELETE`,
leaving a salon and the erasure only remove; nothing outside social-service writes `allowedUsers`.
A kick already strips every private salon naming its target from a row-locked re-read under the
same lock, so no separate sweep is added: with every adder checked there, it would heal a state
nothing produces. Pinned by `removal-bound.integration.spec.ts` (the kick committed while the
rewrite is parked on the removal lock, the reverse order, a mixed-case membership id, and a flip
whose actor was kicked while it waited).

Pinned by `removal-bound.integration.spec.ts` (PostgreSQL: the gate parked on an uncommitted role
change through `pg_blocking_pids`, the removal lock, a rewrite raced by another, a flip computed
from a public row another admin made private while its mint was in flight, a private creation,
no advisory lock held at any call to chat-delivery) and `removal-bound.spec.ts`.

`workspace.manage` holds every permission, so an administrator keeps all of it. Pinned by
`role-change-bound.spec.ts` and `removal-bound.spec.ts`.

### A membership carries the admission a member signed (2026-10-22)

`channel_members."admissionVoucher"` (migration `107`, nullable text) holds the voucher a member's
device signed for this membership: sent as `admissionVoucher` with a member's add
(`POST /api/channels/:channelId/members/invite`) and with a link's accept (body of
`POST /api/channels/invites/:token/accept`, written onto an existing row too, and onto a new one in
the transaction that counts the invite's use). The service checks
only that it is base64url and at most 4096 characters (`ADMISSION_VOUCHER_INVALID` otherwise) - it
cannot verify it, and the members do. The workspace roster serves it with `isCreator`. Why, and the
format: [channel-encryption section 25](../protocols/channel-encryption.md#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22).

### A user id becomes a property name, and four sites spelled the refusal differently (2026-09-23)

Reactions and poll answers are both stored as a map KEYED BY USER ID (`reactions`, `votesByUser`),
so a string off a request becomes a property name. Four sites guarded that, and no two of them
agreed: `addReaction` and `removeReaction` listed three names, the channel poll's vote listed three,
`sanitizeReactions` listed five - `__defineGetter__` and `__defineSetter__` in exactly one of the
four. A list that differs by site is a list that is wrong at every site but one, and nothing would
have failed if a fifth had been written with two names. It is now `src/common/object-keys.ts`, one
`isUnsafeObjectKey`, imported by the three services.

`Object.create(null)` answers the other half where a map is written in place: a prototype-less
object has nothing to walk into, and both vote paths re-establish it on a stored map before writing,
since a jsonb round trip hands back an ordinary object. **What it does not stop is the map CARRYING
a key of that shape**, which then travels to every reader of the poll and into JSON - which is why
`votePoll` now REFUSES the identifier where it enters, as the channel path already did, and why
`normalizePolls` SKIPS one while rebuilding a map from stored votes: those rows were written by a
`votePoll` that has refused them only since this same day.

Where a map is BUILT rather than updated, neither is needed: `normalizePolls` accumulates the tally
in a `Map`, which has no property names to shadow, and `Object.fromEntries` materialises it as own
data properties at the end. That is also the only form CodeQL accepts - `js/remote-property-injection`
does not read a predicate in another module as a barrier, and a guard a scanner cannot see is one
the next reader will delete.

`forms.service.ts` reaches the same conclusion from the other direction and is the better shape
where it applies: the declared question ids are an allowlist, so nothing else can be a key at all.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `INTERNAL_SECRET` | yes | Shared secret for service-to-service calls |
| `MEDIA_SERVICE_URL` | yes | Internal URL for media-service (blob proxy) |
| `CORE_SERVICE_URL` | yes | Internal URL for core-service (user/payment verification) |
