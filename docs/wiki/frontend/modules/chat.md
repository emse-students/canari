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

### The drain is a single point of failure for ALL inbound traffic (WP-HIDDEN-1, WP-DRAIN-1)

The queue is serialised, and `isDraining` is lowered only when the message callback RETURNS - in a
`finally`, but **behind** `await hooks.onDrainEnd()`. `enqueueMessage` starts a drain only
`if (!draining)`, **and logs nothing when it does not**. So one stuck await inside the checkpoint
stops every inbound message for the life of the tab, with not one line of output. The restart guard
at the end of `processQueue` cannot help: it runs after `drain()` returns, and `onDrainEnd` is what
hangs.

Two different awaits have already frozen all inbound traffic this way, and they are worth keeping as
the two shapes to expect:

1. **A yield that never resolves.** `runSaveEncrypted` opened with `await yieldToMainThread()`, whose
   helper resolved from `requestAnimationFrame` - **which a browser never fires for a hidden
   document**. A backgrounded tab therefore received nothing at all, silently, until refocused. The
   fingerprint is precise and reproducible with ONE tab: message #1 decrypts, logs
   `Bulk ingest done - flushing…` and never renders (the UI flush is buffered by
   `beginBulkIngest({ bufferUi: true })` and released by the `endBulkIngest` that is stuck); message
   #2 is enqueued with no drain and no log; both appear at the exact millisecond of the refocus. Two
   candidates were eliminated by MEASUREMENT rather than by reading - IndexedDB answered an open plus
   read in 1 ms from inside the stuck tab, and the encrypt worker's 60 s timeout would have failed
   loudly and released the drain.

   The fix **races** the frame against a `MessageChannel` round trip rather than choosing between
   them: branching on `document.visibilityState` would still hang whenever a tab is hidden *after*
   the callback is queued, which is exactly what a user does. The fallback is a port message and not
   `setTimeout`, because background tabs clamp timers to about 1 Hz - which would turn a
   hundred-message catch-up into minutes of stalling. `yieldToMainThread` is awaited on six paths,
   including history replay and the PIN-change batches.

2. **A recovery re-acquiring the MLS mutex the drain already holds** - a deadlock, not a slow path.
   Hence the rule that a repair whose result nobody reads (a re-add, a Welcome, an external join)
   must be STARTED, never awaited, and must log how it settles (`startRecovery`; `DeferredRecovery`
   on the Welcome path is the same lesson learnt earlier).

**Each was fixed in place; the SHAPE was not** - nothing type-checked that the next await added
there was safe. That was WP-DRAIN-2, closed 2026-08-11.

#### What closed it, and what it deliberately does NOT do

There is now exactly ONE way to await inside `drain()`: `MlsPerGroupScheduler.guarded(label, work)`,
which arms a repeating 60 s report and clears it in a `finally`. Four awaits go through it - the
lock acquisition, `processMessage`, `yieldToMainThread` and `onDrainEnd` - and each carries its own
label plus the group and queued-message id, so the log names WHICH phase is stuck rather than that
something is. The report repeats every minute with the elapsed seconds, because the elapsed time is
the diagnosis: one line says a phase was slow, twenty say it will never return.

The lock acquisition is guarded SEPARATELY from the work it protects, and they must not nest -
wrapping `runUnderMlsLock` whole made a hung handler report both labels, which is the exact
ambiguity the split exists to remove. Hence `acquireMlsLock` is called directly in the drain loop.

**It reports; it does not cancel, and the flush stays inside the window.** Moving `onDrainEnd`
behind `isDraining = false` was the other option this page used to offer, and it is wrong:
`bulkIngestPhases` is a stack, so a second drain starting during a live `endBulkIngest` would call
`beginBulkIngest` across it - a UI buffer cleared without being flushed, which is WP-ECHO-1's exact
failure and a strictly worse one. **A freeze loses nothing durable; a lost buffer does.** So the
deadline buys the only thing it safely can, which is evidence.

The per-message watchdog that used to sit in `BaseMlsService.processQueue` is deleted with this:
it covered one of the four awaits, and two watchdogs for one await would have reported the same
freeze twice while still saying nothing about the other three.
`mlsPerGroupScheduler.test.ts > a frozen drain reports itself` pins all four labels plus the
negative control - a healthy drain says nothing.

One methodological consequence, because it retired a PASS: a check that asserts **after** restoring
the tab is asserting after the very act that releases the drain. A single message can never expose
this; the second one is the whole test.

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
as a duplicate - 4 losses in 9 sends when measured, 9/9 after the fix (WP-MULTITAB-1). The guards are
`outbox.test.ts` and `tabLeadership.test.ts`; nine green sends do not prove a follower stopped
encrypting, so the mechanism is asserted from BOTH tabs' logs - the follower's
`Flush skipped - follower tab` and the leader's `Flush requested by a follower tab` carrying the
**same entry id**, which is also what proves the shared IndexedDB queue is the transfer.
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

### A mutation event is authorised on RECEIPT, by the MLS sender

`delete_message` and `edit_message` name a target by `messageId`. `handleSystemEvent` resolves it and
then calls **`mutationIsAuthorised(target, senderNorm, kind, log)`** (`systemMessageHandler.ts`),
which applies the mutation only when `target.senderId === senderNorm` (case-insensitive; an empty
`senderId` never matches). A refusal returns `true` - the event is consumed, not re-queued - and logs
`[MLS] Refused an edit|a delete of a message owned by … - only the author may mutate it`.

**Why the receiving side.** `isOwnMessage` gates the edit/delete controls, but it runs on the device
that SENDS the event: it decides what an honest client puts on the wire and nothing about what a
modified one can. Until 2026-08-12 the handlers applied the mutation by id alone, so any member of a
DM or group could delete or rewrite any other member's message on every device in it. A channel is
different - the server owns channel content and checks ownership itself - and that asymmetry is the
trap: DMs and groups are exactly the places where the server *cannot* check, being unable to read
them.

`senderNorm` is the identity **MLS authenticated for the frame**, which is what makes the check
sufficient rather than advisory: a member can lie about the message id, never about who it is.
Covered by `systemMessageHandler.mutationOwnership.test.ts`.

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

##### Verified on hardware, 2026-08-11 - and the check had to be rebuilt twice to be worth anything

The unit half (`useMessaging.bulkIngest.svelte.test.ts`, 4 tests, 3 of which fail when the fix's
condition is reverted) pins the rule. The device half asks the different question of whether the
whole chain - composer, MLS, outbox, SQLite - keeps the message on real hardware, and answering it
cost three harness rewrites, each of which is a general lesson:

1. the first run counted 25 s after a reload while drains were still arriving, so "missing" could
   not be told from "not re-rendered yet" - it reported FAIL and was **VOID**;
2. the second read logcat after the fact, by which time the ring buffer had overrun and the
   deciding lines were gone;
3. the third printed **PASS and proved nothing**: its seven sends were at 13:20:23-13:20:39 and the
   run's first drain opened at 13:20:42, so not one of them was inside the window under test.

**The window cannot be aimed at with a delay.** It opens on `[QUEUE] Drain start`
(`onBulkIngestStart` -> `beginBulkMessageIngest`) and closes on `[MLS] Bulk ingest done`, and on A1
that measured 15 ms to 1.4 s depending on the decrypt. The check therefore ARMS the composer, waits
for the app's own log to show a new window opening, and fires into it - and then proves after the
fact which sends were inside one.

**The discriminator is exact, not statistical.** `[ADD_MSG] ✓ Message added` is logged by
`addMessageToChat` alone; inside a window an inbound message returns early into the buffer without
logging it, and the flush that later renders it goes through `batchAddMessages`, which never logs
that line at all. So an `[ADD_MSG] ✓ Message added` inside a window is necessarily a message that
took the live path while `bulkIngestActive` was true - i.e. an own message through the branch this
fix added.

| own message | added at | window | verdict |
| --- | --- | --- | --- |
| `80e9927e` | 11:28:39.582 | opened 39.193, closed 39.601 (408 ms) | inside |
| `050725aa` | 11:28:43.654 | opened 43.397, closed 44.790 (1393 ms) | inside |
| `1537acbd` | 11:28:53.383 | opened 53.283, closed 53.612 (329 ms) | inside |
| `bcba272f` | 11:28:59.295 | opened 58.874, closed 59.323 (449 ms) | inside |
| `dde24b01` | 11:29:21.429 | opened 20.999, closed 21.464 (465 ms) | inside |
| 6 others | - | between windows | outside |

11 sent, 25 windows opened over the run, **5 inside**, and after the reload and a quiescence gate
(no `Drain start` for 20 s) **11 of 11 still present**. PASS.

The run also surfaced a harness artifact worth keeping in mind for any marker count: one attempt
failed to submit and left its text in the box, the next `Input.insertText` appended to it, and the
app faithfully delivered ONE message carrying TWO markers - twelve markers on screen for eleven
sends. The app was right and the count was wrong; the harness now clears the composer before arming.

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
requester lacks, and sends `history_pull {to, ids|prefixes+depth}` for what IT lacks. A pull is answered by a
bundle and a bundle asks for nothing, so the exchange cannot re-enter itself - the WP-RETRANSMIT-1
lesson, applied by construction.

**The rendezvous.** The two halves travel by different transports and nothing orders them: the
elected responder can be handed the WS request before or after the digest reaches its inbound MLS
queue. So it waits `HISTORY_DIGEST_GRACE_MS` (3 s) for the digest, then falls back to
`sendFullHistoryBundle`. A stored digest is CONSUMED on take - a later request must diff against a
fresh snapshot, never a minute-old claim (TTL 60 s).

**Two digest modes, by size.** `ids` (the sorted id list) below `DIGEST_ID_MODE_MAX` (1000), `range`
above it: the id space is cut into `16^depth` slices and each carries a count plus a truncated
SHA-256 of its sorted ids.

**The unit is a slice of the ID SPACE, and it used to be a MONTH - that change (2026-08-10) is the
one thing to understand here.** A month is cut from a message's stored TIMESTAMP, and the two devices
do not agree on it: the sender's clock against the server's puts a message either side of midnight
UTC, so on one device it is in July and on the other in August. Both months then read as different,
both are re-sent wholesale - and they do so again at the next exchange, forever, because nothing the
exchange does can make the two timestamps agree. The diff therefore never empties, and the empty diff
is the only thing entitled to clear the durable awaiting-history marker. At a few hundred messages
that is waste; at scale it is a permanent broadcast that never terminates, which is the same class of
defect as WP-RETRANSMIT-1. A message id is the same string on every device by construction, so a
slice of the id space holds the same members on both sides and an exchange that equalises it keeps it
equal. `historyManifest.test.ts` pins this directly: the same store with wildly skewed timestamps
produces a byte-identical digest.

Four details are the whole correctness of it:

- **The partition hash and the content hash are different functions on purpose.** `historyRangeOf`
  is FNV-1a plus a MurmurHash3 finaliser, synchronous, and decides only WHICH SLICE an id is
  compared in - a collision or an uneven spread there costs a fatter slice, i.e. bandwidth, never a
  message. `hashIdList` fingerprints a slice's CONTENTS and is SHA-256 truncated to 64 bits, because
  a collision there declares a slice identical that is not and loses the messages in it silently and
  permanently. The finaliser is not decoration: without it, 64 ids differing only in a trailing
  counter landed in 5 of the 16 depth-1 slices.
- **The DEPTH travels on the wire and the reader re-slices at the SENDER's depth.** Depth is derived
  from a store's size (`rangeDepthFor`, targeting ~64 messages a slice, capped at 3), the two stores
  have different sizes, so a reader using its own depth would compare different regions of the id
  space and everything would disagree. The `history_pull` carries it for the same reason.
- **Ids sort by CODEPOINT, never `localeCompare`.** The sort feeds the hash, so a locale-dependent
  comparator makes every slice disagree between two devices. The sort is part of the protocol.
- **A differing slice is requested in BOTH directions.** A fingerprint proves the slice is not
  identical, never which side is short; guessing drops messages, over-asking costs bandwidth and the
  receiver already dedupes by id.

**What the cap buys, and what it costs.** `MAX_RANGE_DEPTH = 3` bounds the digest at 4 096 slices
(~180 KB for a million messages, ~14 KB for five thousand). Past the cap slices get fatter rather
than the exchange gaining a round trip: still exactly one, still terminating, just more over-sent per
difference. That is deliberate - a recursive refinement would be smaller on the wire and would put
multi-round-trip state back into the one mechanism this whole area was just simplified down to.

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
Co-members learn which ids this device kept, hashed per slice in range mode. Accepted.

**Two traps, both now handled.** Every leg is a GROUP broadcast, so the pull carries its target
(`digestIdentity(userId, deviceId)` - the DEVICE, so a user's other two devices do not answer a pull
addressed to the first) and non-targets ignore it. And the REPLAY path (`historySystemEvents.ts`)
ignores `history_digest` / `history_pull` through an explicit `REPLAY_IGNORED_EVENTS` set - transient
negotiation, meaningless when re-read days later, and naming them means adding a branch later has to
be a decision rather than an accident.

#### The bundle is INGESTED by everyone and ANSWERS one device

The third leg is a broadcast too, and it was the one that lost messages. `history_bundle` carries a
`to` (the requester's `digestIdentity`, set by `bundleFrame` on every send path - full store, id
diff, and both flavours of empty bundle), and the receiver splits what it does with it in two:

- **the messages are taken by every member** - the merge dedupes by id, so over-delivery costs
  bandwidth and nothing else;
- **the ANSWER is read only by the addressee** - `noteHistoryBundleReceived` discharges the durable
  awaiting-history marker, and a device that never asked has had nothing compared against its store.

Before this, one repair between two peers cleared the marker of every other member of the
conversation. That is not a delay, it is a permanent loss: the marker is the evidence, so once it is
gone no reconnect, no sweep and no election ever asks again, and whatever was missing on those
devices stays missing. The empty bundle is the worst case of all - it carries no messages at all and
exists purely to say "you are complete".

A bundle with **no `to`** predates the field, and is answered the legacy way: only while this
device's own solicitation is outstanding (`isSolicitInFlight`). The ambiguity therefore resolves
towards a marker that stays up - one extra diff on the next edge, which is free when there is no
difference - rather than towards one wrongly cleared.

**Why not address the frame itself.** The obvious fix is the `recipients` field of `POST /send`.
Do not: MLS re-encrypts per recipient set, and narrowing it on an application message burns the
sender ratchet budget (`sender_ratchet_config()` is `(2000, 2000)`) into a generation gap the other
members cannot close - `forgetGroup` and a re-Welcome. `to` is addressing, not secrecy, and must
never be read as the latter.

The responder half is symmetric: `history_pull` is answered with a bundle addressed back at the
puller, whose claimed `from` is cross-checked against the authenticated MLS sender exactly as
`history_digest` is. An unusable `from` is dropped rather than answered to nobody.

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
4. **SUPERSEDED 2026-08-10** - the give-up counter and the ring it arbitrated are deleted outright,
   along with the narrow rung they existed to govern. See the section below: there is one repair now.
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

So a bundle does not end a wait by existing. An empty **vouched** bundle does, whatever the evidence
was: it is the authoritative "you are missing nothing", sent by a responder that compared its whole
store and was not itself awaiting history. A NON-EMPTY bundle carries messages and
nothing more: it voids a presumption, and against a proof it leaves the marker standing, so the next
edge asks for what is still missing. That is what makes
the marker empty ITSELF: each exchange strictly reduces the difference, so it converges on the empty
bundle rather than on a bundle count. It also fixes a defect that predates the diff - a history big
enough to be chunked arrives as several non-empty bundles, and the first of them used to end the
solicitation.

`REASON_RANK` is what keeps a proof from being overwritten by a presumption, in both directions: on
write (`markAwaitingHistory` keeps the higher rank) and on clear (`isProvenAwaitingReason`).

#### Two waiting peers were a fixed point the convergence argument did not cover (WP-HISTBANNER-1, FIXED 2026-08-11)

The convergence above is an argument about the DATA, and it quietly assumes some peer is entitled to
vouch. A responder that is itself awaiting is correctly forbidden from claiming completeness - but
that was implemented as SILENCE, and silence is not an answer. Once both peers carried a marker and
their stores were equal, `idsToSend` was 0 on both sides, both stayed silent, and neither marker
could ever clear. Seen live on both browsers over a conversation that had healed 14/14 the same
evening: a permanent "historique en attente" over a complete conversation, which is the worst kind of
notice because it teaches the user to ignore every future one.

The fix is to separate what a responder MEASURED from what it is entitled to CLAIM, which a boolean
could not express - hence `EmptyBundleMeaning` (`groupActions.ts`) with three values, one per call
site: `complete` (whole store compared, not awaiting, may vouch), `identical` (whole store compared,
awaiting, may state only that the two stores match) and `silence` (a pull asked about a SUBSET, or
the local read failed - nothing about the peer was measured). Only `identical` puts anything new on
the wire, `{ messages: [], vouched: false }`; an ABSENT `vouched` means vouched, which is exactly
what every client shipped before the field assumed, so an old responder stays correctly read by a
new requester.

What the requester does with it is the subtle half, and the two proofs must NOT be swept together:

- `peer-holds-more` is **discharged**. Its evidence was "this peer listed ids I lack", and an empty
  symmetric difference with that same peer falsifies it outright - whether the peer is itself
  awaiting is irrelevant, because the claim is about OUR store, not its.
- `unreadable-frames` and `no-local-history` **survive**. A frame both devices lack is still lost,
  and only a third device can produce it. Discharging them here would convert "nobody present has
  it" into "you are complete" and stop the group ever asking the one device that might still hold it.

The banner comes down in every case, because an answer arrived - and that, not the marker, was the
visible symptom. Pinned by `historySolicit.test.ts` (the discharge table) and
`actions.historyRequest.test.ts` (the responder now answers `identical` instead of staying silent);
both were validated as negative controls against the unfixed code first.

**Two claims made about this defect were wrong and are recorded because the error is instructive.**
The banner was said to latch "for the life of the tab": it does not, because the 15-minute
`AWAITING_SWEEP_INTERVAL_MS` sweep re-solicits on a visible tab and refreshes the phase, bounding the
stale window. And "Nouvelle tentative automatique" was called a lie left over from the deleted retry
ladder: deleting the LADDER did not delete the SWEEP, and the string was accurate throughout. **A
claim that a user-facing string is stale must name the mechanism that would honour it and show that
mechanism gone** - one grep for the sweep constant would have refuted both before they were written.

### There is ONE repair, and deleting the other one is what fixed the escalation (2026-08-10)

For a while there were two, with a ladder between them: a narrow `decrypt_failed` asking peers to
re-send the last two minutes out of an in-memory ring, and the diff. Every question about the ladder -
how often may the narrow rung fire, when does it give up, when do we escalate - was answered with a
duration, and there were nine of them across three files. That is the shape to recognise: **a
mechanism whose semantics are decided by clocks cannot be reasoned about, only tuned.**

The ladder is gone because the narrow rung is. Three properties of it, each sufficient on its own:

- It could not NAME what it wanted. The frame never decrypted, so its id was never seen, so the
  request could only be a period of time - and a request addressed by time is a broadcast.
- Its single trigger is a sender whose ratchet went backwards, so it asks precisely the peer that
  cannot answer: the re-encryption happens at the same rewound ratchet and collides identically.
- Therefore its only mode of success was the sender burning past our high-water mark while answering.
  That is recovery by exhaustion, and it is indistinguishable from repair in a log.

Measured twice on the browser: it fired with 1, then 5, 15 and 25 payloads and delivered none, while
the diff repaired the conversation completely (`32 to send, 1 to pull`). Measured on production
2026-08-10: ~450 frames/min across three devices for over ten minutes, nothing repaired. The
`decrypt_failed` branch survives only to IGNORE the event from a peer running an older build.

What replaces the ladder is not a better ladder. A detected loss marks `unreadable-frames` durably and
solicits the diff, with nothing rate-limiting it. Termination is a property rather than a budget:
each exchange strictly reduces the difference between the two stores, so the sequence converges on
the empty diff, which is the only thing entitled to clear the marker.

#### The idempotence was briefly asked of the wrong witness (FIXED 2026-08-10)

The first cut of the above read "solicit **unless this group is already being reconciled**", and
implemented "already being reconciled" as `if (isAwaitingHistory(userId, groupId)) return`. The
reasoning - the durable marker IS the idempotence, so nothing needs rate-limiting - is right about
the marker and wrong about the question.

**The marker answers "is this group short of history". It was asked "have I already asked".** Those
differ in exactly the way that matters here: the marker is DURABLE, survives sessions, and is cleared
only by an empty diff, while an attempt lasts 30 s. So on any group that had ever been broken the
marker was already standing when the next frame was lost, and this trigger - the only one that fires
on the loss itself - returned silently. What was left was the 15-minute sweep, i.e. the floor
pretending to be the mechanism.

Measured on prod 2026-08-10 with `heal-web.mjs`: twelve `LOST frame` lines on the receiver, **zero**
solicitations in 139 lines of log, `escalated=false, history diff ran=false`, `PARTIAL - 2/14`, and a
standing "history pending" banner with no attempt behind it.

`isSolicitInFlight` in `historySolicit.ts` is the right witness and already existed - `scheduled.has(groupId) ||
phase === 'pending'`, i.e. an attempt is scheduled or inside its response window - so the fix is a
deletion, not an addition. Pinned by `setupMessageHandler.lostFrame.test.ts`, whose negative control
against the guard is `Number of calls: 0`.

Same class as WP-GHOST-1's `updatedAt` and as an epoch verdict answering a generation question: **a
piece of durable state is evidence only for the question it was written to answer.** The general form
is in CLAUDE.md's DURABLE RULES; what this instance adds is that the two questions can differ only in
their LIFETIME and still make the substitution wrong.

One duration remains in the whole mechanism, the response window in `historyRequestPending.svelte.ts`.
Its only job is to decide that an attempt went unanswered, which nothing else can observe, and it
schedules no traffic. Re-asking rides on state EDGES instead: a reconnect, a peer coming back online,
a newly detected loss, and a slow sweep as the floor under them.

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
| a frame proved lost | `setupMessageHandler.ts` -> `solicitHistory` |
| every (re)connect | `initializeConnection.ts` -> `reSolicitAwaitingHistory` |
| a peer going offline -> online | `onPeersCameOnline` |
| a fresh join with no local history | `solicitHistoryIfMissing` |
| a slow sweep while the session is open | `startAwaitingHistorySweep`, 15 min |

Every row is an EDGE. There is no backoff ladder anywhere in this list: one edge produces one
request, and a second edge while that request is outstanding produces nothing. The sweep is the floor,
because every other row is an event a long-lived session is not guaranteed to see again - presence is
only polled for users the UI actually DISPLAYS (`ConversationTile`, `ChatHeader`,
`ChannelMembersSidebar`), so it covers DMs while the list is on screen and a channel only when its
member panel is open. It pauses while the document is hidden, which also makes returning to the
foreground fire it at once.

**Two defects here, and the second is why the first kept happening.** In 2026-08-07 `pending` was read
with `pending.has(groupId)` and nothing removed an entry when a burst ended unanswered, so a group
whose peers were all offline during its burst was skipped by every later trigger for the life of the
tab - the situation the retries exist for was the one that disabled them. It was patched by computing
the end of the burst up front. The real fault was underneath: **"is an attempt outstanding" was being
derived by comparing clocks, when it is a STATE that an event ends.** There is no burst now, so there
is no schedule to reason about: `isSolicitInFlight` reads the response window, which the answer, the
timeout or a teardown closes. A stale entry cannot outlive the thing it describes.

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
carries the sorted ids below 1000 messages, and above that one line per slice of the id space with a
count AND a truncated SHA-256 of that slice's ids. The hash is exactly what catches "same count,
different messages", and `historyManifest.test.ts` pins that case.

## The render window is a pointer into an array the component does not own (WP-EMPTYVIEW-1)

`ChatArea` never renders a whole conversation. It renders a WINDOW - `messageGroups.slice(start,
end)` - because a thousand bubbles in one synchronous pass delays layout and the entry scroll then
overshoots. `windowStart` is component STATE: it moves when the reader paginates upwards, and it is
recomputed from the list length in exactly one place, the effect that fires when the conversation
KEY changes (`ChatArea.svelte`, `hasConversationChanged`).

The list it points into belongs to somebody else, and that somebody REPLACES it rather than
appending to it. `loadHistoryForConversation` ends by setting `conversation.messages` to
`getMessagesPage(id, key, INITIAL_MESSAGES_PAGE)` - 60 messages - on both its fast path (the
`limit=1` cursor probe finding nothing new) and its full path. It runs on every conversation click
and from `ChatBackgroundService` on reconnect and on history events.

So the two combine into a conversation that renders NOTHING:

| step | in-memory messages | groups | `windowStart` | rendered |
| --- | --- | --- | --- | --- |
| a bulk ingest / history bundle has grown the open list | 598 | ~300 | - | - |
| the conversation is clicked: the key changes | 598 | ~300 | `300 - 60 = 240` | 60 groups |
| `loadHistoryForConversation` replaces the list with one page | 60 | ~65 | still 240 | `slice(240, 65)` = **none** |

`slice` with a start past its end returns `[]` without complaining. There is no error, no log, and no
skeleton - `showSkeleton` requires `isLoadingHistory`, which is false by then - and no empty state,
because `ChatMessageGroups` renders an empty list as nothing. The user sees the header, the avatar,
the composer, and a void. Observed on production 2026-08-11 with 598 messages in the local store and
zero on screen, surviving a full reload.

Two facts make the diagnosis a proof rather than a story, and both are cheap to re-check:

- the SIDEBAR renders `convo.messages[convo.messages.length - 1].content` as its preview, so a tile
  showing a preview proves the map entry the pane reads is NOT empty;
- `groupMessages` only ever pushes - a non-empty list cannot produce empty groups - and
  `hideDuringEntry` is `opacity-0`, which `innerText` still reports. So a pane whose `innerText` is
  the header and the composer alone had no message nodes in the DOM at all, which leaves the slice
  as the only reduction that could have removed them.

The fix does not make `windowStart` correct; it makes the READ side stop trusting it.
`utils/chat/renderWindow.ts` clamps the stored index against the CURRENT group count on every
render, and every consumer - the slice, the hidden-above count, `loadOlderGroups`,
`fillViewportThenPin`, `navigateToMessage` - reads the clamped value while pagination keeps writing
the raw state. The invariant it guarantees is the one worth remembering: **a non-empty list always
yields a non-empty window.** `renderWindow.test.ts` pins it across every combination of stored index
and list length, which is the assertion that fails against the old arithmetic.

Still true and deliberately NOT changed here: that refresh DISCARDS older messages the reader had
paginated in, because it replaces the list with one page instead of merging. That costs scroll
position and a re-fetch, and it is now merely annoying rather than invisible - but it is the reason
the window and the list can disagree at all.

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
