/**
 * Reactive composable owning all message-level operations:
 * - Incoming message append + unread tracking
 * - Text send, media upload, reactions, edit, delete
 * - Read receipts (debounced)
 * - Reply/cancel-reply state
 * - File selection + validation
 */
import { tick } from 'svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { SvelteMap, SvelteDate, SvelteSet } from 'svelte/reactivity';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import { getToken } from '$lib/stores/auth';
import { fromHex } from '$lib/utils/hex';
import {
  sendChatMessage,
  addReaction,
  removeReaction,
  editMessage,
  deleteMessage,
  setMessagePinned,
} from '$lib/utils/chat/messaging';
import { applyPin, isMessagePinned } from '$lib/stores/pinStore.svelte';
import {
  isStaleInboundMessage,
  normalizeMessageId,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import {
  insertMessageOrdered,
  mergeMessagesInInputOrder,
  messageTime,
} from '$lib/utils/chat/messageOrder';
import { isOwnMessage } from '$lib/utils/chat/messageUtils';
import {
  MAX_DISTINCT_MESSAGE_REACTIONS,
  toggleMessageReaction,
} from '$lib/utils/chat/messageReactions';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import { MediaService } from '$lib/media';
import { getPreviewText, mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import { encodeAppMessage, mkMedia, MediaKind } from '$lib/proto/codec';
import type {
  AddMessageToChatOptions,
  ChatMessage,
  MessageReaction,
  Conversation,
} from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { BulkIngestPhase } from '$lib/mls-client';
import type { IStorage, OutboxEntry, StoredMessage } from '$lib/db';
import { enqueueOutboxMessage } from '$lib/utils/chat/outbox';
import { ChannelService } from '$lib/services/ChannelService';
import {
  isChannelConversationId,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { beginBulkUiFlushBench, finishBulkUiFlushBench } from '$lib/mls-client/catchupBenchmark';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';
import { publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';

/** Runtime dependencies injected into all messaging operations. */
export interface MessagingContext {
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  /** Reactive map of all open conversations (DMs + channels). */
  conversations: SvelteMap<string, Conversation>;
  userId: string;
  pin: string;
  authToken: string;
  setAuthToken: (v: string) => void;
  selectedContact: string | null;
  getSendError: () => string;
  setSendError: (v: string) => void;
  getChatContainer: () => HTMLElement | undefined;
  storage: IStorage | null;
  log: (msg: string) => void;
  saveConversation: (contactName: string) => Promise<void>;
  verifyCurrentUserMembership: (contactName: string) => Promise<boolean>;
  playNotificationTone: () => void;
  playSendTone?: () => void;
  playReceiveTone?: () => void;
  playReadTone?: () => void;
  sendSystemNotification: (title: string, body: string, conversationId?: string) => Promise<void>;
}

/** Creates and returns the reactive messaging store covering send, receive, reactions, edit, delete, replies, and media uploads. */
export function useMessaging() {
  const messageReactions = new SvelteMap<string, MessageReaction[]>();
  let replyingTo = $state<ChatMessage | null>(null);
  let pendingMediaFiles = $state<import('$lib/media').PendingMediaFile[]>([]);
  let isUploadingMedia = $state(false);

  /** Depth of nested MLS queue catch-up sessions (overlay stays until zero). */
  let messageCatchupDepth = 0;
  let isMessageCatchupActive = $state(false);
  /** When true, incoming messages are buffered and flushed in one UI update (MLS queue catch-up). */
  let bulkIngestActive = false;
  /** Global MLS catch-up sequence (reset when bulk buffer starts). */
  let bulkIngestSeq = 0;
  const bulkIngestBuffer = new SvelteMap<
    string,
    Array<{ senderId: string; content: string } & AddMessageToChatOptions>
  >();

  const mediaService = new MediaService();
  const mediaMaxSizeMb = Number.parseInt(import.meta.env.VITE_MEDIA_MAX_SIZE_MB ?? '100', 10);
  const mediaMaxSizeBytes = mediaMaxSizeMb * 1024 * 1024;

  // ── Incoming message ──────────────────────────────────────────────────────

  /**
   * Opens a UI catch-up window for a bulk-ingest phase: buffers incoming messages for one grouped
   * flush per conversation (`bufferUi`) and/or shows the blocking sync overlay (`showOverlay`).
   */
  function beginBulkMessageIngest(phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    if (showOverlay) {
      messageCatchupDepth += 1;
      isMessageCatchupActive = true;
    }
    if (bufferUi) {
      bulkIngestActive = true;
      bulkIngestSeq = 0;
      bulkIngestBuffer.clear();
    }
  }

  /** Clears catch-up UI state (safety net if begin/end ever desync). */
  function resetMessageCatchupState() {
    messageCatchupDepth = 0;
    isMessageCatchupActive = false;
    bulkIngestActive = false;
    bulkIngestBuffer.clear();
  }

  /** Ends catch-up: flushes bulk buffer when used, then hides the loading overlay. */
  async function endBulkMessageIngest(ctx: MessagingContext, phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    try {
      if (bufferUi && bulkIngestActive) {
        // Disable buffering BEFORE the await loop: any message that arrives during the flush
        // (e.g. a channel event calling addMessageToChat outside the drain queue) then takes
        // the live path and renders immediately, instead of landing in a buffer the finally
        // block is about to discard - which would silently drop it.
        bulkIngestActive = false;
        const entries = [...bulkIngestBuffer.entries()].sort(([, a], [, b]) => {
          const seqA = a[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          const seqB = b[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          return seqA - seqB;
        });
        const benchMessageCount = entries.reduce((sum, [, msgs]) => sum + msgs.length, 0);
        beginBulkUiFlushBench(entries.length, benchMessageCount);
        bulkIngestBuffer.clear();
        for (const [contactName, messages] of entries) {
          if (messages.length > 0) {
            await batchAddMessages(messages, contactName, ctx);
            await yieldToMainThread();
          }
        }
        finishBulkUiFlushBench();
        tick().then(() => {
          const chatContainer = ctx.getChatContainer();
          if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
        });
      }
    } catch (e) {
      console.error('[CATCHUP] endBulkMessageIngest failed:', e);
    } finally {
      if (bufferUi) {
        bulkIngestActive = false;
        bulkIngestBuffer.clear();
      }
      if (showOverlay) {
        messageCatchupDepth = Math.max(0, messageCatchupDepth - 1);
        if (messageCatchupDepth === 0) {
          isMessageCatchupActive = false;
        }
      }
    }
  }

  /**
   * Appends a single message to the conversation, updates `lastMessageAt`, persists to
   * IndexedDB, and scrolls to bottom. Deduplicates by id. No-op if the conversation is
   * not in the map.
   */
  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    ctx: MessagingContext,
    options: AddMessageToChatOptions & { skipDbSave?: boolean } = {}
  ) {
    const normalized = contactName.toLowerCase();

    if (bulkIngestActive) {
      const convo = ctx.conversations.get(normalized);
      if (!convo) {
        console.warn(`[ADD_MSG] conversation "${normalized}" introuvable (bulk)…`);
        return;
      }
      const id = normalizeMessageId(options.messageId) ?? crypto.randomUUID();
      const existing = bulkIngestBuffer.get(normalized) ?? [];
      if (existing.some((m) => m.messageId === id) || convo.messages.some((m) => m.id === id)) {
        return;
      }
      existing.push({
        senderId,
        content,
        ...options,
        messageId: id,
        ingestSequence: options.ingestSequence ?? bulkIngestSeq++,
      });
      bulkIngestBuffer.set(normalized, existing);
      return;
    }

    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      console.warn(`[ADD_MSG] conversation "${normalized}" introuvable…`);
      return;
    }

    const isOwn = isOwnMessage(senderId, ctx.userId);
    const resolvedTimestamp = resolveMessageTimestamp(options, convo.messages, isOwn);
    const newMsg: ChatMessage = {
      id: normalizeMessageId(options.messageId) ?? crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: new SvelteDate(resolvedTimestamp),
      isOwn,
      replyTo: options.replyTo,
      isSystem: options.isSystem ?? false,
      status: options.status,
      isFcmPreview: options.isFcmPreview,
      serverTimestamp: options.serverTimestamp,
    };

    const dupIdx = convo.messages.findIndex((m) => m.id === newMsg.id);
    if (dupIdx !== -1) {
      const existing = convo.messages[dupIdx];
      if (shouldUpgradeMessage(existing, content)) {
        const upgraded = mergeMessageUpgrade(existing, newMsg);
        const nextMessages = insertMessageOrdered(
          convo.messages.filter((m) => m.id !== newMsg.id),
          upgraded
        );
        ctx.conversations.set(normalized, {
          ...convo,
          messages: nextMessages,
          lastMessageAt: Math.max(convo.lastMessageAt ?? 0, upgraded.timestamp.getTime()),
        });
        if (ctx.storage && !(options.skipDbSave ?? isChannelConversationId(normalized))) {
          try {
            await ctx.storage.saveMessage(
              {
                id: upgraded.id,
                conversationId: normalized,
                senderId: upgraded.senderId,
                content: upgraded.content,
                timestamp: upgraded.timestamp.getTime(),
                serverTimestamp: upgraded.serverTimestamp,
                isFcmPreview: false,
              },
              ctx.pin
            );
          } catch (e) {
            console.error('[DB] Failed to upgrade message:', e);
          }
        }
        const updatedConvo = ctx.conversations.get(normalized);
        if (updatedConvo) {
          publishTabMessageUpdate({
            type: 'message_added',
            conversationId: normalized,
            message: upgraded,
            lastMessageAt: updatedConvo.lastMessageAt ?? upgraded.timestamp.getTime(),
            unreadCount: updatedConvo.unreadCount ?? 0,
          });
        }
        console.log(`[ADD_MSG] ✓ Message upgraded: id=${newMsg.id}…`);
        return;
      }
      console.log(`[ADD_MSG] Duplicate ignored id=${newMsg.id}…`);
      return;
    }

    const isConversationOpen = ctx.selectedContact === normalized;
    const shouldMarkUnread = !isOwn && !isConversationOpen;
    const nextUnreadCount = shouldMarkUnread
      ? (convo.unreadCount ?? 0) + 1
      : isConversationOpen
        ? 0
        : (convo.unreadCount ?? 0);

    ctx.conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: insertMessageOrdered(convo.messages, newMsg),
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
    });
    console.log(`[ADD_MSG] ✓ Message added: id=${newMsg.id}…`);

    publishTabMessageUpdate({
      type: 'message_added',
      conversationId: normalized,
      message: newMsg,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
      unreadCount: nextUnreadCount,
    });

    if (!isOwn && !options.isSystem && !isStaleInboundMessage(resolvedTimestamp)) {
      (ctx.playReceiveTone ?? ctx.playNotificationTone)();
    }

    const isAndroidTauri = isTauriRuntime() && /android/i.test(navigator.userAgent);

    const shouldSendSystemNotification =
      !isOwn &&
      !options.isSystem &&
      !isAndroidTauri &&
      typeof document !== 'undefined' &&
      (document.visibilityState !== 'visible' || !document.hasFocus());

    if (shouldSendSystemNotification) {
      const preview = getPreviewText(parseEnvelope(content));
      const title = getUserDisplayNameSync(senderId, convo.name);
      void ctx.sendSystemNotification(title, preview || 'Nouveau message', normalized);
    }

    const skipDbSave = options.skipDbSave ?? isChannelConversationId(normalized);
    if (ctx.storage && !skipDbSave) {
      try {
        await ctx.storage.saveMessage(
          {
            id: newMsg.id,
            conversationId: normalized,
            senderId: newMsg.senderId,
            content,
            timestamp: newMsg.timestamp.getTime(),
            serverTimestamp: options.serverTimestamp,
            ...(options.isFcmPreview ? { isFcmPreview: true } : {}),
            ...(options.isSystem ? { readBy: [] } : {}),
          },
          ctx.pin
        );
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] Failed to persist message:', e);
      }
    }

    tick().then(() => {
      const chatContainer = ctx.getChatContainer();
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  /**
   * Appends multiple messages in a single reactive update and one batch IndexedDB write.
   * Used by history replay and bulk catch-up to avoid O(n) individual updates that would
   * cause UI jank. Updates `lastMessageAt` to the max timestamp in the batch.
   */
  async function batchAddMessages(
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string,
    ctx: MessagingContext
  ) {
    if (messages.length === 0) return;
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) return;

    const existingIds = new SvelteSet(convo.messages.map((m) => m.id));
    const toStore: StoredMessage[] = [];
    const upgradedById = new SvelteMap<string, ChatMessage>();
    const brandNew: ChatMessage[] = [];

    let processedCount = 0;
    for (const pm of messages) {
      // Yield to the main thread every 50 messages to avoid UI freeze during large catch-ups.
      processedCount++;
      if (processedCount % 50 === 0) await yieldToMainThread();

      const id = normalizeMessageId(pm.messageId) ?? crypto.randomUUID();
      const existingMsg = convo.messages.find((m) => m.id === id);
      if (existingMsg && shouldUpgradeMessage(existingMsg, pm.content)) {
        const upgraded = mergeMessageUpgrade(existingMsg, {
          content: pm.content,
          replyTo: pm.replyTo,
          isSystem: pm.isSystem,
          serverTimestamp: pm.serverTimestamp,
        });
        upgradedById.set(id, upgraded);
        if (ctx.storage) {
          toStore.push({
            id,
            conversationId: normalized,
            senderId: upgraded.senderId,
            content: pm.content,
            timestamp: upgraded.timestamp.getTime(),
            serverTimestamp: pm.serverTimestamp,
            isFcmPreview: false,
          });
        }
        continue;
      }
      if (existingIds.has(id)) continue;
      existingIds.add(id);

      const isOwn = isOwnMessage(pm.senderId, ctx.userId);
      const resolvedTimestamp = resolveMessageTimestamp(pm, convo.messages, isOwn);
      const newMsg: ChatMessage = {
        id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: new SvelteDate(resolvedTimestamp),
        isOwn,
        replyTo: pm.replyTo,
        isSystem: pm.isSystem,
        ingestSequence: pm.ingestSequence,
      };
      brandNew.push(newMsg);

      if (ctx.storage) {
        toStore.push({
          id,
          conversationId: normalized,
          senderId: newMsg.senderId,
          content: pm.content,
          timestamp: (newMsg.timestamp instanceof Date
            ? newMsg.timestamp
            : new SvelteDate(newMsg.timestamp)
          ).getTime(),
          serverTimestamp: pm.serverTimestamp,
          ...(pm.isSystem ? { readBy: [] } : {}),
        });
      }
    }

    if (upgradedById.size === 0 && brandNew.length === 0) return;

    const isConversationOpen = ctx.selectedContact === normalized;
    const addedFromOthers = brandNew.filter((m) => !m.isOwn && !m.isSystem).length;
    const nextUnreadCount = isConversationOpen ? 0 : (convo.unreadCount ?? 0) + addedFromOthers;

    const withUpgrades = convo.messages.map((m) => upgradedById.get(m.id) ?? m);
    const merged = mergeMessagesInInputOrder(withUpgrades, brandNew);
    const batchMaxTs = merged.reduce((max, m) => Math.max(max, messageTime(m)), 0);

    ctx.conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: merged,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, batchMaxTs),
    });

    publishTabMessageUpdate({
      type: 'messages_batch',
      conversationId: normalized,
      messages: brandNew,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, batchMaxTs),
      unreadCount: nextUnreadCount,
    });

    // Single batch DB write (community channels are server-authoritative)
    if (ctx.storage && toStore.length > 0 && !isChannelConversationId(normalized)) {
      try {
        await ctx.storage.saveMessages(toStore, ctx.pin);
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] batchAddMessages failed:', e);
      }
    }

    tick().then(() => {
      const chatContainer = ctx.getChatContainer();
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /** Main send handler: verifies MLS membership, uploads any pending media files (with client-side AES-GCM encryption), then sends a text message. Handles channel (REST) and DM/group (MLS) paths. */
  async function handleSendChat(ctx: MessagingContext, messageText: string) {
    const text = messageText.trim();
    const filesToSend = [...pendingMediaFiles];
    const fileEntries = filesToSend;
    const mediaCaption = text || undefined;
    let sentMediaMessageCount = 0;

    ctx.log(
      `[SEND] handleSendChat: contact="${ctx.selectedContact}" text="${text.slice(0, 40)}" files=${filesToSend.length}`
    );

    if (!text && filesToSend.length === 0) {
      ctx.log('[SEND] Abort: pas de texte ni de fichier');
      return;
    }
    if (!ctx.selectedContact) {
      ctx.log('[SEND] Abort: no contact selected.');
      return;
    }
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) {
      ctx.log(`[SEND] Abort: no conversation found for "${ctx.selectedContact}".`);
      return;
    }

    const isChannel = isChannelConversationId(ctx.selectedContact);
    ctx.log(
      `[SEND] convo: groupId="${convo.id}" lifecycle=${convo.lifecycle} isChannel=${isChannel}`
    );

    // Media (inline upload+send) still requires a ready MLS group; queuing media is a later
    // increment. Text/reply are captured into the outbox and never blocked here - they flush
    // automatically once the group becomes sendable.
    if (filesToSend.length > 0 && !isChannel) {
      if (isMessageCatchupActive) {
        ctx.log('[SEND] Abort media: synchronisation MLS en cours');
        ctx.setSendError('Sync in progress - please try again in a moment.');
        return;
      }
      const stillMember = await ctx.verifyCurrentUserMembership(ctx.selectedContact);
      if (!stillMember || convo.lifecycle !== 'active') {
        ctx.setSendError('Secure session being established. Please try again in a moment.');
        return;
      }
    }

    const currentReplyingTo = replyingTo;
    replyingTo = null;
    ctx.setSendError('');
    const channelSvc = isChannel ? new ChannelService() : null;

    const kindMap: Record<string, number> = {
      image: MediaKind.MEDIA_IMAGE,
      video: MediaKind.MEDIA_VIDEO,
      audio: MediaKind.MEDIA_AUDIO,
      file: MediaKind.MEDIA_FILE,
    };
    const mediaTypeFromMime = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
      mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'file';

    if (fileEntries.length > 0) {
      pendingMediaFiles = [];
      try {
        for (let index = 0; index < fileEntries.length; index++) {
          const entry = fileEntries[index];
          const captionForFile = index === 0 ? mediaCaption : undefined;
          const messageId = crypto.randomUUID();
          const sentAt = Date.now();

          if (isChannel && channelSvc) {
            // Channels are server-authoritative + always available: encrypt + upload + send inline.
            isUploadingMedia = true;
            let { authToken } = ctx;
            if (!authToken) {
              authToken = await getToken();
              ctx.setAuthToken(authToken);
            }
            const mediaRef = await mediaService.encryptAndUpload(entry.file, authToken, {
              width: entry.width,
              height: entry.height,
            });
            const protoBytes = encodeAppMessage({
              ...mkMedia({
                kind: kindMap[mediaRef.type] ?? MediaKind.MEDIA_FILE,
                mediaId: mediaRef.mediaId,
                key: fromHex(mediaRef.key),
                iv: fromHex(mediaRef.iv),
                mimeType: mediaRef.mimeType,
                size: mediaRef.size,
                fileName: mediaRef.fileName ?? '',
                caption: captionForFile,
                ...(mediaRef.width && mediaRef.height
                  ? { width: mediaRef.width, height: mediaRef.height }
                  : {}),
              }),
              messageId,
              sentAt,
            });
            const actualChannelId = ctx.selectedContact!.replace('channel_', '');
            await sendEncryptedChannelMessage(actualChannelId, protoBytes, messageId);
          } else {
            // MLS: queue the media. The flusher uploads then sends once the group is ready
            // (the optimistic message shows a skeleton + pending clock until then).
            const type = mediaTypeFromMime(entry.file.type);
            const placeholder = serializeEnvelope(
              mkMediaEnvelope(
                {
                  type,
                  mediaId: '',
                  key: '',
                  iv: '',
                  mimeType: entry.file.type,
                  size: entry.file.size,
                  fileName: entry.file.name,
                  width: entry.width,
                  height: entry.height,
                },
                captionForFile
              )
            );
            await addMessageToChat(ctx.userId, placeholder, ctx.selectedContact!, ctx, {
              messageId,
              status: 'pending',
              timestamp: new SvelteDate(sentAt),
            });
            const fileBytes = new Uint8Array(await entry.file.arrayBuffer());
            const outboxEntry: OutboxEntry = {
              id: messageId,
              conversationId: convo.id,
              sentAt,
              kind: 'media',
              media: {
                kind: kindMap[type],
                mimeType: entry.file.type,
                size: entry.file.size,
                fileName: entry.file.name,
                width: entry.width,
                height: entry.height,
                caption: captionForFile,
                fileBytes,
              },
              status: 'pending',
              attempts: 0,
              createdAt: sentAt,
            };
            await enqueueOutboxMessage(outboxEntry);
          }
          sentMediaMessageCount++;
        }
        if (sentMediaMessageCount > 0) {
          ctx.playSendTone?.();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (sentMediaMessageCount < fileEntries.length) {
          pendingMediaFiles = [...fileEntries.slice(sentMediaMessageCount), ...pendingMediaFiles];
        }
        ctx.setSendError(`Echec de l'envoi du media : ${errorMessage}`);
        ctx.log(`Erreur envoi media: ${errorMessage}`);
      } finally {
        isUploadingMedia = false;
      }
    }

    if (sentMediaMessageCount > 0 || !text) return;

    const result = await sendChatMessage(text, ctx.selectedContact!, currentReplyingTo, {
      userId: ctx.userId,
      conversation: convo,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        addMessageToChat(sid, content, contactName, ctx, options),
      log: ctx.log,
    });

    // Text/reply now always succeed (captured into the outbox); only a hard block
    // (deleted group) or a channel error surfaces a message to the user.
    if (!result.success) {
      if (result.error) {
        ctx.setSendError(result.error);
        ctx.log(`[SEND] Failed: ${result.error}`);
      }
      return;
    }

    ctx.log('[SEND] handleSendChat completed (message queued).');
    ctx.playSendTone?.();
  }

  // ── File handling ─────────────────────────────────────────────────────────

  /** Validates and enqueues files for sending. Images are auto-compressed with canvas API before queuing. Files exceeding the configured size limit are rejected with an error message. */
  async function handleFilesSelected(files: File[], ctx: MessagingContext) {
    const readyFiles: import('$lib/media').PendingMediaFile[] = [];
    for (const file of files) {
      if (Number.isFinite(mediaMaxSizeBytes) && file.size > mediaMaxSizeBytes) {
        const errorMessage = `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite: ${mediaMaxSizeMb} Mo.`;
        ctx.setSendError(errorMessage);
        ctx.log(`Erreur envoi media: ${errorMessage}`);
        continue;
      }
      let entry: import('$lib/media').PendingMediaFile = { file };
      // Never re-encode GIFs: canvas compression renders a single frame and would drop the
      // animation (matters for both picked GIFs and keyboard-committed GIFs). They are already
      // small and optimized, so they are sent as-is.
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        try {
          const { compressImage, IMAGE_COMPRESS_PRESETS } = await import('$lib/media');
          const originalSize = file.size;
          const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.chat;
          const compressed = await compressImage(file, maxWidth, maxHeight, quality);
          entry = {
            file: compressed.file,
            width: compressed.width > 0 ? compressed.width : undefined,
            height: compressed.height > 0 ? compressed.height : undefined,
          };
          if (compressed.file.size < originalSize) {
            const savedPercent = ((1 - compressed.file.size / originalSize) * 100).toFixed(0);
            ctx.log(
              `Image compressee: ${(originalSize / 1024 / 1024).toFixed(1)} Mo -> ${(compressed.file.size / 1024 / 1024).toFixed(1)} Mo (-${savedPercent}%)`
            );
          }
        } catch (e) {
          console.warn('Compression failed, using original:', e);
        }
      }
      readyFiles.push(entry);
    }
    if (readyFiles.length > 0) pendingMediaFiles = [...pendingMediaFiles, ...readyFiles];
  }

  /** Removes a staged (not yet sent) file from the pending media queue by its index. */
  function removePendingMediaFile(index: number) {
    pendingMediaFiles = pendingMediaFiles.filter((_, i) => i !== index);
  }

  // ── Reactions / edit / delete ─────────────────────────────────────────────

  /** Toggles an emoji reaction on a message: adds it if absent, removes it if the user already used that emoji. Updates state optimistically in memory and DB before sending the MLS message. */
  async function handleAddReaction(messageId: string, emoji: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const conversationKey = ctx.selectedContact.toLowerCase();
    const convo = ctx.conversations.get(conversationKey);
    if (!convo) return;
    const meNorm = ctx.userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const updated = toggleMessageReaction(existing, meNorm, emoji);

    if (!updated) {
      ctx.log(
        `[REACTION] Maximum of ${MAX_DISTINCT_MESSAGE_REACTIONS} distinct reactions reached on this message.`
      );
      return;
    }

    const alreadyReacted = existing.some((r) => r.userId === meNorm && r.emoji === emoji);

    messageReactions.set(messageId, updated);

    // Immediate in-memory and DB update to survive page reload.
    const msgIdx = convo.messages.findIndex((m) => m.id === messageId);
    if (msgIdx !== -1) {
      const nextMsgs = [...convo.messages];
      nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
      ctx.conversations.set(conversationKey, { ...convo, messages: nextMsgs });

      if (ctx.storage) {
        try {
          const target = nextMsgs[msgIdx];
          await ctx.storage.saveMessage(
            {
              id: target.id,
              conversationId: conversationKey,
              senderId: target.senderId,
              content: target.content,
              timestamp: target.timestamp.getTime(),
              readBy: target.readBy,
              reactions: updated,
              isDeleted: target.isDeleted,
              isEdited: target.isEdited,
            },
            ctx.pin
          );
        } catch (e) {
          console.warn('[DB] Failed to persist reaction locally:', e);
        }
      }
    }

    const reactionDeps = {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
      currentUserDisplayName: getUserDisplayNameSync(ctx.userId),
    };
    if (alreadyReacted) {
      await removeReaction(messageId, emoji, reactionDeps);
    } else {
      await addReaction(messageId, emoji, reactionDeps);
    }
  }

  /** Sends a "delete_message" MLS system message and marks the message as deleted in the local conversation state. Only the original sender can delete their own message. */
  async function handleDeleteMessage(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can delete their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    await deleteMessage(messageId, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
    });
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], isDeleted: true, content: chat_system_message_deleted() };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
    }
  }

  /** Sends an "edit_message" MLS system message and updates the message content and editedAt in the local conversation state. Only the original sender can edit their own message. */
  async function handleEditMessage(messageId: string, text: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can edit their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    await editMessage(messageId, text, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
    });
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = {
        ...msgs[idx],
        isEdited: true,
        editedAt: new SvelteDate(),
        content: text,
        readBy: [],
      };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
    }
  }

  /**
   * Toggles a message's pinned state: applies it locally (optimistic - the sender gets no
   * MLS echo) and broadcasts a "pin"/"unpin" system message so all members converge.
   */
  async function handleTogglePin(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
    const next = !isMessagePinned(convo.id, messageId);
    applyPin(convo.id, messageId, next);
    await setMessagePinned(messageId, next, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
    });
  }

  // ── Reply ─────────────────────────────────────────────────────────────────

  /** Sets the message the user is replying to, which will be embedded as a quote preview in the next send. */
  function handleReply(message: ChatMessage) {
    replyingTo = message;
  }

  /** Clears the pending reply state (user dismissed the reply banner). */
  function cancelReply() {
    replyingTo = null;
  }

  /**
   * Forwards a message (text OR media) to ANOTHER conversation, without touching
   * the current composition state (reply / pending files).
   *
   * Media: the envelope already carries the encrypted blob reference (mediaId) + the
   * decryption key (CEK/iv). The SAME media envelope is re-sent (no re-upload),
   * giving members of the target conversation access to the same blob via the forwarded key.
   * The target is always a direct conversation (channels are excluded by the forward selector).
   */
  async function forwardMessage(
    sourceContent: string,
    targetName: string,
    ctx: MessagingContext
  ): Promise<{ success: boolean; error?: string }> {
    const convo = ctx.conversations.get(targetName);
    if (!convo) return { success: false, error: 'Conversation introuvable.' };

    const env = parseEnvelope(sourceContent);
    const mlsService = ctx.ensureMls();

    try {
      if (env.kind === 'media') {
        // Media forward is an inline upload+send: it still needs a ready MLS group.
        if (convo.lifecycle !== 'active')
          return { success: false, error: 'Conversation not ready.' };
        const m = env.media;
        const kindMap: Record<string, number> = {
          image: MediaKind.MEDIA_IMAGE,
          video: MediaKind.MEDIA_VIDEO,
          audio: MediaKind.MEDIA_AUDIO,
          file: MediaKind.MEDIA_FILE,
        };
        const hexToBytes = (h: string) =>
          new Uint8Array((h.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
        const messageId = crypto.randomUUID();
        const protoBytes = encodeAppMessage({
          ...mkMedia({
            kind: kindMap[m.type] ?? MediaKind.MEDIA_FILE,
            mediaId: m.mediaId,
            key: hexToBytes(m.key),
            iv: hexToBytes(m.iv),
            mimeType: m.mimeType,
            size: m.size,
            fileName: m.fileName ?? '',
            caption: env.caption,
            ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
          }),
          messageId,
          sentAt: Date.now(),
        });
        await mlsService.sendMessage(convo.id, protoBytes, messageId);
        scheduleOutboundMlsPersist();
        const payload = serializeEnvelope(mkMediaEnvelope({ ...m }, env.caption));
        await addMessageToChat(ctx.userId, payload, targetName, ctx, { messageId });
        return { success: true };
      }

      const text = env.kind === 'text' ? env.text.trim() : '';
      if (!text) return { success: false, error: 'Nothing to forward.' };
      return await sendChatMessage(text, targetName, null, {
        userId: ctx.userId,
        conversation: convo,
        addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
          addMessageToChat(sid, content, contactName, ctx, options),
        log: ctx.log,
      });
    } catch (e) {
      return {
        success: false,
        error: `Forward failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    /** Reactive map of emoji reactions keyed by message ID. */
    messageReactions,

    /** Message the user is currently replying to (null when no reply is pending). */
    get replyingTo() {
      return replyingTo;
    },
    /** Files staged for sending in the next handleSendChat call. */
    get pendingMediaFiles() {
      return pendingMediaFiles;
    },
    /** True while a media file is being encrypted and uploaded. */
    get isUploadingMedia() {
      return isUploadingMedia;
    },
    /** True while the MLS queue is draining after reconnect (catch-up in progress). */
    get isMessageCatchupActive() {
      return isMessageCatchupActive;
    },

    /** Appends a single message to a conversation's reactive state and persists it to DB. */
    addMessageToChat,
    /** Buffers incoming messages during MLS queue catch-up (pair with endBulkMessageIngest). */
    beginBulkMessageIngest,
    /** Flushes buffered messages after MLS queue catch-up. */
    endBulkMessageIngest,
    /** Resets overlay + bulk buffer (e.g. after a desynced catch-up on mobile). */
    resetMessageCatchupState,
    /** Appends multiple messages in one reactive update and one batch DB write. */
    batchAddMessages,
    /** Main send handler: uploads pending media then sends a text message. */
    handleSendChat,
    forwardMessage,
    /** Validates and enqueues files (with image compression) for the next send. */
    handleFilesSelected,
    /** Removes a staged file from the pending media queue by index. */
    removePendingMediaFile,
    /** Toggles an emoji reaction on a message (add if absent, remove if present). */
    handleAddReaction,
    /** Sends a delete_message MLS event and marks the message as deleted locally. */
    handleDeleteMessage,
    /** Sends an edit_message MLS event and updates the message content locally. */
    handleEditMessage,
    /** Toggles a message's pinned state (optimistic local + pin/unpin MLS system event). */
    handleTogglePin,
    /** Sets the message to reply to (shown as a quote in the next send). */
    handleReply,
    /** Clears the pending reply state. */
    cancelReply,
  };
}
