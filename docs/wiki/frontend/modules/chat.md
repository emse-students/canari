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
