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

Three entry points publish a channel target and navigate: the invite card's Join button, an
accepted invite link, and a tapped channel notification. All three go through `notifNav` +
`openInvitedChannel`, and all three have to survive the same hazard.

`/chat` and `/communities` are **separate route components**, each rendering its own
`MainChatPage`, so moving between them remounts it. Its route-mode switch clears the selection so
the previous tab's thread does not leak across - but a deep link publishes its selection *before*
navigating, so an unconditional reset wipes precisely what the link asked for, and the arrival
shows an empty `/communities`. `selectionBelongsToRoute` is the discriminator: a selection whose
`chatDeepLinkRoute` already matches the incoming mode can only have come from a deep link, since a
genuine tab switch carries one made under the mode being left. Pinned by
`notificationRouting.test.ts`.

The invite link resolves its landing channel from `getWorkspaceBySlug`, which returns only channels
the caller may read; it prefers a **public** one, so a fresh joiner lands in the open room rather
than in whichever private channel happened to sort first.

The inviter's copy is inserted **locally** by `inviteMemberToChannel`, because MLS never hands a
device back its own application message. The `senderNorm === userId` branch of
`systemMessageHandler` builds the identical envelope, and only ever runs on the inviter's *other*
devices. Pinned by `systemMessageHandler.channelInvite.test.ts`.

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
| `/chat/[groupId]` | Open a specific conversation directly |
| `/c/[groupId]` | Short link alias for direct links |
| `/g/[groupId]` | Group short link |
