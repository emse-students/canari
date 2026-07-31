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

`appMsgToEnvelope()` in `proto/codec.ts` is the canonical decoder (protobuf AppMessage -> MessageEnvelope).

### Channel invitation card

Inviting someone to a community sends a `channel_invitation` system event into the 1:1 MLS DM, and
BOTH sides render the same `channelInvite` card in that conversation:

| Side | Envelope built by | Copy | Join button |
|---|---|---|---|
| Invitee | `mkChannelInviteEnvelope` | "{inviter} vous a invité..." | yes |
| Inviter | `mkChannelInviteSentEnvelope` | "Vous avez invité {member}..." | no |

`channelInvite.invitedName` is the discriminator: **present = the inviter's copy**, and its presence
is what suppresses the Join button. Never set it on the invitee's copy.

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
  selection, then stays idle once the target is on screen (`selectedContact === id` and the map has
  it) - otherwise a plain incoming message would re-select it and refetch its history.
- The watchdog keeps a selection whose key equals `notifNav.pending`: absent from the map means
  "not there *yet*" while a landing is in progress.
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

The at-rest projection of a message is shared by both storage backends
(`db/messagePayload.ts`): a field that is not in `toMessagePayload`/`fromMessagePayload` does not
survive a reload, whichever backend is in use. `editedAt` was missing from both for exactly as long
as it existed on the in-memory type.

### Forwarding

`forwardMessage` crosses freely between the two worlds: a channel message can be forwarded into a
DM and a DM message into a channel. Only the transport differs (MLS group vs channel epoch key);
a media forward re-sends the same envelope in both cases, so no blob is re-uploaded and the CEK
travels with it.

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
