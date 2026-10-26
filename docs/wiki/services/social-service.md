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
- **Forms**: dynamic form builder with optional Stripe payment, cash payment validation.
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
| PATCH | `/api/posts/:postId/pin` | Pin post (admin only) |
| PATCH | `/api/posts/:postId/unpin` | Unpin post (admin only) |
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
| POST | `/api/channels/workspaces` | Create workspace |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces; each carries `viewerCanManage` (true iff the caller holds MANAGE_WORKSPACE) and `viewerCanManageChannels` (`roleGrantsChannelManagement`: `channel.manage` or `workspace.manage`) so the client can gate admin controls without deriving permissions itself. Ordered by the caller's personal `sortOrder` |
| PATCH | `/api/channels/workspaces/reorder` | Persist the caller's top-to-bottom community order (`{ orderedIds }`, workspace ids). Personal per-member setting, stored on `channel_members.sortOrder` (migration 024) - not shared across members of the same workspace |
| GET | `/api/channels/workspaces/:workspaceId/members` | The whole community roster. Exists for the caller that holds no channel id - a device that has just joined the Graine distribution group and must name who to ask for history |
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
| DELETE | `/api/channels/workspaces/:workspaceId/members/:userId` | Remove a member from the whole workspace (MANAGE_WORKSPACE / MANAGE_CHANNEL / KICK_MEMBERS) |
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
  posting: `everyone` (default), `admins_moderators` (roles with `channel.moderate` or
  `workspace.manage`), or `admins` (`workspace.manage` only). Enforced in `sendMessage` via
  `canWriteToChannel`; used for announcement-style channels. Set from the channel settings "Accès" tab.
  **`writePolicyAllows` in `permissions.ts` is the only definition of the rule**, and three callers
  read it: `canWriteToChannel` per message, `getWorkspaceBySlug` for the `viewerCanWrite` it projects
  on every channel, and `writeDecisionsFor` when the policy changes. The client is sent the DECISION
  and never the policy - it holds no roles to apply one - and `ChatArea` replaces the composer with
  `chat_channel_read_only` when the answer is no. Absent means YES, deliberately: a client too old to
  be sent the field fails open onto the server's refusal, which is the guarantee.
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
internal push path) to the caller's own devices. Sibling devices in the background cancel that
channel's notification (`cancelConversationNotification("channel_<uuid>")`); the reading device
ignores it (foreground guard). This mirrors the MLS DM/group behaviour, where a self read-receipt
push clears the conversation's notification on the user's other devices.

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
  on arrival; the receipt waits for the same focus guard and 2 s debounce as a DM's
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

**"Mark as read" from a salon NOTIFICATION, app shut (Android, 2026-10-10).** A shut phone has no session, so the two public calls above are out of reach. Its action calls chat-delivery's `POST /api/mls/push/channel-read` `{ userId, deviceId, channelId, at }` under `Authorization: PushSecret` (which proves the caller is a device of `userId`); chat-delivery forwards it with `x-internal-secret` to `POST /api/internal/channels/:channelId/read` (`InternalChannelReadController`, never exposed by the edge), which runs `advanceChannelReadMark` (membership still checked here, `at` bounded by the newest message) and then `markChannelRead` so the user's other devices clear their banner. `at` is the notification's own `createdAt`, never the phone's clock. A refused or failed call is logged on both sides (`[CHANNEL_READ_PUSH]`) and never retried: the banner is already gone locally and the receipt rises the next time the salon is opened. Reply is NOT offered on a salon: see [mobile](../frontend/mobile.md#a-salon-mark-as-read-only-and-why-reply-is-not-offered-decided-2026-10-10-android).

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
(see [chat-delivery](chat-delivery.md)). Android is unaffected: it has one poster, and its
`groupId → notifId` map is written by that poster.

### Forms (`/api/forms`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/forms` | Create form |
| GET | `/api/forms` | List caller's forms |
| GET | `/api/forms/:id` | Get form definition |
| POST | `/api/forms/:id/submit` | Submit form (with optional Stripe or cash payment) |
| GET | `/api/forms/:id/submissions` | List submissions (owner only) |
| POST | `/api/forms/:id/image` | Upload form banner image |

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
| PATCH | `/api/associations/:id` | Update association (admin with `MANAGE_MEMBERS`) |
| GET/PUT/DELETE | `/api/associations/:id/push-mute` | The caller's push mute of one association; `GET /api/associations/me/push-mutes` lists them |
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

**The Lydia Business private token is write-only (2026-10-16, migration 100).** `PUT :id/lydia-business-key`
(`canManagePayoutAccount`) stores it encrypted (`common/secret-box.ts`, `LYDIA_KEY_ENCRYPTION_SECRET`,
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
| Recipients | everyone who can SEE the post (`announceRecipientsSql`, WP6b), minus its author | the author's followers (`user_follows`) who can see it |
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

### Follow, mute and read grants: three different facts (decided by the user, 2026-10-08)

| | What it is | Does it decide who is PUSHED? |
| --- | --- | --- |
| **Follow** (`association_follows`, button "Suivre") | a reading preference: it feeds the "followed" view of the feed | **No.** Every association post is pushed to everyone who can SEE it; the follow table is not consulted for announcing (STATUS QUO, chosen on purpose) |
| **Mute** (`association_push_mutes`, migration 080) | "stop pushing me THIS association", and only that | **Yes - it removes the recipient from the PUSH**, never from the feed or the bell |
| **Nominative read grant** (`read_grants`) | access to read | **No.** A read grant is access, not subscription: its holders are not announced to |

**Where a mute is applied: ONE place, server-side.** `PostNotificationsService.createNotifications`
asks `AssociationPushMutesService.mutedAmong(associationId, recipients)` just before the push loop
and drops the muted. The in-app `post_notifications` row is still written (the bell is the record, a
push is the interruption), and the announce SQL is untouched. Nothing is filtered by the client, and
no cache or feed key is involved.

**If the mute lookup fails the push FAILS CLOSED and LOUD**: `[NOTIFY] mute lookup failed` at error level, the error rethrown to the caller's own warning, the in-app rows kept. Pushing everyone would override a stated choice. The announce stamp is a CONDITIONAL update (`feedNotifiedAt IS NULL`), so two overlapping instances cannot both announce a post. Account deletion purges the account's mutes (`internal.controller.ts`).

**Per type, and the list is an ALLOWLIST** (`MUTABLE_PUSH_TYPES`; a new type is never muted by
accident):

| Type | Recipient is | Muted by a mute? |
| --- | --- | --- |
| `association_post` | a reader | yes |
| `association_repost` | a reader the republication newly reached (the mute is the REPUBLISHING association's) | yes |
| `live_started` | a follower of the association broadcasting a live (WP-L7; push only, no bell row - `pushNotice`, [lives](lives.md#the-push-to-the-followers-wp-l7-server-half)) | yes |
| `repost_proposed`, `coorganise_proposed` | managers who must accept | **no** - operational |
| `repost_personal_requested` | the author of a personal post an association asks to carry (D38b) | **yes** - the author's mute of the asking association |
| `event_proposed/validated/rejected/updated/deleted/pending` | validators and proposers | **no** - operational |
| `followed_post`, `mention`, `reply`, `reaction`, `comment` | addressed to you by a person | **no** - not an association's push |

**Routes** (own rows only: the caller's id is the `x-user-id` header, never a body field):
`GET|PUT|DELETE /api/associations/:id/push-mute` (status, mute, unmute - idempotent) and
`GET /api/associations/me/push-mutes` (the settings list). UI: a "Couper les notifications" button
beside "Suivre" on the association page, and a "muted associations" list with an unmute button in
the notification settings (`SettingsMutedAssociations.svelte`). The account-wide `posts` switch
still applies first, in chat-delivery.

**Measured on the local estate (2026-10-08, sandbox accounts, a build of this branch beside the
old container).** Association post, recipients: follower, muted follower, non-follower member. The
new build logged `push withheld from 1 muted of 3` and pushed the other two; the pre-mute container
pushed all three (`[INTERNAL_PUSH]` in chat-delivery), which is the baseline.

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

## Redis events published

The social-service publishes to `chat:channel_events`:

| Event | Emitted by |
|---|---|
| `channel.member.joined` | **channel creation**, join, invite accept, admin join, member added |
| `channel.member.kicked` | `kickFromWorkspace`, `leaveWorkspace` |
| `channel.member.removed` | `removeMemberFromChannel` |
| `channel.message.created` / `.deleted` | send, delete |
| `channel.updated` / `.deleted` | rename, **access change** (carries `viewerCanWrite`, one publish per verdict), delete |
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
| `leaveWorkspace` | the leaver is not the sole admin while others remain | `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `kickFromWorkspace` | the TARGET's roles, which it never consulted before | `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `updateWorkspaceMemberRole` | the new role still carries `workspace.manage`, or another admin exists | `WORKSPACE_WOULD_HAVE_NO_ADMIN` |
| `acceptWorkspaceInvite` | the community still has at least one member | `WORKSPACE_HAS_NO_MEMBERS` |
| `internal DELETE users/:id` | cannot refuse - repairs instead, see below | - |

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
sweep, which collects them once nothing accesses them again.

**Account deletion is the one path that cannot refuse.** It bypasses every guard above, because
the account is going regardless. `ChannelService.removeAccountFromWorkspaces` takes each community
in turn: cut off its private channels, repair it as if the account were already gone - a community
left with nobody is hard-deleted, one left with members but no admin promotes the survivor with the
highest priority, then whose roles grant the most distinct permissions, then the lowest user id
(custom roles all rank just above the base role, so among them what they grant decides) - and only
THEN delete the membership row. A failed
repair keeps that row and the call throws, so the erasure queue's retry finds the community again
([account-erasure](../account-erasure.md)); a swallowed failure used to strand an adminless
community for ever. Logged at `warn` because an automatic promotion is something a human should be
able to find afterwards.

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
downgrade. `Membre`, or the base role's own name, means the base role, so a deployed client's
ordinary invitation works in a community whose lowest role is called otherwise; a role literally
named `Membre` above the base role is therefore not grantable by invitation until `minClientVersion`
reaches a client that sends no `roleName` for an ordinary invitation ([backlog](../backlog.md)).
The client sends no `roleName` at all for an ordinary invitation since #2277, and names a role only
when the inviter picked one.

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
- The successor an account erasure promotes is chosen again under `withCommunityRemovalLock`, from
  rows read `FOR UPDATE` in id order, since every removal deletes through that lock.

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
grantee's membership), a departure (all the community's private salons, `ORDER BY id`, then the
membership delete), and `hardDeleteWorkspace` (salons deleted before memberships). An access-list
rewrite takes the removal lock, then its salon, then the community's membership rows, share-locked.

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
| `STRIPE_SECRET_KEY` | no | Stripe secret key (form/product payments) |
| `INTERNAL_SECRET` | yes | Shared secret for service-to-service calls |
| `MEDIA_SERVICE_URL` | yes | Internal URL for media-service (blob proxy) |
| `CORE_SERVICE_URL` | yes | Internal URL for core-service (user/payment verification) |
