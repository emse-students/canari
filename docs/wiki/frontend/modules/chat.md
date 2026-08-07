# Chat module

**Routes**: `src/routes/chat/`  
**Components**: `src/lib/components/chat/`, `src/lib/components/messages/`, `src/lib/components/sidebar/`  
**Composables**: `useChatSession.svelte.ts`, `useConversations.svelte.ts`, `useMessaging.svelte.ts`

## Responsibilities

- MLS end-to-end encrypted direct messages and group chats.
- Real-time message delivery via WebSocket (chat-gateway).
- Offline message delivery via pull on reconnect (`fetchPendingMessages`).
- Message reactions, edits, deletes.
- Media attachments (images, files — CEK in MLS ciphertext).
- Read receipts.
- In-chat message search.
- Conversation sidebar with direct messages and group list.

## Composable architecture

The chat module is split across three composables:

| Composable | Responsibility |
|---|---|
| `useChatSession` | Session lifecycle: login, WebSocket, reconnect, MLS init, device sync |
| `useConversations` | Conversation state: create, list, select, paginate, history replay |
| `useMessaging` | Message operations: send, receive, react, edit, delete, media upload |

Conversation state lives in a `SvelteMap<string, Conversation>` local to the composables (not a global Svelte store). Both `MainChatPage.svelte` and `ChatBackgroundService.svelte` instantiate their own instance.

## Key components

| Component | Role |
|---|---|
| `MainChatPage.svelte` | Root chat page, orchestrates sidebar + chat area |
| `ChatArea.svelte` | Header + message list + composer |
| `ChatComposer.svelte` | Message input, media picker, reply preview |
| `ChatMessageGroups.svelte` | Groups messages by date, sticky date indicator |
| `MessageBubble.svelte` | Renders a single message with reply, reactions, status |
| `ConversationMediaPanel.svelte` | Side panel showing shared media for a conversation |
| `MessageEmojiPicker.svelte` | Emoji reaction picker (locale-aware FR/EN i18n) |
| `Sidebar.svelte` | Conversation list, community/workspace switcher. The community rail supports drag-and-drop reordering (`svelte-dnd-action`); order is optimistic locally then persisted via `ChannelService.reorderWorkspaces` |

## Message pipeline

```
WebSocket frame
    |
enqueueMessage()      <- serialized queue, one message at a time
    |
messageCallback()
    |
connection.ts handler:
  - isWelcome -> processWelcome() -> create conversation -> replay history
  - known group + isReady -> processIncomingMessage() -> decrypt -> dispatch
  - unknown group -> buffer until Welcome arrives
```

See [`protocols/mls-protocol.md`](../protocols/mls-protocol.md) for full flow details.

## Outbox (outbound delivery)

`utils/chat/outbox.ts` owns every outbound message. A send is persisted first and transmitted
second, so the queue - not the network call - is what guarantees delivery. The flusher re-encodes
the proto against the *current* epoch at send time (epoch changes are transparent), is idempotent
on the stable `messageId` (a re-send after a crash is deduplicated by the receiver), and never
sends into a group that is not healthy.

**The barrier before every flush is a correctness device, not an optimisation.**
`waitForMessageQueueIdle()` lets the *incoming* queue drain first: `fetchPendingMessages` (on
reconnect or resume) only enqueues the missed frames, and applying them - the commits that advance
the epoch - is asynchronous. A flush triggered by `online` or `visibilitychange` that skips the
barrier can send at a stale epoch, which up-to-date peers cannot decrypt. That is a silent loss:
the sender sees a delivered message and the recipient never receives one.

### Only the leader tab flushes

The queue is shared across tabs - it is in IndexedDB - but **encryption belongs to the leader tab
alone**. `runFlush` returns before anything else when `getIsTabLeader()` is false and posts
`outbox_flush_request` on `canari-tab-messages`; the leader drains on the follower's behalf and
answers `outbox_entry_sent` so the follower can settle the echo it is showing as `pending`. Only the
instruction crosses the channel, never the message, so a lost nudge costs a retry and nothing else.

This is not tidiness. Two tabs hold two MLS clients loaded from one snapshot, so a send from the tab
whose ratchet is behind is encrypted at a generation the peer has consumed and is dropped on arrival
as a duplicate - 4 losses in 9 sends when measured (WP-MULTITAB-1, in
[cross-client-testing](../../cross-client-testing.md#two-tabs-of-one-account-diverge-their-ratchet-and-the-losers-message-is-dropped-wp-multitab-1)).
The same reasoning is why a follower promoted to leader **reloads** rather than picking up where it
left off: the gate froze its in-memory state at load time while the leader kept advancing the one on
disk.

### The flusher resolves its token, and does not run while offline

Two rules about *when* the queue is allowed to try, both learned from the offline-unlock work
([auth](auth.md#what-happens-on-reconnect)):

- **An access token is time-bound, so a COPY of it passed down a component tree is a bug waiting for
  the TTL.** Resolve it at the fetch, through `getToken()`. Where a component still takes an
  `authToken` prop, that prop means "the session is authenticated", never "here is the credential to
  use" - a value captured at mount is stale by the time a queued entry flushes an hour later.
- **The retry ladder must not run while offline at all.** Every failed attempt raises the backoff,
  so a queue that keeps trying against an absent network is slowest exactly when connectivity comes
  back. `canFlush: () => !ctx.isOfflineSession()` holds it, and `promoteOfflineSession` calls
  `flushOutbox()` **after** the token is refreshed and the connection re-established - never beside
  it. The outbox's own `online` listener fires earlier than any of that.

### Everything the outbox swallows, it logs

The queue is deliberately best-effort at every step - a storage write that fails must not take the
send down with it - and that makes silence the default failure mode. Each such branch therefore
logs, because these are the only traces available when a message is accepted locally and never
arrives (see WP-FWD-1):

| Branch | Why silence there is dangerous |
|---|---|
| Reading the queue | A failure is indistinguishable from an empty queue, so the entry is simply never flushed |
| The idle barrier | Failing it means sending at a possibly stale epoch - the silent loss above |
| Group not sendable | Holds the message indefinitely while `requestReAdd` recovers; from outside it looks delivered |
| Backoff skip | Explains a message sitting in the queue with nothing else happening |
| Delete after send | Leaves a *sent* entry queued, so the next flush sends it again |
| Backoff not persisted | Loses the attempt count, so the entry retries at full speed |
| Media ref not persisted | A crash before the send re-uploads the same file |

`enqueue` logs too: it is the first trace of a message on this device, and without it a send that
never reached the queue cannot be told apart from one the queue accepted and lost. Correlating a
loss needs `[OUTBOX]` from the sender and `[QUEUE]` from the recipient at the same moment.

## Message envelope

All messages are serialized as a `MessageEnvelope` union before MLS encryption:

```typescript
type MessageEnvelope =
  | { type: 'text'; content: string; replyTo?: MessageReference }
  | { type: 'media'; mediaId: string; fileName: string; mimeType: string; cek: string }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | { type: 'edit'; targetMessageId: string; newContent: string }
  | { type: 'delete'; targetMessageId: string }
  | { type: 'system'; event: string; data?: unknown }
```

`appMsgToEnvelope()` (`utils/chat/messageUtils.ts`) is the canonical decoder (protobuf AppMessage ->
MessageEnvelope).

### A system event is executed, never displayed

**`appMsgToEnvelope` returns `null` for a `system` AppMessage, and that null is load-bearing.** Every
call site that can receive a control event is written as `if (envelope) { display } else if
(msg.system) { handle }` - `handleKnownGroup` and the Welcome buffer in `setupMessageHandler`, the
replay in `history.ts`. Make it return an envelope and those handler branches become dead code: the
event is never applied and its JSON payload is rendered as an ordinary message attributed to the
sender. That is exactly what a `msg.system` branch added to it in `7e9d66e8` did until 2026-08-03.

A **channel** notice is the one system message that IS pre-rendered text: `inviteMemberToChannel`
sends `mkSystem('memberAdded', <already-localized sentence>)` into the channel, because a channel
has no per-event handler. The two channel decode sites - `channelEventHandler`
(`channel.message.created`) and `decodeChannelMessageRow` (history + search) - ask for it
explicitly through **`appMsgToChannelSystemEnvelope`** and attribute it to `'system'` with
`isSystem: true`, so it renders centred and neutral rather than as a message from whoever triggered
it. `ChatMessageGroups` centres on the ROW flag; the `system` envelope kind only gives the pill.

### Channel invitation card

Inviting someone to a community sends a `channel_invitation` system event into the 1:1 MLS DM, and
BOTH sides render the same `channelInvite` card in that conversation:

| Side | Envelope built by | Copy | Join button |
|---|---|---|---|
| Invitee | `mkChannelInviteEnvelope` | "{inviter} vous a invité..." | yes |
| Inviter | `mkChannelInviteSentEnvelope` | "Vous avez invité {member}..." | no |

`channelInvite.invitedName` is the discriminator: **present = the inviter's copy**, and its presence
is what suppresses the Join button. Never set it on the invitee's copy.

The card has **three** producers - `inviteMemberToChannel` inserting the inviter's local copy, the
live `channel_invitation` branch of `systemMessageHandler` on their other devices and on the
invitee's, and `applyReplaySystemEvent` when the frame is only read back from the stream (an
invitation that arrived while the device was offline). All three id the bubble with
`channelInviteMessageId(channelId, inviteeId)`, so they converge on one card instead of stacking
three; `addMessageToChat` dedupes on that id. Its sibling `channel_key_distribution` is deliberately
NOT replayed: `hydrateChannelHistoryKeys` pulls every epoch key from the server when the channel is
opened, so the MLS delivery is an optimisation, not the only source.

`channelInvite.workspaceImageMediaId` carries the community's cover so the card shows the real logo;
absent (no cover, or an envelope written before the field existed) it falls back to the community
initials via `GroupAvatar`.

The Join button routes through `openInvitedChannel`, which is also what an accepted invite **link**
(`/c/join/[token]`) uses. Both must go to `/communities` - a channel target cannot be displayed by
`/chat`, and routing there is what once made the button look inert. Selection is left to the pending
target effect in `ChatBackgroundService`, which refetches the communities **once** when it does not
recognise a channel: a just-accepted invitation is never in the loaded sidebar, and
`openNotificationTarget` refuses a channel it cannot find.

### Deep-linking into a channel

Every deep link publishes its target to `notifNav` and navigates: the invite card's Join button, an
accepted invite link, a tapped message or channel notification. All of them have to survive the
same two hazards.

**The target is held until it is displayed, not until it is selected once.** Selecting it once is
not enough, because the conversations map is emptied and rebuilt wholesale by the IndexedDB restore
(`loadExistingConversations`) and pruned on every community refetch, so a target selected while the
map is still filling is dropped moments later. The selection watchdog in `useConversations` then
nulls it, which is what made *every* deep link land in the right tab with nothing open. So:

- `ChatBackgroundService` **owns the landing** and is the only place that runs it. It is mounted on
  every route and reads the same `globalConvs`/`globalChannels` singletons a page would, so a
  second copy inside `MainChatPage` only released the target early.
- The effect re-runs on every mutation of the conversations map and **re-asserts** a lost
  selection, then stays idle once the target is on screen - otherwise a plain incoming message
  would re-select it and refetch its history.
- The watchdog keeps a selection that IS the landing: absent from the map means "not there *yet*"
  while a landing is in progress.
- **A target is a group id; a selection is a map key, and for a DM they are different strings.**
  Only a community channel is keyed by the very id that names it - a DM or group is keyed by its
  display name and carries the group id in `conversation.id`. So neither of the two comparisons
  above may be made on the raw strings: both go through `resolveConversationKey`, the single
  id -> key lookup (direct hit, then a scan on `conversation.id`) that `openConversationFromId`
  itself is built on. Matched raw, `endLandingUnlessTarget` read the landing's own
  `selectConversation(key)` call as the user opening something else and ended the landing at the
  instant it succeeded, so the restore dropped the selection a moment later and the tap arrived on
  the right tab with nothing open; and the idle guard never recognised a landed DM, re-selecting it
  and re-requesting its history on every mutation of the map. Pinned by
  `openConversationFromId.test.ts`.
- `landingRecovery` / `landingAfterRefresh` decide when to stop: refetch the communities once for
  an unknown channel, retry if that refetch was dropped by the loader's in-flight guard, and
  abandon (releasing the target) when a real refresh still does not know it, or when a DM is absent
  from an already-restored map. Abandoning matters as much as holding - it is what lets the
  watchdog clear a channel whose access was revoked.
- `loadChannelWorkspacesFromBackend` retries transient failures internally: up to 3 attempts with
  backoffs of 1 s, 3 s and 7 s. It keeps the existing sidebar list on every failure and exposes the
  final error in `globalChannels.workspacesLoadError`. Auth failures (401/403) are not retried.
  `ChatBackgroundService` listens for `online` and `visibilitychange`: when the user is logged in and
  `workspacesLoadError` is set, it retries the load automatically, so a notification or deep link
  that arrived offline eventually lands once the connection returns. The landing itself reads that
  error through `landingAfterRefresh({ refreshFailed })`: a refetch that failed returns `retry`, not
  `abandon`, because the list the target would have been in was never fetched.
- The landing ends when the user opens another conversation, backs out of the thread, or leaves the
  target's route.

`/chat` and `/communities` are **separate route components**, each rendering its own
`MainChatPage`, so moving between them remounts it. Its route-mode switch clears the selection so
the previous tab's thread does not leak across - but a deep link publishes its selection *before*
navigating, so an unconditional reset wipes precisely what the link asked for. Both a pending
target and an existing selection are checked with `selectionBelongsToRoute`: one whose
`chatDeepLinkRoute` already matches the incoming mode can only have come from a deep link, since a
genuine tab switch carries one made under the mode being left. Entering the *other* mode ends the
landing. Pinned by `notificationRouting.test.ts`.

The invite link resolves its landing channel from `getWorkspaceBySlug`, which returns only channels
the caller may read; it prefers a **public** one, so a fresh joiner lands in the open room rather
than in whichever private channel happened to sort first.

The inviter's copy is inserted **locally** by `inviteMemberToChannel`, because MLS never hands a
device back its own application message. The `senderNorm === userId` branch of
`systemMessageHandler` builds the identical envelope, and only ever runs on the inviter's *other*
devices. Pinned by `systemMessageHandler.channelInvite.test.ts`.

### Being removed from a channel or a community

Removal is pushed, not polled, so the person removed sees it happen without reloading. The server
sends `channel.member.kicked` (a channel kick, a community kick, or someone leaving) and
`channel.member.removed` (the channel settings panel) to **everyone still in the community as
well as the target**, which makes the payload - not the arrival of the event - the thing that
decides what happens locally. `channelEventHandler` normalises both onto one callback, and
[`removalOutcome`](../../../frontend/src/lib/utils/chat/memberRemoval.ts) turns it into one of
four answers:

| Outcome | When | Local effect |
|---|---|---|
| `ignore` | `kickedUserId` is not the local user | none - it is someone else's removal |
| `community` | no `channelId` (community-wide kick) | purge the whole workspace + toast |
| `channel` | private channel | drop that channel + toast |
| `public-channel` | public channel | none - every member still reads it |

The two traps this encodes are worth restating, because both shipped as bugs: acting on a
broadcast without checking the target made *every* member's client delete a channel when one
person was kicked from it, and a community kick carries no `channelId` at all, so a handler that
started with `if (!event.channelId) return` did nothing for the very person being removed.

A purged community goes through `dropCommunityLocally` in `ChatBackgroundService`, shared with
`workspace.deleted`: it reads the doomed channel ids **before** the purge, because clearing the
chat panel afterwards needs to know whether what was on screen belonged to the community that
just vanished.

### Channel message identity

A channel bubble is keyed by the **server row id**, everywhere. Live delivery
(`channelEventHandler`) and history loading (`decodeChannelMessageRow`) must agree, because every
server-side operation - delete, pin, poll vote, reaction - addresses a message by that id. The
AppMessage id carried inside the ciphertext is deliberately NOT used: a channel send has no
optimistic echo to reconcile (`sendChatMessage` returns straight after the POST and lets the
`channel.message.created` broadcast render the bubble), so keying on it only made a live message
unaddressable until the next reload.

### Reactions: two mechanisms

| | DM / group | Community channel |
|---|---|---|
| Transport | encrypted MLS system message (`add_reaction`/`remove_reaction`) | `POST .../messages/:id/reactions` |
| State | `useMessaging.messageReactions` | `stores/reactionStore.svelte.ts` |
| Server sees | nothing | the tally (cleartext, it does the counting) |
| Live update | replayed to every member by MLS | `channel.reaction` broadcast |

`MainChatPage` picks the map per conversation type; below that, the component chain is identical,
so a reaction pill looks and behaves the same on both sides. Toggling is optimistic and rolled
back by re-applying the same toggle, which is its own inverse.

### A control event is applied twice, on two different devices

Every message mutation - reaction, edit, delete, pin, read receipt - travels as a **control event**
in the durable outbox (`enqueueControlEvent`), and lands on peers through `systemMessageHandler`,
which applies it to the conversation AND writes it to the encrypted store.

The sender's device never runs that handler: **MLS gives no echo of your own message**. So the
issuing device has exactly one code path - the optimistic update in `useMessaging` - and that path
owns *both* halves. Updating `ctx.conversations` alone makes the mutation look applied until the
next load, at which point the store answers with the pre-mutation row and the change appears to
have been rejected. That was WP-EDIT-1: an edit that reverted on refresh while every peer showed
it correctly.

`persistLocalMutation` is the one place that writes a locally-applied mutation. It is best-effort
and logs on failure - the control event is already durable in the outbox, so a failed write costs
a stale local row, never a lost mutation for the group.

#### The same rule applies to the message itself, and a UI buffer broke it (WP-ECHO-1)

`addMessageToChat` is the single writer for the sender's own copy, for the same reason: no echo. It
opens with a bulk-ingest early return that holds the message in `bulkIngestBuffer` and returns
**before `saveMessage`**, so that a large inbound drain re-renders the list once instead of per
message. Three facts turn that optimisation into a loss:

- `bulkIngestActive` is raised by *every* inbound drain, not only a long one, so the window is
  ordinary rather than exceptional;
- `beginBulkMessageIngest` and `resetMessageCatchupState` both `clear()` the buffer without
  flushing, so a second drain starting mid-window discards whatever the first was holding;
- the outbox cannot repair it, because `persistSent` resolves the message through `findMessage`,
  which only scans `conversations` - a buffered message was never there, so it returns silently.

Result: a message composed during any drain window was rendered by the peer and gone from the
sender at its next load, with nothing logged. It also explains why the offline path was always
correct - offline there is no inbound drain, so the echo took the live path (MSG-10).

Fixed 2026-08-07: `if (bulkIngestActive && !isOwnMessage(senderId, ctx.userId))`. An own message is
never deferred; one extra rendered item is not what the buffer exists to prevent. Both clear sites
now call `warnIfDiscardingBuffered`, because a dropped buffer and a message that never arrived are
otherwise the same observation. **The general rule: a UI buffer in front of a persistence call is a
persistence bug.** Buffer after the durable write, or the early return skips the writer.

The at-rest projection of a message is shared by both storage backends
(`db/messagePayload.ts`): a field that is not in `toMessagePayload`/`fromMessagePayload` does not
survive a reload, whichever backend is in use. `editedAt` was missing from both for exactly as long
as it existed on the in-memory type.

### Forwarding

`forwardMessage` crosses freely between the two worlds: a channel message can be forwarded into a
DM and a DM message into a channel. Only the transport differs (MLS group vs channel epoch key);
a media forward re-sends the same envelope in both cases, so no blob is re-uploaded and the CEK
travels with it.

## Pooling history between devices (BUILT 2026-08-07, deploy owed)

Today's exchange used to be all-or-nothing: `sendFullHistoryBundle` shipped the responder's ENTIRE
store and the receiver deduped by id, one way, with neither side knowing what the other held. It is
now a diff. The design was settled on 2026-08-02 by reading the code; what shipped differs from it on
exactly one point, recorded below.

**The algorithm already existed and was tested** in the QR sync engine (`sync/syncEngine.ts`, since
deleted with that feature): a sorted manifest of message ids per conversation, and a symmetric
difference over two of them. What was missing was the TRANSPORT, and that is what
`utils/chat/historyManifest.ts` (pure, 42 tests) plus `utils/chat/historyDigestRendezvous.ts`
(11 tests) now carry - this time between the account's own devices, with no user gesture at all.

**THE DIRECTION IS FLIPPED against the design above - deliberately, do not restore it.** The design
had the RESPONDER send the digest and the REQUESTER diff. It ships the other way round: the
**requester broadcasts its digest, the elected responder diffs**. Two reasons, both structural. It is
backwards compatible with no negotiation - an old responder ignores an event it does not know and
sends a full bundle, which is exactly right; a new responder receiving nothing from an old requester
falls back to the same. And it costs one round trip fewer, because the responder's reply already
carries the data instead of asking for it.

**The legs as built.** Leg 1 is the WS `history_request`, unchanged - server-side election is what
keeps one responder instead of a storm. Leg 2 is `history_digest`, broadcast inside MLS by the
requester (`setHistoryDigestBroadcaster`, awaited by `historySolicit.fire` before the WS request).
Leg 3 is the responder's answer: it diffs, sends a `history_bundle` filtered by id for what the
requester lacks, and sends `history_pull {to, ids|months}` for what IT lacks. A pull is answered by a
bundle and a bundle asks for nothing, so the exchange cannot re-enter itself - the WP-RETRANSMIT-1
lesson, applied by construction.

**The rendezvous.** The two halves travel by different transports and nothing orders them: the
elected responder can be handed the WS request before or after the digest reaches its inbound MLS
queue. So it waits `HISTORY_DIGEST_GRACE_MS` (3 s) for the digest, then falls back to
`sendFullHistoryBundle`. A stored digest is CONSUMED on take - a later request must diff against a
fresh snapshot, never a minute-old claim (TTL 60 s).

**Two digest modes, by size.** `ids` (the sorted id list) below `DIGEST_ID_MODE_MAX` (1000), `buckets`
above it: per `YYYY-MM`, a count plus a truncated SHA-256 of that month's sorted ids, ~2 KB for any
history. Three details are the whole correctness of it:

- **Months are cut in UTC.** Two devices in different timezones - or one phone that travelled -
  otherwise disagree about every message near a boundary and re-send that month forever.
- **Ids sort by CODEPOINT, never `localeCompare`.** The sort feeds the hash, so a locale-dependent
  comparator makes every bucket disagree between two devices. The sort is part of the protocol.
- **A differing bucket is requested in BOTH directions.** A fingerprint proves the month is not
  identical, never which side is short; guessing drops messages, over-asking costs bandwidth and the
  receiver already dedupes by id.

**`announceComplete` distinguishes two silences.** "I compared my WHOLE store and you are complete"
may send an empty bundle (it clears the requester's marker); "I was asked about a SUBSET and hold
none of it" must stay silent, or it would clear a marker it never answered.

**A failed store read is not an empty store.** `readHistoryEntries` returns `null` rather than `[]`
on a read error, and the responder then says nothing at all - an empty store is a fact worth telling
a peer, a failed read is a claim we are not entitled to make.

**Deletions are a non-problem**, verified in code: a deletion keeps a TOMBSTONE row (`isDeleted`), so
the id stays in the manifest, and both stores import non-destructively (`INSERT OR IGNORE` / IDB
`add`). Bulk row deletion exists only for CHANNELS and for a whole conversation. On merge a tombstone
WINS over a body, or a peer that missed the deletion undoes it.

**Metadata**: the digest rides inside MLS, so the server learns nothing it does not already hold.
Co-members learn which ids this device kept, hashed per month in bucket mode. Accepted.

**Two traps, both now handled.** Every leg is a GROUP broadcast, so the pull carries its target
(`digestIdentity(userId, deviceId)` - the DEVICE, so a user's other two devices do not answer a pull
addressed to the first) and non-targets ignore it. And the REPLAY path (`historySystemEvents.ts`)
ignores `history_digest` / `history_pull` through an explicit `REPLAY_IGNORED_EVENTS` set - transient
negotiation, meaningless when re-read days later, and naming them means adding a branch later has to
be a decision rather than an accident.

**A digest names a device, and a member can only misreport its OWN.** `systemMessageHandler`
cross-checks the `userId` a `history_digest` claims against the authenticated MLS sender before
recording it; the device half is unverifiable and harmless (the worst a member can do is answer for
the wrong one of its own devices).

**Scope is DMs and groups only.** Channel rows are wiped and re-fetched from the server tally at
every load, so pooling would fight the refresh (`isChannelConversationId`).

This subsumes the `no-local-history` clause of the current marker: "awaiting history" becomes "my
diff with at least one peer is non-empty", which empties itself.

### Order of work

1. **DONE** - the pure `historyManifest.ts` plus its tests: the digest build and the diff, no
   transport.
2. **DONE** - the wiring: the requester broadcasts a digest, `handleHistoryRequest` awaits it and
   diffs, `systemMessageHandler` gained the digest and pull branches, `groupActions` gained
   `sendHistoryBundleForIds` / `sendHistoryDigest` / `sendHistoryPull` / `readHistoryEntries`.
3. **DONE** - marker semantics: see below.
4. **DONE** - the give-up counter (`noteDesyncDetected`), the derived `RETENTION_MS`, and the three
   riding defects at the end of this section.
5. Wiki + `CHANGELOG.md` - done. **What is left is the web deploy**, then re-running the campaign
   checks that touch the repair mechanism.

### What ends the wait, and what merely interrupts it

The marker (`awaitingHistoryRegistry.ts`) records that a group is short of history AND the evidence
for it, because the evidence decides what may end it. There are two kinds:

- A **presumption** - `no-local-history`, "I hold nothing for this group, so I cannot tell an empty
  conversation from a missing one". It is void the moment any message lands.
- A **proof** - `unreadable-frames` (the replay gave up on a frame it can never decrypt) or
  `peer-holds-more` (a peer's digest named ids we lack). Neither is unlearnt by other messages
  arriving.

So a bundle does not end a wait by existing. An EMPTY bundle does, whatever the evidence was: it is
the only authoritative "you are missing nothing", and both senders compare their whole store before
sending one - neither sends it while itself awaiting history. A NON-EMPTY bundle carries messages and
nothing more: it voids a presumption, and against a proof it leaves the marker standing and the
in-session retries running, so the next exchange asks for what is still missing. That is what makes
the marker empty ITSELF: each exchange strictly reduces the difference, so it converges on the empty
bundle rather than on a bundle count. It also fixes a defect that predates the diff - a history big
enough to be chunked arrives as several non-empty bundles, and the first of them used to end the
solicitation.

`REASON_RANK` is what keeps a proof from being overwritten by a presumption, in both directions: on
write (`markAwaitingHistory` keeps the higher rank) and on clear (`isProvenAwaitingReason`).

### When the narrow repair is not working (the give-up counter)

`decrypt_failed` asks a peer for a time WINDOW out of an in-memory ring, so it fails for reasons no
amount of repetition fixes: the sender reloaded and lost the ring, the payload aged out, or the loss
is older than the window reaches. `noteDesyncDetected` therefore returns a verdict rather than a
boolean - `{ signal, escalate }`, and never both. Three signals inside five minutes (so at least a
minute of continuous loss, the signal itself being rate-limited to one per 30 s) means the narrow
repair is not repairing this group, and the fourth ask would be a loop rather than persistence. The
escalation marks `unreadable-frames` durably and starts a solicitation - i.e. it hands the problem to
the diff, which reads the peer's DURABLE store, is answered by one elected member, and names messages
by id instead of by time. The count is cleared when it fires, so the escalation gets its own chance
before anything is concluded again.

`RETENTION_MS` in `recentSends.ts` is DERIVED from that window plus a round-trip margin, and the
window itself now lives there - beside the payloads it describes, since a window wider than the
retention asks for what nobody kept. It was a flat five minutes, of which three could never be
requested by anyone.

### Three defects that belonged to this work, or to nothing (FIXED 2026-08-07)

Left out of WP-HIST-2 on purpose, because each is only worth fixing once the exchange is a diff.
All three are now fixed, and the rule each taught outlives it:

- **The client ignored the `no_peer_online` the server already returns.** `deliveryKeepalivePost`
  swallowed the response body, so the requester burnt a 30 s window waiting on a question that had
  been answered immediately. It now returns the parsed body, and `sendHistoryRequest` surfaces
  `{ noPeerOnline }`. The name matters: the function returns `null` for a transport failure, a
  non-2xx, a non-JSON body and a JSON array alike, and **`null` means "no answer", never "no"** - a
  boolean would have made silence read as a negative and cancelled a legitimate retry.
- **Nothing re-solicited when a peer came back**, even though presence is polled every 10 s.
  `onPeersCameOnline` now fires `reSolicitAwaitingHistory` for every group still carrying a marker.
  It is an **EDGE, not a level**: only offline -> online, so a user already known online says
  nothing new and a user seen online for the FIRST time is not "back" - treating the level as the
  edge would re-solicit on every page load. Its registration guards on `ctx.getStorage()`, because
  `ctx.ensureMls()` CREATES the service when absent and a background callback must never do that.
- **`checkPresenceNow` had no in-flight guard.** On a bad link it stacked 4-5 concurrent
  `/api/presence` calls, each measured at 32 s. Concurrent callers are now COALESCED onto the running
  request rather than turned away, so `await checkPresenceNow()` still means "presence is fresh" for
  everyone.

### When completeness is checked - and the defect that silenced all of it

There is no periodic comparison of histories. There is a durable marker (30 days) written only when
a client has EVIDENCE it is short, and five things that make it ask again:

| Trigger | Where |
|---|---|
| the in-session burst: 2.5 s, then +30 / +90 / +180 s | `historySolicit.ts` |
| every (re)connect | `initializeConnection.ts` -> `reSolicitAwaitingHistory` |
| a peer going offline -> online | `onPeersCameOnline` |
| three decrypt failures in five minutes | `noteDesyncDetected` -> escalation |
| a slow sweep while the session is open | `startAwaitingHistorySweep`, 15 min |

The sweep is the floor, and it is there because every other row is an EVENT that a long-lived
session is not guaranteed to see again: presence is only polled for users the UI actually DISPLAYS
(`ConversationTile`, `ChatHeader`, `ChannelMembersSidebar`), so it covers DMs while the list is on
screen and a channel only when its member panel is open. It pauses while the document is hidden,
which also makes returning to the foreground fire it at once.

**The defect that made four of those five rows dead, found 2026-08-07 while answering exactly this
question.** `pending` was read with `pending.has(groupId)`, and NOTHING removes an entry when a burst
simply ends without a bundle - only a bundle that ENDS the wait, or a fresh solicitation, calls
`cancelHistorySolicit`. So a group whose peers were all offline during its three-minute burst kept an
entry for the life of the tab, and every reconnect, every peer returning and every escalation skipped
it. The situation the retries exist for was the one situation that disabled them, and a page reload
was the only cure. `isSolicitInFlight` now answers with the burst's own schedule, which is known up
front: **the end of a burst is a TIME, not an event to wait for.**

### What still has no answer: nobody online when a device joins

`notifyHistoryRequest` (`chat-delivery-service`) forwards to a random online member and otherwise
returns `{ status: 'no_peer_online' }` - **and nothing else**. Compare `notifyWelcomeRequest`, which
in the same situation persists the demand to Redis (`pending_welcome:<group>` plus
`pending_welcome_notify:{userId}`, 24 h TTL) and sends `sendFcmWelcomeRequestPending` to wake a
sleeping peer before returning the same string. So the Welcome survives an empty room and the
history request does not: a device can be admitted to a group by the durable path and hold no
history at all, with the server keeping no trace that anyone owes it one.

The client covers that gap by asking again rather than by being answered later - the five triggers
above - so the recovery always waits for THIS device to notice. The symmetric fix would be to store
the request as `welcome_request` is stored, and it is **deliberately not done**, for a reason worth
recording so it is not "fixed" later by reflex: a stored request drained hours afterwards arrives
with no digest, because the digest rides inside MLS with a 60 s rendezvous, so the responder falls
back to `sendFullHistoryBundle` - the whole-store dump this work exists to remove - for a device that
may by then need nothing. The requester has to reconnect to READ anything anyway, and reconnecting
re-solicits. So the gain would be latency, and the cost a full dump. The docstring on
`notifyHistoryRequest` already recorded the related half of this decision: no FCM wake, because a
missing Welcome BLOCKS a group while missing history only degrades it.

One gap none of this closes: a device holding SOME of a conversation, missing older messages, and
never failing to decrypt anything carries no marker - so it never asks. It learns of the difference
only opportunistically, when it happens to be the elected responder to someone else's solicitation.

### Devices compare identities, never counts

Worth stating because the intuitive design is a message count, and a count is a guaranteed false
negative: two devices that each lost a different message agree perfectly on the total. The digest
carries the sorted ids below 1000 messages, and above that one line per `YYYY-MM` with a count AND a
truncated SHA-256 of that month's ids. The hash is exactly what catches "same count, different
messages", and `historyManifest.test.ts` pins that case.

## UI features

- **Focus writing mode**: header hides when composer is focused on mobile.
- **Sticky date**: current date label stays visible during scroll.
- **Search**: in-chat search with prev/next navigation and highlight.
- **Lightbox**: full-screen image/video with pinch-zoom and download.
- **Radial menu** (mobile): long-press message -> circular action menu.
- **Read receipts**: three states — sent / delivered / read — with distinct icons.
- **GIFs**: an in-app picker (KLIPY) sends a GIF by URL; on Android the soft keyboard's own
  GIF/sticker button also works via `commitContent` (see below). GIFs skip canvas compression in
  `useMessaging.handleFilesSelected` so their animation is preserved.

### Android keyboard media (`commitContent`)

The Android soft keyboard commits rich content (GIF/sticker/image) through the focused editor's
`InputConnection.commitContent`. The native `KeyboardMediaBridge` (Kotlin) wraps the WebView input
connection to advertise image MIME types and, on commit, reads the content URI and dispatches a
`canari-keyboard-media` DOM event (`{ mime, name, data }`, base64). `MainChatPage` listens for it,
rebuilds a `File`, and routes it through the normal media pipeline (`handleFilesSelected`), so a
keyboard GIF is encrypted and sent like any picked file, in DMs, groups, and channels.

The single hook lives in the auto-generated `RustWebView.onCreateInputConnection` (marked
`CANARI CUSTOM PATCH`); all logic is in the non-generated `KeyboardMediaBridge`, so re-applying the
patch after a `tauri android` regeneration is one line. Reliable IME `commitContent` needs a recent
Android WebView; on devices where it is unavailable the in-app GIF picker still works.

## Routes

| Route | Description |
|---|---|
| `/chat` | Main chat page (conversation list + active chat) |
| `/communities` | Same page in community mode (channels) |
| `/c/join/[token]` | Accept a community invite link, then land in the joined channel |

There is **no per-conversation URL**. `/chat/[groupId]`, `/c/[groupId]` and `/g/[groupId]` were
documented for a while and never existed as routes; opening one renders an empty shell. A
conversation is opened by publishing its id to `notifNav` (see the deep-link section above), which
is why a notification tap works from any route while a hand-written URL does not.
