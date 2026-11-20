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
  old one, for good. Now the frame is sent first, and its outcome is classified by TYPE at the throw
  (`isFrameFateUnknown`, `frameFromAnyTab.ts`):
  - **a proof that nothing was posted** (a status answer, or a tab handover refused before it ran:
    `leader-unavailable`, `not-delegable`, `device-key-changed`, `reload-owed`, `lead-lost`): nothing
    was renamed anywhere. The error is thrown, and the person is told (`group_rename_failed`, a
    toast, because the panel has already closed);
  - **an unknown fate**: the server did not answer (`isTransportFailure`, for example
    `DeliveryUnreachableError`), or a follower tab handed the frame to a leader that died holding it
    (`leader-gone`) or failed without saying whether it posted (`failed`, which is how a leader's own
    transport failure comes back) - `FrameNotHandedError.fateUnknown`. The frame may be on the
    server and with every member, so this is never "not renamed". The rename returns `unanswered`
    with the id and `sentAt` the frame was minted with. The row keeps the name it shows and records
    `nameSync.pending` (`PendingRename`), and the person is told the name is on its way
    (`group_rename_pending`). A second unanswered rename replaces the first as the frame to re-send,
    and the first moves to `unconfirmed`: its copy may have landed, and its id is the only thing a
    member's relayed copy can settle it by (`pendingRenameOutcome`, #3785 round 6). Reading it as a failure split the group: the members took the name and
    the sender's user was told it failed (#3785 re-reviews, P2-b and P2-1).
- **What a rename still owes, or still does not know, lives on the row as `nameSync`** (local SQLite
  v21 column `name_sync`, JSON; IndexedDB stores the object; `parseNameSync` reads both and reports an
  unreadable value). The sweep every connection makes settles it (`settleNameSync`, injected into
  `ensureConversationForServerGroup` by `discoverMissingGroups` as a `NameSyncSettler`), never a clock.
  - **Only once this link has drained the group** (`isGroupDrained`: a pull listed the whole mailbox
    since the socket opened, and the group's frames are processed). Both halves compare the row with
    what the members said since the rename. A row read before the device has read what arrived while
    it was out answers "nothing happened since". A connection whose pull failed still runs the sweep
    (`initializeConnection` logs the failure and goes on), and a re-send then put the older rename
    over a member's newer one for everyone, and an owed copy went over a name that had come back
    (A, then back to O). Not drained, the settlement waits for the next sweep and says so in a line
    (#3785 re-review 2, P2-2).
  - **`pending`, the frame.** Read off the row first (`pendingRenameVerdict`), comparing the
    statement the rename was made over (`over`), NAME AND DATE. A row that shows another name keeps
    the frame `unconfirmed`, because re-sending would put it over that name. So does the SAME name
    under another date: the members renaming Old -> B -> Old leave the row showing "Old" again, dated
    after this device's rename, and a name-only compare re-sent the older rename over their later
    statement for everyone (#3785 round 6, P2). A statement from BEFORE the rename that dates an
    undated base is no later statement: the row showed the name undated when this device renamed
    (the server's list, or an own rename answered with no server time), and a replayed or live frame
    that set it, or a join push restating it, dates it afterwards. Every one of those paths writes
    through ONE rule (`withDatedGroupName`), which dates the pending frame's `over` in the same write
    when the statement names that base at a time PROVABLY before the rename; the frame is still
    recognised and re-sent. Doing it in the join push only left the replay dating the row alone, and
    a rename the person was told is on its way was never sent (#3785 round 7, F1). "Provably before"
    is server time against server time, never against this device's `sentAt` (its own clock: running
    behind, the rename was never sent; ahead, A -> B -> A reopened). The frame carries the newest
    instant the server had stated to this account when it was minted (`PendingRename.serverSeenAt`,
    `serverTimeSeen` in serverClock.ts), which is no later than the frame's own acceptance, and only
    a statement stamped at or before it dates the base (#3785 round 8). **The residual:** a statement
    of the same name stamped between that instant and the rename's acceptance cannot be told from a
    later one, and is read as later - the frame is kept `unconfirmed`, never re-sent, and settles only
    if its first copy landed and a member relays it. The window is the time since the server last
    said anything to this account; a device that renames with a live link has heard from it within
    seconds. The likeliest undated base - a name the group list returned at boot, its frame not yet
    drained - is covered: the list answer's `Date` is noted as a server time (`getUserGroups`, the
    API's own answer only), and every name it returns was stamped before it; so is the sweep's read
    of the group row (#3785 round 9). What is left there is sub-second: `Date` is floored to the
    second, so a statement stamped in the same second as the answer, after its floor, reads as
    later. With no server time ever seen, nothing dates the base. A join push dates the base with
    the inviter's relayed `at` (`withRestatedGroupName`), so an inviter may pick any value up to
    `serverSeenAt` to date it - a tighter bound than before, not a new power. A row
    that holds the pending name, dated, saw it land, so only the server's copy is owed. Otherwise the
    SAME frame is re-sent (`resendPendingRename`: the same id and the same signed `sentAt`), so a
    member that already took it draws no second notice. Its outcome is a type
    (`RenameResendOutcome`): no answer again, or a send that was not made, keeps it pending - a
    failed re-send proves something about the re-send only, never about the first copy. Only a typed
    refusal that ends it (`evicted`, `group-deleted`, or the receivers' bound, `clock`) stops the
    re-sending, and even then the frame is kept `unconfirmed`.
  - **A re-send goes out only within a bound the server's clock proves.** A frame past the receivers'
    24 h bound is refused by every member, and each still draws its "renamed the group" notice for
    a name nobody took - noise for the whole group. So the sweep reads the server's clock in that
    very pass: the `Date` of the delivery service's answer to the group row read
    (`GroupMeta.serverNow`, `serverDateOf`; chat-delivery exposes the header to the phone apps). It
    is never this device's clock, which may run ahead or behind, nor an older server time this
    device holds, which says nothing of how long it was offline. The frame is stamped AFTER that read,
    by the send's latency (seconds, minutes on a slow link), and the `Date` is floored to the second,
    so the late side keeps a margin: re-sent only while the server's clock is more than
    `RENAME_RESEND_MARGIN_MS` (10 min) inside the bound. The margin is not a proof - a send slower
    than that still crosses, and its answer comes back typed `clock`, which ends the re-sending. The
    early side keeps the plain bound, since a later stamp only moves the frame inside it (#3785
    round 8). The read is classified by TYPE (`getGroupServerStatus`), never by a `null` that lumps
    a gone group with a lost answer: no answer keeps the frame pending; no live group (`absent`, or a
    `deletedAt` tombstone) keeps it `unconfirmed`, said in a line; past the bound keeps it
    `unconfirmed`, unsent, at ERROR. An answer with NO readable clock is an unknown, not a refusal:
    the frame stays pending, said once per frame, and is re-sent once a clock is readable - a phone
    build reaches the stores before production serves the exposed header, and shelving every rename
    swept in that window lost them for good. The read is `cache: 'no-store'`, so its `Date` is the
    server's clock now and not a stored answer's.
  - **`unconfirmed`, and the heal every stopped frame relies on.** A frame this device stopped
    re-sending may still have reached every member: its first copy's answer was lost, not the copy.
    The members then hold its notice under the id this device minted, and this device holds no row
    under that id. **The history reconciliation's digest diff relays that row** (it is a missing id
    like any other), and a relayed row under the id of one of this device's own `pending` or
    `unconfirmed` frames is the proof it landed (`ownRenameFromRelay`, run by
    `ownRenameSettledByRelay` on the rows a bundle adds, live in `systemMessageHandler` and replayed
    in `historySystemEvents`). The name is applied at the relayed server time by the ordinary rule
    (`withDatedGroupName`): a later name this device holds still wins and an earlier one loses,
    exactly as every member computed, and the server's copy becomes owed. The relayed time is bounded
    by the `sentAt` this device minted, the same bound every receiver put on the server's stamp. That
    bound is not the server's own time, though: a relayer may pick ANY time within 24 h of `sentAt`,
    and against a peer rename stamped inside that window this decides which of the two wins - on THIS
    device only. Every other member dated the frame by the server's stamp. The worst a relayer can do
    is a single-device divergence of the name, inside the window, until the next rename; it cannot
    move the name anyone else holds. A row under that id
    naming another name is refused at ERROR. A frame whose first copy never landed has no notice
    anywhere, so nothing is relayed and the record stays inert until the next own rename replaces it.
    Tested end to end: `systemMessageHandler.nickname.test.ts` ("a relayed copy of this device's own
    rename notice applies (A, t1)").
  - **`serverCopy`, the server's copy** of a name the members hold (`OwedServerCopy { name, from }`),
    owed when the PATCH after a delivered frame fails. It is written **compare-and-set** on the
    server's name READ AGAIN for this group just before the write (`getGroupMeta`), never on the list
    the sweep read at its start, which every group before this one in the sweep has aged. The copy is
    written only while the row still holds `name` AND the server still holds `from`, the name the row
    held before the rename. A server that names anything else was written by a later rename, so the
    copy is dropped at WARN and never written over it (#3785 re-review, P2-a). The residual race is
    one round trip wide: a member's write landing between that read and this write. `from` is this
    device's belief about the server's copy; when the server was already behind, the copy is dropped
    rather than written, which is the conservative side.
  - The copy is keyed by the NAME, not the date, so a rename whose answer carried no server time (an
    undated row) owes it too. `repairGroupLabel` never relabels a row whose name's copy is owed: the
    list is behind by exactly that write. Without this, the sweep put the old name back on the device
    that had renamed.
  - **The recovery path does not settle** (`recovery.ts` passes no settler). A re-join runs before the
    device has drained what arrived while it was out, so a row that owes a frame or a copy is neither
    settled nor relabelled there, and the next connection sweep does both, in order.
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

## Step 2 - built (2026-11-20): every group gets a dated name

Step 3 takes the server's copy away, and a group whose name no frame ever dated would then have no
name the members agree on. So every group gets one, by a **silent `groupNamed` statement**: `{ name }`
in a system frame carrying a `messageId` and a signed `sentAt`, sent `DELIVERY.mutation` (no push,
kept in the group's log for the replay). An older build acknowledges the unknown event and ignores
it.

- **Silent while it only dates; a notice as soon as it CHANGES the name shown** (#3888 re-review,
  decision taken). Any member can send a statement or an answer - an answer with a `renameAt` just
  under its own server time - and every statement-dated device takes it. Silent, that was a forged
  rename nobody could see, and the answer's rank (A3) made it stick. So a statement or an answer that
  CHANGES THE NAME SHOWN draws the rename notice, naming the frame's MLS sender, live and replayed
  alike (`nameChangeNoticeDue`, `visibleNoticeContent('groupRenamed')`, under the frame's id). Honest
  changes are rare - a crossing, a heal - so the notice costs little. **The one exception is a newly
  invited member's PLACEHOLDER** (owner, 2026-11-20; narrowed by the lead under that intent after
  the round-4 review): an UNDATED, NON-EMPTY name that is a raw id (`isRawId`) or the group's own id,
  which the Welcome and the push write. No member chose it; that device is learning the name. An
  undated LIST name and an EMPTY one are not exempt: a dated-only rule let a member state a new name
  over every still-undated row during the rollout, and name an unnamed group - which stays undated
  for ever - at any time, both silently. The honest rollout draws nothing anyway: a restatement does
  not change the name shown.

- **A statement ranks below every rename** (`groupNameSupersedes`). Ordered by date alone, a member
  restating the name it holds put the old name back over a rename accepted a second before its own
  frame - for every member, with no notice to say so, and with no heal. A statement dates a name and
  never renames, so any `groupRenamed` frame beats it whatever the dates; between two statements the
  later server time wins and a tie goes to the larger name. The rank keeps the order total, so the
  outcome does not depend on reading order. An ANSWER (below) ranks between the two: it beats every
  plain statement whatever the dates, and answers are ordered by the date of the rename each restates
  (`renameAt`), then by name (#3888 re-review, A3) - ordered by sending time, an answer reflecting an
  older rename sent late put a stale name back on every member a statement dated. It carries no more
  trust than a rename: `renameAt` is refused unless it lies at or before the answer's own server time
  (`unbounded-rename-time`), and any member may send a rename outright. The rank is stored beside the
  date (`NameRank`, read by one rule, `nameRankFields`: `nameFromStatement`, `nameRenameAt` for an
  answer, `nameRenamedBy` - the rename's MLS-authenticated sender - for a rename; local SQLite v22
  columns `name_from_statement`, `name_rename_at`, `name_renamed_by`; IndexedDB keeps the fields) and
  travels in the join push (`groupName.statement`, `.renameAt`, `.by`). An absent rank is a rename's:
  a step-1 inviter dated names from renames only.
- **A pending rename is never superseded by a statement** (`pendingRenameVerdict`). A row a
  statement dated answers `resend`: the re-sent rename outranks the statement on every device. Read
  as "a later name", a member's restatement of the base - the rollout itself - cancelled this
  device's unanswered rename without a word (#3888 review, B1).
- **Read, live and replayed, by one rule** (`applyNameStatement`): the rename frame's bound on the
  signed `sentAt`, then written only when it supersedes. A statement that loses to a rename-dated name
  of ANOTHER text is a SPLIT: the stating device never read that rename (a stale list, a missed
  frame, a crossing). It is counted once per conversation and name at INFO on both paths
  (`reportOutrankedStatement`, its length and never its text).
- **The answer heals the split** (`statementAnswerDue`, `answerOutrankedStatement`,
  `settleOwedAnswer`). A device whose row holds a name dated by a rename made BY ITS OWN USER answers
  a plain statement of another name with ONE silent statement of its name, marked
  `answers: <statement id>` and carrying `renameAt`, the rename's date. It outranks every plain
  statement, so every device holding a statement-dated name converges on it; a device holding a
  rename-dated name keeps its own.
  - **Only the rename's author answers** (#3888 re-review, A2). Every rename-dated device answering
    cost one frame per member device for one straggler - about 300 in a 150-member group - each taking
    a slot in the group's capped log and evicting real messages. The author is the rename frame's
    sender, stored beside the name (`nameRenamedBy`), so the answers are bounded by ONE user's
    devices. A device that reads an answer saying exactly what it owes (same name, same `renameAt`)
    settles its own unsent (`answerReadSettlesOwn`, live and replayed). An author no longer in the
    group answers nothing: that residual is counted at INFO (`reportOutrankedStatement`) and accepted.
  - **A rename dated before the author was stored learns it from its notice** (#3888 re-review,
    decision taken; `backfillRenameAuthor`). Every group step 1 dated is such a row - the very case
    the answer exists for. Before an outranked statement is weighed, a rename-dated row with no
    `nameRenamedBy` reads this device's own stored notice of that rename: a `groupRenamed` notice
    naming the row's name, dated by the server at exactly `nameAt`, whose `actor` is the author
    (`renameAuthorFromNotices`). It decrypts ONLY the window that can hold it,
    `[nameAt - 24 h, nameAt + 24 h]` (the notice row is dated by its frame's `sentAt`, bounded by the
    server time either way; `getMessagesSince` with its `until`), so a conversation of any size costs
    the same two days; a search that finds nothing is noted in memory per (conversation, `nameAt`)
    and not repeated by a later statement - so a notice that arrives LATER (a history bundle filling
    the window) is read only after a restart clears the memo, at the next outranked statement. It
    runs there, not in the store migration, because notice rows are sealed under the device key the
    migration does not hold; once found it is stored. **What
    stays uncovered**, logged at INFO and left empty: a rename whose notice this device never wrote
    (it joined after the rename and was handed the name by a step-1 push), whose notice was collected
    by the retention window, or whose notice predates the notice's `actor`. Those rows answer nothing
    until the next rename.
  - **A notice relayed by a peer in a history bundle carries a CLAIMED actor**, and the backfill
    trusts it as it trusts a notice this device drew. The worst case is the same as below: a wrong
    author answers when it should not (a redundant answer of the name it holds) or a right one
    stays silent (a missing answer - the residual counted above). It never changes a name.
  - **The `by` a join push relays is the inviter's word, unverified.** A newcomer stores it as its
    row's author. The worst case is bounded: a newcomer told that ITS user made the rename answers
    when it should not - a redundant answer, of the name it holds, which the read-side dedupe and the
    answer's own rank make harmless; one told another user's id answers nothing it would have.
  - **Owed, never scheduled** (#3888 re-review, A1). The debt is written on the row
    (`nameSync.answer = {to}`) and saved before anything is sent; the frame minted for it is written
    too, before its send. Only a send settles it (`ownAnswerOutcome`): no answer or a send not made
    keeps the frame, re-sent as the SAME frame; a clock refusal drops the frame and keeps the debt; an
    eviction or a deleted group settles it. It is sent by the drain that follows the statement and, if
    a restart, a sign-out or a lost tab comes first, by the next connection's sweep - one function,
    under the statement's rules (drained group, receivers' bound by the sweep's server clock). A later
    rename by anyone else makes it void: that rename reached the members it was for. A duplicate
    answer is harmless; a lost one left a two-member group split for good.
  - **It terminates by construction:** an answer is never answered, a statement-dated device never
    answers, and a device owes at most ONE answer at a time (one heals every plain statement, past and
    future, since it outranks them all); a settled one keeps the id it answered, so a re-delivery adds
    nothing. Plain statements are finite (a creation, one restatement), so the answers are too.
  - Two renames' authors that disagree both answer; the statement holders take the answer of the
    NEWER rename whatever order they read them in. The rename holders' own split is a rename-level
    one, older than this step, closed only by a later rename. The archive replay counts and dedupes
    but never answers: an answer is owed where the statement was read live.
- **At creation** (`createNewGroup`, `stateCreatedGroupName`): a named group sends its statement right
  after its row is written, in the first epoch. The creation does NOT wait for it (#3888 review, S2):
  the outcome is written on the row when it comes. An invitee admitted after it lands is handed the
  name dated by the join push; one whose Add crossed it reads it live, or restates the very same name
  at its own first sweep. A statement that fails never fails the creation.
- **Once for each existing group** (`stateGroupNameOnce`, in the connection sweep after the label
  repair, `NameSyncSettler.state`). Any member device of this build may be the one: the first to sweep
  the group after the update. Concurrent ones settle by the tie rule. `nameStatementDue` decides from
  the row alone:
  - only a group row that is `active` and undated;
  - only a name the row and the server's list AGREE on. A raw id, an empty name or a placeholder never
    becomes the members' word;
  - not while a rename of this device's own is `pending` or owes its server copy. Their settlement
    compares the row's date with the base, so a statement would stop the re-send. An `unconfirmed`
    frame does not block: if it landed, its relayed copy is a rename and outranks the statement;
  - only once the link has drained the group (`isGroupDrained`), so a rename among what arrived
    dates the row first. An undrained group is CHAINED on its first drain (`whenGroupDrained`, one
    chain per group), never skipped to the next sweep;
  - only within the receivers' bound, as the server's clock read ONCE for the whole sweep proves it
    (`SweepClock`, `sweepServerNow`, from the group row read's `Date`, with the rename re-send's
    `RENAME_RESEND_MARGIN_MS`); a chained statement reads its own. A device whose clock is outside the
    bound states nothing, and says so once per sweep.
- **"Once" is stored state, never a clock.** A row a frame dated is never stated again: the date and
  its rank are persisted with the name, and a restart reads them back. The send's outcome is a type
  (`NameStatementOutcome`, from `sendNameStatement`, classified at the throw) and is written to the row
  by `ownNameStatementOutcome`:
  - **no answer**: recorded as `nameSync.statement` and re-sent as the SAME frame (its id and signed
    `sentAt`) by the next sweep. That is one statement, however many copies. If the record's `sentAt`
    has left the bound, a fresh statement replaces it;
  - **answered with no server time**: recorded `answered`. The members dated it and this device cannot,
    so it never states it again;
  - **refused**: the record is dropped. Either nothing was posted or no member takes it, and a later
    sweep may state the name afresh.
- **The accepted cost, unchanged from step 1:** an older build's rename made through the server's list
  alone does not move a dated name. Once every group is dated, that covers every group. The minimum
  version for step 3 is this build (owner, 2026-11-17).
- **A step-1 newcomer mis-ranks a statement.** An inviter of this build relays a statement-dated name
  with `statement: true`; a step-1 (1.7.1) device ignores the field and stores the date with no rank,
  as it stores every date. While it runs 1.7.1 nothing differs: 1.7.1 orders by date alone and
  ignores `groupNamed`. Once it updates, that row reads as RENAME-dated with no author: a later
  statement no longer moves it, and it never answers, so its split stays until the next rename. That
  is the measured residual (`reportOutrankedStatement`).
- **A downgrade to 1.7.1** keeps the store (SQLite at v22: 1.7.1 runs no branch above 21) and
  writes rows without the three rank columns (its `INSERT OR REPLACE` names none of them, so they go
  NULL on every save). On the next update:
  - every statement- or answer-dated name it saved comes back RENAME-ranked with NO AUTHOR, with the
    effect above; a rename's author is lost the same way. Such a row tries the notice backfill again
    the next time a statement is outranked, so an author whose notice is still stored comes back;
  - the `nameSync.statement` and `nameSync.answer` records are dropped by 1.7.1's parser on its next
    write: an unanswered statement is minted afresh, and an OWED ANSWER IS LOST - the one residual of
    A1, and only across a downgrade.
- **The rank columns are added on every open, not only under v22** (`conversationNameRankStatements`,
  guarded by column name). An earlier head of #3888 stamped a store 22 with only `name_from_statement`;
  that store skipped the v22 branch and every `saveConversation`, which names all three, failed.
  Guarded by `sqliteConversationColumns.test.ts`.

Readings owed: none on a phone. A statement that only dates is silent, and its order is read deterministically by the
unit tests (`groupName.test.ts`, `systemMessageHandler.groupName.test.ts`,
`serverGroupConversation.nameSync.test.ts`, where the restart goes through the real SQLite store,
`historySystemEvents.bundleAuthorship.test.ts`, `groupCreation.unnamed.test.ts`).

## The remaining steps, in order

1. **Step 3 - the server stops knowing group names (about 1 week, native included).** Create and rename
   send no name, and the server refuses one. The `groupName` push field and the join-ask
   `contentArg` go. The native push path names the group from the mirrored rows (Android
   `ChatBackgroundService`, iOS App Group copy). The invite preview carries the name in the link's
   `#fragment` (decided, below).
   Builds older than step 1 read only the server's list, so this step ships behind the minimum-version
   gate ([legacy-compatibility](../legacy-compatibility.md)) at the version decided below.
2. **Step 4 - the held migration (about 1 day, then the owner's approval line).** Set `dm_groups.name`
   to NULL with a before and after count of rows still readable by the server. Rollback: the column
   stays and the clients write nothing to it, so reverting the code needs no schema change. The names
   themselves come back only from the pre-migration dump. The migration is HELD
   ([cicd](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
3. **Step 5 - the sealed community state (2 to 4 weeks).** Community name, photo, salon names, role
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
