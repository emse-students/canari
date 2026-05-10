/**
 * Reactive composable owning all message-level operations:
 * - Incoming message append + unread tracking
 * - Text send, media upload, reactions, edit, delete
 * - Read receipts (debounced)
 * - Reply/cancel-reply state
 * - File selection + validation
 */
import { tick } from 'svelte';
import { SvelteMap, SvelteDate, SvelteSet } from 'svelte/reactivity';
import { saveMlsState } from '$lib/utils/hex';
import { getToken } from '$lib/stores/auth';
import {
  sendChatMessage,
  addReaction,
  removeReaction,
  editMessage,
  deleteMessage,
} from '$lib/utils/chat/messaging';
import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';
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
import type { IStorage, StoredMessage } from '$lib/db';
import { ChannelService } from '$lib/services/ChannelService';
import { sendEncryptedChannelMessage } from '$lib/utils/chat/channelCrypto';

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
  playSendTone?: () => void;
  playReceiveTone?: () => void;
  playReadTone?: () => void;
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

  function patchMessage(
    messageId: string,
    contactName: string,
    patch: { status: ChatMessage['status'] },
    ctx: MessagingContext
  ) {
    const key = contactName.toLowerCase();
    const convo = ctx.conversations.get(key);
    if (!convo) return;
    const idx = convo.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const msgs = [...convo.messages];
    msgs[idx] = { ...msgs[idx], ...patch };
    ctx.conversations.set(key, { ...convo, messages: msgs });

    if (ctx.storage) {
      const target = msgs[idx];
      ctx.storage
        .saveMessage(
          {
            id: target.id,
            conversationId: key,
            senderId: target.senderId,
            content: target.content,
            timestamp:
              target.timestamp instanceof Date
                ? target.timestamp.getTime()
                : new SvelteDate(target.timestamp as any).getTime(),
            readBy: target.readBy,
            reactions: target.reactions,
            isDeleted: target.isDeleted,
            isEdited: target.isEdited,
          },
          ctx.pin
        )
        .catch((e) => console.error('[DB] Failed to persist patched message:', e));
    }
  }

  // --- NOUVELLE SIGNATURE AVEC UN OBJET D'OPTIONS ---
  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    ctx: MessagingContext,
    options: AddMessageToChatOptions & { skipDbSave?: boolean } = {}
  ) {
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      console.warn(`[ADD_MSG] conversation "${normalized}" introuvable...`);
      return;
    }

    const isOwn = senderId.toLowerCase() === ctx.userId.toLowerCase();
    const newMsg: ChatMessage = {
      id: options.messageId || crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: options.timestamp ?? new SvelteDate(),
      isOwn,
      replyTo: options.replyTo,
      isSystem: options.isSystem ?? false,
      status: options.status,
    };

    if (convo.messages.some((m) => m.id === newMsg.id)) {
      console.log(`[ADD_MSG] Doublon ignoré id=${newMsg.id}...`);
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
    });
    console.log(`[ADD_MSG] ✓ Message ajouté: id=${newMsg.id}...`);

    if (!isOwn && !options.isSystem) {
      (ctx.playReceiveTone ?? ctx.playNotificationTone)();
    }

    const shouldSendSystemNotification =
      !isOwn &&
      !options.isSystem &&
      typeof document !== 'undefined' &&
      (document.visibilityState !== 'visible' || !document.hasFocus());

    if (shouldSendSystemNotification) {
      const preview = getPreviewText(parseEnvelope(content));
      void ctx.sendSystemNotification(convo.name, preview || 'Nouveau message');
    }

    // --- LE NOYAU DU CORRECTIF EST LÀ ---
    if (ctx.storage && !options.skipDbSave) {
      try {
        await ctx.storage.saveMessage(
          {
            id: newMsg.id,
            conversationId: normalized,
            senderId: newMsg.senderId,
            content,
            timestamp: newMsg.timestamp.getTime(),
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

  async function addSystemMessage(content: string, contactName: string, ctx: MessagingContext) {
    await addMessageToChat('system', content, contactName, ctx, { isSystem: true });
  }

  async function batchAddMessages(
    messages: Array<{
      senderId: string;
      content: string;
      replyTo?: { id: string; senderId: string; content: string };
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
    }>,
    contactName: string,
    ctx: MessagingContext
  ) {
    if (messages.length === 0) return;
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) return;

    const existingIds = new SvelteSet(convo.messages.map((m) => m.id));
    const toStore: StoredMessage[] = [];
    const newMessages: ChatMessage[] = [];

    for (const pm of messages) {
      const id = pm.messageId || crypto.randomUUID();
      if (existingIds.has(id)) continue;
      existingIds.add(id);

      const isOwn = pm.senderId.toLowerCase() === ctx.userId.toLowerCase();
      const newMsg: ChatMessage = {
        id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: pm.timestamp ?? new SvelteDate(),
        isOwn,
        replyTo: pm.replyTo,
        isSystem: pm.isSystem,
      };
      newMessages.push(newMsg);

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
          ...(pm.isSystem ? { readBy: [] } : {}),
        });
      }
    }

    if (newMessages.length === 0) return;

    // Sort and merge with existing messages — single reactive update
    const merged = [...convo.messages, ...newMessages].sort((a, b) => {
      const ta =
        a.timestamp instanceof Date ? a.timestamp.getTime() : new SvelteDate(a.timestamp).getTime();
      const tb =
        b.timestamp instanceof Date ? b.timestamp.getTime() : new SvelteDate(b.timestamp).getTime();
      return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
    });

    ctx.conversations.set(normalized, { ...convo, messages: merged });

    // Single batch DB write
    if (ctx.storage && toStore.length > 0) {
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

  async function handleSendChat(ctx: MessagingContext, messageText: string) {
    const text = messageText.trim();
    const filesToSend = [...pendingMediaFiles];
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
      ctx.log('[SEND] Abort: aucun contact sélectionné');
      return;
    }
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) {
      ctx.log(`[SEND] Abort: pas de conversation trouvée pour "${ctx.selectedContact}"`);
      return;
    }

    const isChannel = ctx.selectedContact.startsWith('channel_');
    ctx.log(`[SEND] convo: groupId="${convo.id}" isReady=${convo.isReady} isChannel=${isChannel}`);

    // Channels don't use MLS — skip MLS membership verification
    if (!isChannel) {
      ctx.log('[SEND] Vérification membership MLS...');
      const stillMember = await ctx.verifyCurrentUserMembership(ctx.selectedContact);
      ctx.log(`[SEND] membership: stillMember=${stillMember} convo.isReady=${convo.isReady}`);
      if (!stillMember || !convo.isReady) {
        ctx.setSendError('Le groupe est en cours de resynchronisation. Réessaie plus tard');
        return;
      }
    }

    const currentReplyingTo = replyingTo;
    replyingTo = null;
    ctx.setSendError('');
    const mlsService = !isChannel ? ctx.ensureMls() : null;
    const channelSvc = isChannel ? new ChannelService() : null;

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
          if (isChannel && channelSvc) {
            // Send media as channel message via REST
            const actualChannelId = ctx.selectedContact!.replace('channel_', '');
            await sendEncryptedChannelMessage(actualChannelId, protoBytes, messageId);
          } else if (mlsService) {
            await mlsService.sendMessage(convo.id, protoBytes, messageId);
            const stateBytes = await mlsService.saveState(ctx.pin);
            await saveMlsState(ctx.userId, stateBytes);
          }
          const payload = serializeEnvelope(mkMediaEnvelope({ ...mediaRef }, captionForFile));
          await addMessageToChat(ctx.userId, payload, ctx.selectedContact!, ctx, {
            messageId,
            skipDbSave: false,
          });
          sentMediaMessageCount++;
        }
        if (sentMediaMessageCount > 0) {
          ctx.playSendTone?.();
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
      mlsService: isChannel ? (null as any) : mlsService!,
      userId: ctx.userId,
      pin: ctx.pin,
      conversation: convo,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        addMessageToChat(sid, content, contactName, ctx, options),
      patchMessage: (
        msgId: string,
        contactName: string,
        patch: { status: ChatMessage['status'] }
      ) => patchMessage(msgId, contactName, patch, ctx),
      log: ctx.log,
    });

    if (!result.success) {
      const errStr = result.error || "Echec de l'envoi";
      const isGroupNotFound =
        errStr.toLowerCase().includes('groupe introuvable') ||
        errStr.toLowerCase().includes('group not found');
      if (isGroupNotFound && ctx.selectedContact) {
        const staleConvo = ctx.conversations.get(ctx.selectedContact);
        if (staleConvo) {
          ctx.conversations.set(ctx.selectedContact, { ...staleConvo, isReady: false });
          ctx.saveConversation(ctx.selectedContact).catch(() => {});
          try {
            ctx
              .ensureMls()
              .sendReinviteRequest(staleConvo.id)
              .catch(() => {});
          } catch {
            /* non-blocking */
          }
        }
        ctx.setSendError('Groupe désynchronisé. Resynchronisation en cours…');
        ctx.log(`[SEND] GroupNotFound → isReady=false + reinvite_request (${ctx.selectedContact})`);
      } else {
        ctx.setSendError(errStr);
        ctx.log(`[SEND] Échec: ${errStr}`);
      }
      return;
    }

    ctx.log(`[SEND] handleSendChat terminé avec succès`);
    ctx.playSendTone?.();
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
    const conversationKey = ctx.selectedContact.toLowerCase();
    const convo = ctx.conversations.get(conversationKey);
    if (!convo) return;
    const meNorm = ctx.userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const alreadyReacted = existing.some((r) => r.userId === meNorm && r.emoji === emoji);

    // Toggle off: même emoji déjà posée → retirer
    // Toggle on: nouvelle emoji → ajouter (sans retirer les autres emojis de l'utilisateur)
    const updated = alreadyReacted
      ? existing.filter((r) => !(r.userId === meNorm && r.emoji === emoji))
      : [
          ...existing.filter((r) => !(r.userId === meNorm && r.emoji === emoji)),
          { emoji, userId: meNorm },
        ];

    messageReactions.set(messageId, updated);

    // Mise à jour immédiate en mémoire et en DB pour survivre au rechargement
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
    };
    if (alreadyReacted) {
      await removeReaction(messageId, emoji, reactionDeps);
    } else {
      await addReaction(messageId, emoji, reactionDeps);
    }
  }

  async function handleDeleteMessage(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can delete their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || target.senderId.toLowerCase() !== ctx.userId.toLowerCase()) return;

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

    // Ownership check: only the sender can edit their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || target.senderId.toLowerCase() !== ctx.userId.toLowerCase()) return;

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
    batchAddMessages,
    handleSendChat,
    handleFilesSelected,
    removePendingMediaFile,
    handleAddReaction,
    handleDeleteMessage,
    handleEditMessage,
    handleReply,
    cancelReply,
  };
}
