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
  renames whose signed `sentAt` lie within **48 h** of each other: each stamp may move up to 24 h
  either way from its own `sentAt`, so a server can put a rename sent up to 48 h earlier after a later
  one. It can also withhold a rename. Both are visible to the members as notices, and neither reveals
  or invents a name.
- **The sender runs the same check on its own frame.** A device whose clock is off by more than 24 h
  sends a frame that every receiver refuses. Its own row and the server's copy used to take the name
  anyway, which split the group silently. Now `renameGroupAndBroadcast` bounds its own frame's server
  time by the `sentAt` it signed. When the check fails, the device writes no name, writes no server
  copy, and throws a `GroupRenameRefusedError`. The person is told to check the date and time
  (`group_rename_failed_clock`). The notice the frame drew stays in every member's history, and no
  device takes the name.
- **Pre-#752 rename frames carry no signed `sentAt`.** They are refused all the
  same, because nothing bounds their server time, live or replayed. This is an expected legacy state,
  so it is said once per conversation at INFO (`reportRenameRefusal`, shared by both paths), never at
  ERROR on every frame.
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
  - `withRestatedGroupName` (join push), `ownRenameOutcome`, `pendingRenameOutcome`,
    `restatedGroupName` and `boundedRestatedGroupName` cover the other paths;
  - `reportRenameRefusal` is the one refusal line of the live path and the replay.
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
- **A rename is a frame, the frame goes first, and a lost answer is not a failure.**
  `renameGroupAndBroadcast` used to write the server's copy first, then swallow a failed frame.
  Undated devices and older builds then took the new name from the list while dated devices kept the
  old one, for good. Now the frame is sent first, and its outcome is classified by TYPE at the throw:
  - **the server answered and refused it** (a status, a refused tab handover): nothing was renamed
    anywhere. The error is thrown, and the person is told (`group_rename_failed`, a toast, because the
    panel has already closed);
  - **the send got no answer** (`isTransportFailure`, e.g. `DeliveryUnreachableError`): the server may
    hold the frame and every member the name, so this is an UNKNOWN outcome, never "not renamed". The
    rename returns `unanswered` with the id and `sentAt` the frame was minted with. The row keeps the
    name it shows and records `nameSync.pending` (`PendingRename`), and the person is told the name is
    on its way (`group_rename_pending`). Reading it as a failure split the group: the members took the
    name and the sender's user was told it failed (#3785 re-review, P2-b).
- **What a rename still owes lives on the row, as `nameSync`** (local SQLite v21 column `name_sync`,
  JSON; IndexedDB stores the object; `parseNameSync` reads both and reports an unreadable value). It
  has two halves, settled by the sweep every connection makes (`settleNameSync`, injected into
  `ensureConversationForServerGroup` by `discoverMissingGroups` as a `NameSyncSettler`), never on a
  clock:
  - **`pending`, the frame**. Read off the row first (`pendingRenameVerdict`). A row that moved on to a
    later statement drops it, because re-sending would put the older rename back on top with a later
    server time. A row that holds the pending name, dated, saw its own frame come back from the archive,
    so the frame landed and only the server's copy is owed. Otherwise the SAME frame is re-sent
    (`resendPendingRename`: the same id and the same signed `sentAt`), so a member that already took it
    draws no second notice. Another send without an answer keeps it pending. An answered refusal drops
    it at ERROR. A frame minted more than the 24 h bound ago is dropped unsent at ERROR, because every
    receiver would refuse it.
  - **`serverCopy`, the server's copy** of a name the members hold (`OwedServerCopy { name, from }`),
    owed when the PATCH after a delivered frame fails. It is written **compare-and-set**: only while the
    row still holds `name` AND the server's list still holds `from`, the name the row held before the
    rename. A server that names anything else was written by a later rename. This device's sweep may
    well run before it has read that rename's frame, so the owed copy is dropped at WARN and never
    written over it (#3785 re-review, P2-a: A renames to X and its PATCH fails, B renames to Y and its
    PATCH lands, A's sweep wrote X over Y). The residual race is one round trip wide: a member's write
    landing between the list this sweep read and the write it makes. `from` is the row's name, which is
    this device's belief about the server's copy. When the server was already behind, the copy is
    dropped rather than written, which is the conservative side.
  - The copy is keyed by the NAME, not the date, so a rename whose answer carried no server time (an
    undated row) owes it too. `repairGroupLabel` never relabels a row whose name's copy is owed: the
    list is behind by exactly that write. Without this, the sweep put the old name back on the device
    that had renamed.
  - **The recovery path does not settle** (`recovery.ts` passes no settler). A re-join runs before the
    device has drained what arrived while it was out, so it would compare with a list whose later
    rename it has not read. A row that owes something is then neither settled nor relabelled there, and
    the next connection sweep does both, in order.
- **On a clock refusal the notice has already gone out.** The sender can only check its frame once the
  server has dated it, so the frame, and the notice "X renamed the group to Y", reach every member,
  this device included. No device takes the name. Every device therefore shows the same thing: the
  notice in the history, the old name in the header.
- **A device that rejoins holding an older DATED name recovers the newer one only by replaying the
  rename frame** from the archive, or through a later rename. The server's list no longer corrects a
  dated name, and the join push's restatement is taken only onto an undated row. A rejoin replays the
  history window, which includes the rename frame while it is inside that window. A rename older than
  the window stays unread until the next rename (step 2's restatement does not cover it either). The
  disagreement is logged once per name (`[DISCOVERY] ... names it differently`), so its rate is
  measured before anything else is built for it.
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
