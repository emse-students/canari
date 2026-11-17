# Sealed names: taking group, community and salon names off the server

**Why.** Principle 1 of [Nos principes](../../principes.md) ("Vos messages sont à vous"): conversations,
groups and communities are encrypted so that even Canari cannot read them. A group's or a community's
NAME is still a plaintext column today, so the server knows what every group is called and pushes it
to Google and Apple ([dm-vs-community-encryption](dm-vs-community-encryption.md#both)). The owner
ordered the work on 2026-11-14 ([decisions](../backlog.d/owner-decisions-of-2026-11-14.md)): group
names (step 6 of his privacy order), then a sealed community state - name, photo, salons, role labels,
community nicknames (step 7). The backlog entry is
[p1-encrypt-the-names-of-groups-communities-and-salons](../backlog.d/p1-encrypt-the-names-of-groups-communities-and-salons.md).

## Every server-side reader, enumerated (origin/main, 2026-11-17)

Each reader either moves to the device or loses the name. Nothing outside the two services below
reads these columns (core-service, media-service, chat-gateway and call-service were searched: the
gateway relays socket payloads opaquely).

### `dm_groups.name` (chat-delivery-service)

| Reader | What it does | Who receives the name | Where it goes |
| --- | --- | --- | --- |
| `GroupsController` create (`POST mls/groups`) and rename (`PATCH`) | writes it | - | the client stops sending it (step 3) |
| `MembersController` `GET mls/users/:userId/groups` | serves it to the members' list; `repairGroupLabel` on the device used to treat it as the authority | members | the device's dated name (step 1, built) |
| `MessagingService` push composition (`groupName` in `PushMessageInput`) | the push title when the device cannot decrypt | Google and Apple, in clear | closed by [content-free push](content-free-push.md); the device names the group from its own row |
| `utils/join-ask-announce.ts` | "X veut rejoindre <groupName>" as push text and `contentArg` | Google and Apple, in clear | the device composes it from its row (`contentKey` already exists) |
| `utils/group-invite.ts` `resolveGroupInvitePreview` | the `/g/join/<token>` card and its Open Graph head (`frontend/src/lib/seo/serverSeo.ts`) | ANY holder of the link, unfurlers included - a non-member | the name moves to the link's `#fragment` (decided, below) |

### `channel_workspaces.name`, `channel_workspaces.slug`, `channels.name` (social-service, `channel.service.ts`)

| Reader | Who receives it | Where it goes |
| --- | --- | --- |
| invite preview `GET invites/:token` and `GET internal/channel-invites/:token` (SSR head of `/c/join/<token>`) | any signed-in holder of a token, and unfurlers through the SSR head | the name moves to the link's `#fragment` (decided, below) |
| `listWorkspacesForUser`, `getWorkspaceBySlug`, the channel list (a MANAGE_WORKSPACE holder reads private salon names) | members | the sealed community state (step 5) |
| `channel.salon.joined`, `channel.updated`, `channel.member.removed` socket events (`workspaceName`, `workspaceSlug`, `channelName`) | members or a private salon's allow-list | carry ids only; the device names them from the sealed state |
| `buildChannelPushTitle` (`"<community> - #<salon>"`), push `data` `workspaceName`/`channelName`, the silent `channel_read` push's title | Google and Apple, in clear, and the `push_envelopes` row | content-free push; the device composes the title |
| `deleteWorkspace` compares the typed confirmation with the name | the admin, as a 400 | the device compares it before the call |
| slug: `@Column({ unique: true })`, `ensureUniqueWorkspaceSlug`, `validateCommunitySlug`, `GET workspaces/by-slug/:slug` (a non-member gets 403 against 404: an existence oracle), logged at `[WORKSPACE] delete` | members, logs | dropped: there is no `[slug]` route in the app and no directory (owner, 2026-11-14), so the community is addressed by its id |

No admin, moderation, report or data-subject export path reads any of the three columns, and there is
no search by name.

## The design

**A name is group STATE carried by MLS, never by the server.** The shape is the one the nickname
register already proved ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)):
the members state it in a frame of the group's own log, a newcomer is handed it by the inviter's join
push, and each device keeps it beside the row it names.

- **Who can read it.** A frame is readable only at its epoch, so a member removed before a rename never
  reads the new name, and a member admitted later is handed the current one by the join push, which
  follows every delivered Welcome.
- **The order.** Each statement is dated by the server's acceptance of the frame that carried it.
  Every member's copy of that frame carries that time, live (`queuedCreatedAt`) and in the archive
  (the row's timestamp). The later date wins, and a tie goes to the larger name, so two devices
  holding the same pair agree whatever order they read it in. The server can see when a frame
  arrived, but it cannot read or forge the name, because the frame is MLS-authenticated.
- **What a hostile server keeps: the order, within a bound.** The time that orders names is the
  server's stamp, so a server that wanted to could choose which of two renames wins. A stamp far in the
  future would lock a name in for good, because nothing could be later. So a frame's server time is
  believed only within `BUNDLE_SERVER_TIME_SKEW_MS` (24 h) of the `sentAt` its author signed inside
  the frame. Past that bound the rename is refused at ERROR. What remains is the power to order two
  renames sent within 24 h of each other, or to withhold one. Both are visible to the members as
  notices, and neither reveals or invents a name. A rename whose send took longer than 24 h to be
  accepted is refused on every device, which the synchronous rename below makes unreachable from
  this build.
- **Communities** have no MLS frame per salon: their state is sealed under a key handed out through the
  community's key group (Graine), the channel the seeds already travel on. A member who joins reads the
  current state, and one who left cannot open a state sealed after the rotation that removed them.

## Step 1 - built (2026-11-17): the device dates a group's name, and the frames are the authority

- `Conversation.nameAt` / `ConversationMeta.nameAt` holds the server time of the MLS statement that set
  `name`, on the row itself, so one save writes both. SQLite gains `name_at` (local schema v21,
  `conversationNameAtStatement`); IndexedDB stores the field as it comes.
- `groupName.ts` holds the rule, and every refusal or skip is a typed cause that its log line names:
  - `readDatedGroupName` reads a dated name;
  - `readRenameFrame` adds the bound on the signed `sentAt`;
  - `applyRenameFrame` is the one rule shared by the live path and the replay;
  - `withDatedGroupName` applies to group rows only;
  - `withRestatedGroupName` (join push), `ownRenameOutcome`, `restatedGroupName` and
    `boundedRestatedGroupName` cover the other paths.
- A received `groupRenamed` frame, live (`systemMessageHandler`) and replayed (`historySystemEvents`),
  is applied only when it is newer than the held name. **This fixes a defect**: an older rename read
  after a newer one (a queue drain behind a live frame, or a replay page) used to put the old name
  back until the next server sweep. A frame with no server time, no signed `sentAt`, an out-of-bound
  server time or an empty name names nothing and is logged at ERROR with that cause. A rename frame
  inside a DM or a channel is logged at WARN as not a group's to name.
- The inviter's join push restates `groupName: { name, at }`. The newcomer takes it only from a join
  push, never from a broadcast, only when its date is not later than the push's own server time, and
  **only onto a row no frame has dated yet**. The inviter relays a date and does not prove it, so a
  relay never beats a frame this device read itself. Otherwise any inviter could rename the group for
  the newcomer with a date just under the push's own.
- `repairGroupLabel` corrects only an undated name. Once a frame has dated the name, the server's
  undated list no longer overrides it. A disagreement is logged once per name, with its length and
  never its text. `buildConversationRow` keeps a dated name over a site's undated one.
- **A rename is a frame or a failure, and the frame goes first.** `renameGroupAndBroadcast` used to
  write the server's copy first, then swallow a failed frame. Undated devices and older builds then
  took the new name from the list while dated devices kept the old one, for good. Now the frame is
  sent first. If it does not leave, nothing was renamed anywhere: the error is thrown, and the person
  is told (`group_rename_failed`, a toast, because the panel has already closed). The server's copy
  is written afterwards, for the older builds only. If that write fails once the frame is out, it is
  logged at ERROR and not thrown, because the members already have the name and a retry would rename
  the group twice.
- **The acting device writes its own rename over the row as it is AFTER the send**
  (`ownRenameOutcome`). The row is dated by the server time the send was answered with, and written
  only when newer, so a peer's later rename applied while the send was in flight stays. If the answer
  named no server time, the row is written undated, honestly. It never keeps an older `nameAt` beside
  the new name.
- **The cost of step 1, accepted:** an OLDER build's rename whose best-effort frame failed reaches the
  server's list only. Devices of this build that hold a dated name ignore the list, so they keep the
  previous name until the next rename. Undated devices still follow the list. The disagreement is
  logged once per name (`[DISCOVERY] ... names it differently`), so its rate can be measured.
- The server still stores and serves the name, for builds older than this one.

Readings owed: none on a phone. The change is to the order in which frames apply, and the unit tests
read it deterministically. Step 3 is the first one a person can see.

## The remaining steps, in order

1. **Step 2 - every group gets a dated name (about 2 days).** A group created by this build dates its
   name at creation: the creator sends a silent `groupNamed` statement in the first epoch. A group
   that existed before has no dated name on any device. One member device restates it once, as a
   silent frame, and the tie rule settles concurrent restatements. A notice is drawn only for a real
   rename.
2. **Step 3 - the server stops knowing group names (about 1 week, native included).** Create and rename
   send no name, and the server refuses one. The `groupName` push field and the join-ask
   `contentArg` go. The native push path names the group from the mirrored rows (Android
   `ChatBackgroundService`, iOS App Group copy). The invite preview carries the name in the link's
   `#fragment` (decided, below).
   Builds older than step 1 read only the server's list, so this step ships behind the minimum-version
   gate ([legacy-compatibility](../legacy-compatibility.md)) at the version decided below.
3. **Step 4 - the held migration (about 1 day, then the owner's approval line).** Set `dm_groups.name`
   to NULL with a before and after count of rows still readable by the server. Rollback: the column
   stays and the clients write nothing to it, so reverting the code needs no schema change. The names
   themselves come back only from the pre-migration dump. The migration is HELD
   ([cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
4. **Step 5 - the sealed community state (2 to 4 weeks).** Community name, photo, salon names, role
   labels and community nicknames go into one state, sealed under a key the key group distributes and
   versioned by a monotone counter. Every reader in the social-service table above moves to the
   device. The slug and its unique index go, and `by-slug` becomes by-id. Its own held migration nulls
   the columns, with a count.

## Decisions taken by the owner (2026-11-17)

- **What a shared invite link shows before joining** (`/g/join/<token>`, `/c/join/<token>`, and their
  Open Graph heads): **the name travels in the link's `#fragment`**, which no request ever sends to a
  server. The in-app card reads it from there, and a link unfurler, which sees only what the server
  renders, shows a generic "Invitation Canari". The server's preview stops naming the group or the
  community.
- **The minimum client version for step 3** (the server stops knowing group names): **the version
  carrying step 1 and the creation dating (step 2).** An older build reads only the server's list, and
  would show unnamed groups.
