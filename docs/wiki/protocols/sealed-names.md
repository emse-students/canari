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
| `utils/group-invite.ts` `resolveGroupInvitePreview` | the `/g/join/<token>` card and its Open Graph head (`frontend/src/lib/seo/serverSeo.ts`) | ANY holder of the link, unfurlers included - a non-member | an owner decision, below |

### `channel_workspaces.name`, `channel_workspaces.slug`, `channels.name` (social-service, `channel.service.ts`)

| Reader | Who receives it | Where it goes |
| --- | --- | --- |
| invite preview `GET invites/:token` and `GET internal/channel-invites/:token` (SSR head of `/c/join/<token>`) | any signed-in holder of a token, and unfurlers through the SSR head | the owner decision below |
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
- **Communities** have no MLS frame per salon: their state is sealed under a key handed out through the
  community's key group (Graine), the channel the seeds already travel on. A member who joins reads the
  current state, and one who left cannot open a state sealed after the rotation that removed them.

## Step 1 - built (2026-11-17): the device dates a group's name, and the frames are the authority

- `Conversation.nameAt` / `ConversationMeta.nameAt` holds the server time of the MLS statement that set
  `name`, on the row itself, so one save writes both. SQLite gains `name_at` (local schema v21,
  `conversationNameAtStatement`); IndexedDB stores the field as it comes.
- `groupName.ts` holds the rule: `groupNameSupersedes`, `withDatedGroupName` (group rows only),
  `parseDatedGroupName`, `restatedGroupName`, `boundedRestatedGroupName`.
- A received `groupRenamed` frame, live (`systemMessageHandler`) and replayed (`historySystemEvents`),
  is applied only when it is newer than the held name. **This fixes a defect**: an older rename read
  after a newer one (a queue drain behind a live frame, or a replay page) used to put the old name
  back until the next server sweep. A frame with no server time names nothing and is logged at ERROR.
- The inviter's join push restates `groupName: { name, at }`. The newcomer takes it only from a join
  push, never from a broadcast, and only when its date is not later than the push's own server time.
- `repairGroupLabel` corrects only an undated name. Once a frame has dated the name, the server's
  undated list no longer overrides it. A disagreement is logged once per name, with its length and
  never its text. `buildConversationRow` keeps a dated name over a site's undated one.
- A rename is a frame or a failure: `renameGroupAndBroadcast` used to swallow a failed frame and leave
  the members to learn the name from the server. It now throws, and the acting device dates its own
  row by the server time its send was answered with (`sendVisibleNotice` returns it).
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
   `ChatBackgroundService`, iOS App Group copy). The invite preview follows the owner decision below.
   Builds older than step 1 read only the server's list, so this step ships behind the minimum-version
   gate ([legacy-compatibility](../legacy-compatibility.md)).
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

## Decisions owed to the owner

- **What a shared invite link shows before joining** (`/g/join/<token>`, `/c/join/<token>`, and their
  Open Graph heads). Recommended: the link carries the name in its `#fragment`, which no request ever
  sends to a server. The in-app card shows it, and an unfurler shows a generic "Invitation Canari".
  The alternative is no name before joining.
- **The minimum version for step 3.** Recommended: the version that carries steps 1 and 2. A build
  older than that would show unnamed groups.
