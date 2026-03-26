/**
 * Reactive composable owning all message-level operations:
 * - Incoming message append + unread tracking
 * - Text send, media upload, reactions, edit, delete
 * - Read receipts (debounced)
 * - Reply/cancel-reply state
 * - File selection + validation
 */
import { tick } from 'svelte';
import { SvelteMap, SvelteDate } from 'svelte/reactivity';
import { toHex } from '$lib/utils/hex';
import { getToken } from '$lib/stores/auth';
import {
  sendChatMessage,
  addReaction,
  editMessage,
  deleteMessage,
  sendReadReceipt,
} from '$lib/utils/chat/messaging';
import { MediaService } from '$lib/media';
import { getPreviewText, mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import { encodeAppMessage, mkMedia, MediaKind } from '$lib/proto/codec';
import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';

export interface MessagingContext {
  ensureMls: () => IMlsService;
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
  sendSystemNotification: (title: string, body: string) => Promise<void>;
}

export function useMessaging() {
  const messageReactions = new SvelteMap<string, MessageReaction[]>();
  let replyingTo = $state<ChatMessage | null>(null);
  let pendingMediaFiles = $state<File[]>([]);
  let isUploadingMedia = $state(false);

  const mediaService = new MediaService();
  const mediaMaxSizeMb = Number.parseInt(import.meta.env.VITE_MEDIA_MAX_SIZE_MB ?? '100', 10);
  const mediaMaxSizeBytes = mediaMaxSizeMb * 1024 * 1024;

  // ── Incoming message ──────────────────────────────────────────────────────

  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    ctx: MessagingContext,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem = false,
    messageId?: string,
    timestamp?: Date
  ) {
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) return;

    const isOwn = senderId.toLowerCase() === ctx.userId.toLowerCase();
    const newMsg: ChatMessage = {
      id: messageId || crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: timestamp ?? new SvelteDate(),
      isOwn,
      replyTo,
      isSystem,
    };

    if (convo.messages.some((m) => m.id === newMsg.id)) return;

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
      messages: [...convo.messages, newMsg],
    });

    if (shouldMarkUnread) {
      ctx.playNotificationTone();
      const preview = getPreviewText(parseEnvelope(content));
      if (
        typeof document !== 'undefined' &&
        (document.visibilityState !== 'visible' || !document.hasFocus())
      ) {
        void ctx.sendSystemNotification(convo.name, preview || 'Nouveau message');
      }
    }

    if (ctx.storage && !isSystem) {
      try {
        await ctx.storage.saveMessage(
          {
            id: newMsg.id,
            conversationId: normalized,
            senderId: newMsg.senderId,
            content,
            timestamp: newMsg.timestamp.getTime(),
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

  async function addSystemMessage(content: string, contactName: string, ctx: MessagingContext) {
    await addMessageToChat('system', content, contactName, ctx, undefined, true);
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async function handleSendChat(ctx: MessagingContext) {
    const text = (ctx as any)._messageText?.trim?.() ?? '';
    const filesToSend = [...pendingMediaFiles];
    const mediaCaption = text || undefined;
    let sentMediaMessageCount = 0;

    if (!text && filesToSend.length === 0) return;
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    const stillMember = await ctx.verifyCurrentUserMembership(ctx.selectedContact);
    if (!stillMember || !convo.isReady) {
      ctx.setSendError(
        'Vous avez ete retire de ce groupe. Vous ne pouvez plus envoyer de messages.'
      );
      return;
    }

    const currentReplyingTo = replyingTo;
    replyingTo = null;
    ctx.setSendError('');
    const mlsService = ctx.ensureMls();

    if (filesToSend.length > 0) {
      pendingMediaFiles = [];
      isUploadingMedia = true;
      try {
        let { authToken } = ctx;
        if (!authToken) {
          authToken = await getToken();
          ctx.setAuthToken(authToken);
        }
        for (let index = 0; index < filesToSend.length; index++) {
          const fileToSend = filesToSend[index];
          const captionForFile = index === 0 ? mediaCaption : undefined;
          const mediaRef = await mediaService.encryptAndUpload(fileToSend, authToken);
          const messageId = crypto.randomUUID();
          const kindMap: Record<string, number> = {
            image: MediaKind.MEDIA_IMAGE,
            video: MediaKind.MEDIA_VIDEO,
            audio: MediaKind.MEDIA_AUDIO,
            file: MediaKind.MEDIA_FILE,
          };
          const keyBytes = new Uint8Array(
            (mediaRef.key.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16))
          );
          const ivBytes = new Uint8Array(
            (mediaRef.iv.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16))
          );
          const protoBytes = encodeAppMessage({
            ...mkMedia({
              kind: kindMap[mediaRef.type] ?? MediaKind.MEDIA_FILE,
              mediaId: mediaRef.mediaId,
              key: keyBytes,
              iv: ivBytes,
              mimeType: mediaRef.mimeType,
              size: mediaRef.size,
              fileName: mediaRef.fileName ?? '',
              caption: captionForFile,
            }),
            messageId,
          });
          await mlsService.sendMessage(convo.groupId, protoBytes);
          const stateBytes = await mlsService.saveState(ctx.pin);
          localStorage.setItem('mls_autosave_' + ctx.userId, toHex(stateBytes));
          const payload = serializeEnvelope(mkMediaEnvelope({ ...mediaRef }, captionForFile));
          await addMessageToChat(
            ctx.userId,
            payload,
            ctx.selectedContact!,
            ctx,
            undefined,
            false,
            messageId
          );
          sentMediaMessageCount++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (sentMediaMessageCount < filesToSend.length) {
          pendingMediaFiles = [...filesToSend.slice(sentMediaMessageCount), ...pendingMediaFiles];
        }
        ctx.setSendError(`Echec de l'envoi du media : ${errorMessage}`);
        ctx.log(`Erreur envoi media: ${errorMessage}`);
      } finally {
        isUploadingMedia = false;
      }
    }

    if (sentMediaMessageCount > 0 || !text) return;

    const result = await sendChatMessage(text, ctx.selectedContact!, currentReplyingTo, {
      mlsService,
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        replyTo?: { id: string; senderId: string; content: string },
        isSystem?: boolean,
        msgId?: string
      ) => addMessageToChat(sid, content, contactName, ctx, replyTo, isSystem, msgId),
      log: ctx.log,
    });

    if (!result.success) {
      ctx.setSendError(result.error || "Echec de l'envoi");
    }
  }

  // ── File handling ─────────────────────────────────────────────────────────

  async function handleFilesSelected(files: File[], ctx: MessagingContext) {
    const readyFiles: File[] = [];
    for (const file of files) {
      if (Number.isFinite(mediaMaxSizeBytes) && file.size > mediaMaxSizeBytes) {
        const errorMessage = `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite: ${mediaMaxSizeMb} Mo.`;
        ctx.setSendError(errorMessage);
        ctx.log(`Erreur envoi media: ${errorMessage}`);
        continue;
      }
      let processedFile = file;
      if (file.type.startsWith('image/')) {
        try {
          const { compressImage } = await import('$lib/media');
          const originalSize = file.size;
          processedFile = await compressImage(file);
          if (processedFile.size < originalSize) {
            const savedPercent = ((1 - processedFile.size / originalSize) * 100).toFixed(0);
            ctx.log(
              `Image compressee: ${(originalSize / 1024 / 1024).toFixed(1)} Mo -> ${(processedFile.size / 1024 / 1024).toFixed(1)} Mo (-${savedPercent}%)`
            );
          }
        } catch (e) {
          console.warn('Compression failed, using original:', e);
        }
      }
      readyFiles.push(processedFile);
    }
    if (readyFiles.length > 0) pendingMediaFiles = [...pendingMediaFiles, ...readyFiles];
  }

  function removePendingMediaFile(index: number) {
    pendingMediaFiles = pendingMediaFiles.filter((_, i) => i !== index);
  }

  // ── Reactions / edit / delete ─────────────────────────────────────────────

  async function handleAddReaction(messageId: string, emoji: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
    const meNorm = ctx.userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const updated = existing.filter((r) => r.userId !== meNorm);
    updated.push({ emoji, userId: meNorm });
    messageReactions.set(messageId, updated);
    await addReaction(messageId, emoji, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
    });
  }

  async function handleDeleteMessage(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
    await deleteMessage(messageId, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
    });
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], isDeleted: true, content: 'Ce message a ete supprime.' };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
    }
  }

  async function handleEditMessage(messageId: string, text: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
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

  // ── Reply ─────────────────────────────────────────────────────────────────

  function handleReply(message: ChatMessage) {
    replyingTo = message;
  }

  function cancelReply() {
    replyingTo = null;
  }

  // ── Read receipts (debounced 2 s) ─────────────────────────────────────────

  let pendingReadReceipts: string[] = [];
  let readReceiptTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReadReceipts(
    contactName: string,
    unreadMessageIds: string[],
    ctx: MessagingContext
  ) {
    unreadMessageIds.forEach((id) => {
      if (!pendingReadReceipts.includes(id)) pendingReadReceipts.push(id);
    });

    const meNorm = ctx.userId.toLowerCase();
    // Optimistically mark as read in UI
    const convo = ctx.conversations.get(contactName);
    if (convo) {
      ctx.conversations.set(contactName, {
        ...convo,
        messages: convo.messages.map((m) =>
          unreadMessageIds.includes(m.id) ? { ...m, readBy: [...(m.readBy || []), meNorm] } : m
        ),
      });
    }

    if (!readReceiptTimer) {
      readReceiptTimer = setTimeout(() => {
        const toSend = [...pendingReadReceipts];
        pendingReadReceipts = [];
        readReceiptTimer = null;
        if (toSend.length === 0) return;
        try {
          const mlsService = ctx.ensureMls();
          const fresh = ctx.conversations.get(contactName);
          if (!fresh) return;
          sendReadReceipt(toSend, {
            mlsService,
            userId: ctx.userId,
            pin: ctx.pin,
            conversation: fresh,
          }).catch(() => {});
        } catch {
          /* MLS not ready */
        }
      }, 2000);
    }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    messageReactions,

    get replyingTo() {
      return replyingTo;
    },
    get pendingMediaFiles() {
      return pendingMediaFiles;
    },
    get isUploadingMedia() {
      return isUploadingMedia;
    },

    addMessageToChat,
    addSystemMessage,
    handleSendChat,
    handleFilesSelected,
    removePendingMediaFile,
    handleAddReaction,
    handleDeleteMessage,
    handleEditMessage,
    handleReply,
    cancelReply,
    scheduleReadReceipts,
  };
}
