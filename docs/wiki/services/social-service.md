# social-service

**Stack**: NestJS  
**Port**: 3014  
**Source**: `apps/social-service/`

## Responsibilities

The social-service manages all community features:

- **Posts**: news feed with Markdown, polls, reactions, comments, reports, pinning.
- **Channels**: encrypted workspaces with role-based access, HKDF-derived per-channel keys, server-assisted key distribution.
- **Associations**: club management, members, documents, calendar events, boutique products.
- **Forms**: dynamic form builder with optional Stripe payment, cash payment validation.
- **Cotisations**: membership dues as time-bounded `user_tags`, granted via boutique products, manual grants, or paid forms - see [Cotisations](../cotisations.md).

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Channels, workspaces, memberships, key distributions, forms, submissions, associations, products |
| MongoDB | Posts, comments, reactions (document store) |
| Redis | `chat:channel_events` pub/sub (publishes to chat-gateway) |

## Channel encryption model

Channels use server-assisted symmetric encryption (not MLS):

1. On workspace creation, `masterSecret` is generated and stored server-side.
2. A per-channel key is derived: `HKDF(masterSecret, channelId, keyVersion)`.
3. A member receives that derived key **in the clear**, over an authenticated REST call -
   `buildChannelBootstrap` returns `newEpochBaseKey` as raw base64.
4. Key rotation increments `keyVersion`; old ciphertexts remain decryptable.
5. `channel_key_distributions` tracks which devices have received each key version.

**THE SERVER CAN READ EVERY CHANNEL MESSAGE, AND THAT IS THE DESIGN.** `channels.masterSecret` sits
in Postgres in the clear and every epoch key is a pure function of it, so anyone holding the database
decrypts the whole history of every salon without touching a membership row. Say it plainly wherever
the question comes up: this is the property that distinguishes a channel from a DM or a group, which
really are MLS and really do leave the server with ciphertext only. Step 3 read "encrypted with their
MLS group key" until 2026-08-17 and was simply false - no code ever wrapped that key.

A related note for anyone auditing this file: `soft-crypto.ts` (`encryptSoft` / `decryptSoft`) had no
call site anywhere in `apps/`, `frontend/src` or `libs/` and was deleted 2026-08-17. It was a second,
unused derivation sharing the `canari-channel-e2ee-v1` info string with the live one above, which is
exactly the shape that gets mistaken for the real mechanism while reading.

### An epoch that rotates under an open tab, and the codes that name it

A tab holding epoch N and sending after a rotation to N+1 encrypts under a key the server no longer
accepts. Nothing pushes a rotation into an in-flight send, so this is expected rather than a fault,
and it is repaired by exactly one refresh and one retry. Every half of that decision is
machine-readable:

| Raised by | What it is | The client's answer |
|---|---|---|
| `ChannelKeyVault.getCurrentKey` / `getKeyForEpoch` | `ChannelKeyUnavailableError`, carrying `epochId` and the epochs the vault does hold | re-bootstrap, retry once |
| `sendMessage`, keyVersion behind the channel | 403 with `code: 'STALE_CHANNEL_KEY_VERSION'` | re-bootstrap, retry once |
| `sendMessage`, keyVersion absent | 400 with `code: 'CHANNEL_KEY_VERSION_REQUIRED'` | fail loudly, never retry |

**The last row is deliberately not retryable.** `encryptMessage` either returns a keyVersion or
throws, so this client cannot produce that refusal; the guard exists to refuse a *different* client,
and retrying would re-send an identical body and hide it behind a pointless round trip.

**The code is the contract, the sentence beside it is for humans** and may be reworded freely.
Until 2026-08-16 the client read the sentences instead - five `includes()` on `Error.message`, one of
which (`'Sync required'`) was only the tail of another - and `channelCrypto.test.ts` now pins that an
untyped error carrying that exact prose is NOT retried. The client half is
`ChannelApiError` (`ChannelService.ts`), which carries the status and the parsed `code` while leaving
`message` as the raw body, the same shape `DEVICE_REVOKED` uses on
[chat-delivery](chat-delivery.md). Both halves ship in the same deploy; a frontend newer than the
social-service would see no `code` and simply stop retrying, which fails the send rather than
corrupting anything.

## Storage and retention: a channel message costs one row, forever

Two facts that decide every capacity question about communities, both verified against production:

- **A channel message does NOT fan out.** `ChannelService.sendMessage` inserts exactly **one**
  `channel_messages` row whatever the member or device count; online clients are served over Redis
  pub/sub and offline ones get a direct FCM push through chat-delivery's
  `/internal/push/notify`, which never touches `queuedMessageRepo`. Measured on prod:
  `queued_message` holds **0** rows for any channel id. This is the opposite of a DM, where a copy of
  the ciphertext is stored per recipient *device* - see [chat-delivery](chat-delivery.md).
- **Nothing ever GCs `channel_messages`.** There is no cron and no retention window. Deleting a
  community only sets `archived`; account deletion rewrites `authorId` to `[deleted]` and keeps the
  row. The only removal is an explicit `deleteChannelMessage`. Community history therefore grows
  monotonically - cheaply (~960 B/row including indexes, `content` averaging 137 B because a channel
  ciphertext carries no MLS framing), but forever.

Posts have the same shape: no TTL, no cron, removed only by an explicit delete or account deletion.
The numbers and what they imply are in
[storage-forecast](../infrastructure/storage-forecast.md).

## Routes

### Posts (`/api/posts`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/posts` | List paginated posts (feed types: all / followed) |
| POST | `/api/posts` | Create post (Markdown, optional poll or form, optional payment) |
| GET | `/api/posts/:postId` | Get single post |
| PATCH | `/api/posts/:postId` | Update post (author only) |
| DELETE | `/api/posts/:postId` | Delete post (author or admin) |
| POST | `/api/posts/:postId/reactions` | Add/toggle emoji reaction |
| POST | `/api/posts/:postId/comments` | Add comment |
| PATCH | `/api/posts/:postId/pin` | Pin post (admin only) |
| PATCH | `/api/posts/:postId/unpin` | Unpin post (admin only) |
| POST | `/api/posts/:postId/report` | Report post |

### Channels and workspaces (`/api/channels`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/channels/workspaces` | Create workspace |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces; each carries `viewerCanManage` (true iff the caller holds MANAGE_WORKSPACE) so the client can gate admin controls without deriving permissions itself. Ordered by the caller's personal `sortOrder` |
| PATCH | `/api/channels/workspaces/reorder` | Persist the caller's top-to-bottom community order (`{ orderedIds }`, workspace ids). Personal per-member setting, stored on `channel_members.sortOrder` (migration 024) - not shared across members of the same workspace |
| GET | `/api/channels/workspaces/:workspaceId/members` | The whole community roster. Exists for the caller that holds no channel id - a device that has just joined the Graine distribution group and must name who to ask for history |
| PATCH | `/api/channels/workspaces/:workspaceId/history-visibility` | Set what a newcomer may read: `shared` or `joined`, MANAGE_WORKSPACE only. Stored on `channel_workspaces."historyVisibility"` (migration 039) and broadcast as `workspace.updated`. **The server enforces nothing here** - it holds no seed; members apply the rule ([channel-encryption](../protocols/channel-encryption.md)) |
| GET | `/api/channels/workspace/:workspaceId/user/me` | List channels in workspace for caller |
| POST | `/api/channels` | Create channel in a workspace |
| POST | `/api/channels/:channelId/messages` | Send encrypted channel message |
| GET | `/api/channels/:channelId/messages` | List messages newest-first (`limit`≤200, `before` ISO cursor) |
| POST | `/api/channels/:channelId/members/join` | Join channel |
| POST | `/api/channels/:channelId/members/invite` | Invite user to channel |
| POST | `/api/channels/:channelId/members/leave` | Leave a **private** channel (drops the caller from `allowedUsers` and rotates the key). A public channel answers 400 - see "A channel-scoped action never touches community membership" |
| GET | `/api/channels/:channelId/members` | Roster of THIS channel (private = `allowedUsers` + admins); `?scope=workspace` for the whole community |
| DELETE | `/api/channels/workspaces/:workspaceId` | Delete a whole community for every member (MANAGE_WORKSPACE **only** - see "Deleting a community") |
| DELETE | `/api/channels/workspaces/:workspaceId/members/:userId` | Remove a member from the whole workspace (MANAGE_WORKSPACE / MANAGE_CHANNEL / KICK_MEMBERS) |
| PATCH | `/api/channels/workspaces/:workspaceId/members/:userId/role` | Set a member's workspace role, replacing existing roles (MANAGE_WORKSPACE / MANAGE_ROLES) |
| GET \| PATCH | `/api/channels/:channelId/access` | Get/set channel visibility (`isPrivate`), `allowedUsers`, and `writePolicy` (MANAGE_CHANNEL to write) |
| GET \| PUT | `/api/channels/roles/:roleId/permissions` | Get/set a workspace role's base permissions (MANAGE_WORKSPACE / MANAGE_ROLES) |
| DELETE | `/api/channels/:channelId/messages/:messageId` | Delete a channel message: own always, someone else's with `channel.moderate` |
| POST | `/api/channels/:channelId/messages/:messageId/pin` | Pin message (own always, someone else's with `channel.moderate`) |
| POST | `/api/channels/:channelId/messages/:messageId/poll/vote` | Vote on a poll (empty = retract) |
| PATCH | `/api/channels/:channelId/messages/:messageId/poll/close` | Close a poll now (author or moderator); forces the deadline + unpins |
| GET | `/api/channels/:channelId/notification-level` | Caller's push level for the channel |
| PATCH | `/api/channels/:channelId/notification-level` | Set push level (`all` \| `mentions` \| `none`) |

#### Roles, membership and channel access

Communities use a deliberately simple, two-level model (no per-channel permission overrides):

- **Workspace roles.** Every workspace seeds three roles - `Administrateur` (priority 100, all
  permissions incl. `workspace.manage`), `Modérateur` (50), `Membre` (10) - stored in
  `channel_roles.permissions` (unified keys, e.g. `channel.send`, `role.manage`). Admins/roles are
  managed from the community settings modal: invite + assign a role, change a member's role
  (`PATCH .../members/:userId/role`, replaces all held roles), remove a member
  (`DELETE .../members/:userId`), and edit each role's base permissions
  (`PUT roles/:roleId/permissions`). `workspace.manage` implicitly grants every permission.
- **Channel access.** `canAccessChannel`: a **public** channel is readable by every workspace
  member; a **private** channel is readable only by users listed in `channels.allowedUsers` **plus**
  any admin (`workspace.manage`) - admins reach every channel without being explicitly added.
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

#### Message moderation (`channel.moderate`)

The role matrix advertises this permission as "pin or delete other members' messages", and that
is exactly what it does. `memberCanModerateMessages` is the single check, shared by every entry
point (`deleteChannelMessage`, `setMessagePinned`, `closePoll`); MANAGE_CHANNEL and
MANAGE_WORKSPACE subsume it via `roleGrantsModeration`. In each case the **author** is allowed
unconditionally and the permission only widens the action to *someone else's* message. Editing is
never moderation - only the author can edit, in channels as in DMs.

The workspace listing carries `viewerCanModerate` alongside `viewerCanManage` so the client can
decide whether to render the delete affordance on another member's bubble without probing the
API for a 403. It is a UI hint: the server re-checks on every call.

Deletion drops the row (the content is a ciphertext the server cannot read, so there is nothing
worth tombstoning) and broadcasts `channel.message.deleted` (`{ channelId, messageId, deletedBy }`)
to the workspace, which is how other members' clients replace the bubble with the local
"deleted message" placeholder.

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
`keyVersion`, `writePolicy`), never returned as entities. `Channel.masterSecret` is the 32-byte
HKDF root every epoch key of that channel derives from; serializing the entity handed it to the
caller and made a slug sufficient to decrypt the whole channel history. The list is filtered by
`canAccessChannel`, the same rule `listChannelsForUser` applies, so a private channel the caller
may not read is absent rather than merely unusable - which is also what lets the accepted-invite
page pick a landing channel from it safely.

Any new endpoint returning a `Channel` must project the same way. Nothing in the framework
strips it: there is no `ClassSerializerInterceptor` and the entity carries no `@Exclude`.

#### Deleting a community

`DELETE /api/channels/workspaces/:workspaceId` (`deleteWorkspace`) is the only way a community
disappears. It is **admin-only**: unlike a kick or a channel archive, MANAGE_CHANNEL is
deliberately not accepted, because the action hits every member at once.

It is a **soft delete**. `channel_workspaces.archived` (migration 033) flips to true, every
channel in the workspace is archived alongside it, and nothing is dropped - members, channels,
messages and the slug all stay in place. Recovering a community deleted by mistake is two
`UPDATE`s. What actually makes it vanish is that every read path filters `archived`:
`listWorkspacesForUser`, `getWorkspaceBySlug` (404 on the slug), `getWorkspaceInvitePreview` and
`acceptWorkspaceInvite` (a link must not resurrect a deleted community).

The audience is snapshotted **before** archiving, then `workspace.deleted`
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
page until an empty page is returned. Channel messages are never persisted client-side, so full-text
search fetches and decrypts the entire history on demand (`ChannelService.fetchAllChannelMessages`
-> `useConversations.searchChannelHistory`, capped at ~2000 messages) and merges the decrypted rows
into the open conversation so a hit older than the loaded page can be scrolled to. The server only
ever sees ciphertext; matching happens on the decrypted preview text in the browser.

#### Channel push notifications

Sending a channel message fans out FCM pushes to workspace members (background + app killed), via
chat-delivery's `/internal/push/notify`. Each member has a per-channel level stored on
`channel_members.notifLevels` (`all` default, `mentions`, `none`); `mentions` is routed from a
cleartext `mentionedUserIds` list the sender attaches (metadata-only; content stays encrypted). The
push carries the ciphertext inline; the Android native layer decrypts it locally with the epoch key
mirrored to `channel_keys.json` (so plaintext never transits FCM). See the frontend chat module for
the vault mirror and the per-channel level selector.

**The payload is exactly what a client reads: `type, channelId, channelName, workspaceName,
keyVersion, ciphertext, nonce, senderId` plus a per-recipient `mentioned`.** Three more fields
(`workspaceId`, `messageId`, `createdAt`) travelled with it until 2026-08-16 and were read by none of
the three native handlers - dropped rather than left looking like a contract. `workspaceId` was a
uuid no native surface can turn into a community name (there is no workspace mirror the way
`channel_keys.json` mirrors the keys); `workspaceName` replaced it because it is what the title
actually needs. `messageId` / `createdAt` cannot repeat what the MLS path does
with them: that path writes `fcm_message_cache.ndjson` so a background-decrypted message is already
in the store at open, whereas a channel message is DELIBERATELY never persisted locally
(`useMessaging` skips the DB save for a `channel_` conversation - channels are server-authoritative
and refetched over HTTP), so the cache has nowhere to inject. Fewer bytes also buys headroom under
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

### Associations (`/api/associations`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/associations` | List all associations |
| GET | `/api/associations/:id` | Get association detail |
| POST | `/api/associations` | Create association (global admin or BDE `MANAGE_ASSO` flag) |
| PATCH | `/api/associations/:id` | Update association (admin with `MANAGE_MEMBERS`) |
| POST | `/api/associations/:id/members` | Add member to association |
| POST | `/api/associations/:id/events` | Create calendar event |
| PATCH | `/api/associations/:id/events/:eventId` | Update calendar event |
| DELETE | `/api/associations/:id/events/:eventId` | Delete calendar event |
| POST | `/api/associations/:id/products` | Create boutique product |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for product |

### An association row carries two secrets, and three reads spread it whole

`GET /api/associations`, `/api/associations/:id` and `/api/associations/slug/:slug` sit under the
controller's `── Public ──` banner and carry **no guard**. nginx puts `/api/associations` behind
`auth_request`, but `/api/auth/verify` answers 200 for an anonymous request (it only sets
`X-Logged-In: false`), so those three are reachable from the internet. All three returned
`{ ...asso, memberCount, parentName }` - which spread `documentVaultKey`, the hex 32-byte master
key every document CEK is derived from, and `notesCiphertext`.

`toSafeAssociation` (`associations/association.projection.ts`) is now the single seam that nulls
both, applied at the three controller reads. Third instance of one rule, after `Channel.masterSecret`
and `AssociationProduct.webhookSecret`: **an entity that carries a secret needs one projection, and
every read has to pass through it.**

The seam is the controller, not the service, on purpose: `findById` is also used by writers
(`update`), and stripping in the service would hand them a row whose key column reads null. It
nulls rather than deletes, so responses keep the shape their TypeScript clients expect.

*Still open, deliberately:* the three routes remain unguarded, so `stripeAccountId` and the rest of
the row are readable without a session. Adding `NginxAuthGuard` there is the right fix but changes
access semantics for routes other repos may consume, so it is a separate decision.

### A post scheduled for later is not readable by id

Every `listPosts` query filters `scheduledAt IS NULL OR scheduledAt <= NOW()`. `getById` did not,
so a queued post was fully readable through `GET /api/posts/:postId` - and would have been
published early by any link preview or share unfurl. It now applies the same rule, letting through
only the post's **author** (so scheduling does not hide a post from whoever wrote it) and a global
admin. Everyone else gets 404, not 403: the existence of an unpublished post is itself the thing to
hide. Pinned by `posts.service.scheduling.spec.ts`.

### Who may touch a calendar event

One rule, enforced in `updateCalendarEvent` / `deleteCalendarEvent` and mirrored by every UI that
offers the buttons:

| Caller | Scope |
|---|---|
| Global admin (`x-global-admin: true`) | any association's event |
| BDE admin (`isUserBdeAdmin`: `VALIDATE_EVENTS` in an association flagged `isBDE`) | any association's event |
| Anyone else | needs `PROPOSE_EVENT` in the association that owns the event |

`:id` is always the **owning** association - an event never changes owner, so there is no
`targetAssocId` on update the way there is on create.

Two surfaces offer these actions and they gate differently on purpose. An association's own page
(`AssociationCalendarSection`) gates on `PROPOSE_EVENT` *there*, so a BDE validator holding no
membership in that club sees nothing. The global agenda (`/calendar`) gates per event on the full
server rule, which is the only place that validator can act - deriving its gate from the other
surface instead of from the server would have kept the right unusable.

## Redis events published

The social-service publishes to `chat:channel_events`:

| Event | Emitted by |
|---|---|
| `channel.member.joined` | join, invite accept, key distribution |
| `channel.member.kicked` | `kickFromWorkspace`, `leaveWorkspace` |
| `channel.member.removed` | `removeMemberFromChannel` |
| `channel.key.rotated` | any membership change that invalidates the epoch key |
| `channel.message.created` / `.deleted` | send, delete |
| `channel.updated` / `.deleted` | rename, delete |
| `workspace.updated` / `.deleted` | cover image change, soft delete |
| `channel.typing`, `channel.pin`, `channel.poll.vote` | live UI signals |

The chat-gateway subscribers fan out these events to all connected devices of the affected users.

### Removal events are fan-out, and the payload is the only discriminator

`channel.member.kicked` and `channel.member.removed` go to **every remaining member as well as
the person being removed** - the remaining members need them to keep their own view in sync. So
receiving one means nothing on its own, and two payload fields carry the entire meaning:

- `kickedUserId` / `removedUserId` - the target. A client that acts without comparing it to its
  own user id purges state on somebody else's behalf.
- `isPrivate` - on the channel-scoped removals only. A **public** channel stays readable by every
  workspace member, so removing someone from one merely rotates the epoch key; nothing is lost
  and the client must not drop it (a reload would bring it straight back).

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

**The last member leaving deletes the community outright** (`hardDeleteWorkspace`): one transaction,
seven tables in dependency order - `channel_key_distributions`, `channel_messages`,
`channel_members`, `channel_roles`, `workspace_invites`, `channels`, `channel_workspaces` - because
there is not one foreign key on `channel_workspaces` or `channels` to cascade, so a table left out
becomes orphan rows nobody sees. Attached media are left to the retention sweep, which collects them
once nothing accesses them again.

**Account deletion is the one path that cannot refuse.** `internal.controller` deletes
`channel_members` rows by `userId` directly, so it bypasses every guard above, and the account is
going regardless. It therefore captures the affected workspace ids BEFORE deleting and calls
`repairWorkspacesAfterAccountDeletion` after: a community left with nobody is hard-deleted, and one
left with members but no admin promotes its highest-priority survivor, ties broken by the lowest
user id. Deterministic, per-workspace `try` so one failure never strands the others, and logged at
`warn` because an automatic promotion is something a human should be able to find afterwards.

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

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `MONGODB_URI` | yes | MongoDB connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `STRIPE_SECRET_KEY` | no | Stripe secret key (form/product payments) |
| `INTERNAL_SECRET` | yes | Shared secret for service-to-service calls |
| `MEDIA_SERVICE_URL` | yes | Internal URL for media-service (blob proxy) |
| `CORE_SERVICE_URL` | yes | Internal URL for core-service (user/payment verification) |
