import type { Conversation } from '$lib/types';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import { serializeEnvelope, mkChannelInviteEnvelope } from '$lib/envelope';
import { importChannelEpochKey } from '$lib/utils/chat/channelKeyMirror';
import { ChannelService } from '$lib/services/ChannelService';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { messageTime } from '$lib/utils/chat/messageOrder';
import { applyPin } from '$lib/stores/pinStore.svelte';
import type { MessageHandlerDeps } from './deps';

/**
 * Context passed to handleSystemEvent - extends MessageHandlerDeps with
 * per-message fields that are only known inside the message-processing callback.
 */
export interface SystemEventContext extends MessageHandlerDeps {
  /** Snapshot of the conversation at the moment the system message was received. */
  convo: Conversation;
  /** Conversation key in the conversations map (= MLS group id). */
  convoKey: string;
  /** Normalised (lowercase) sender user id. */
  senderNorm: string;
  /** Persist MLS state to storage immediately (used when group membership changes). */
  persistMlsStateNow: () => void;
  /** Queue metadata for messages received via the offline delivery queue. */
  deliveryMeta?: IncomingDeliveryMeta;
}

/**
 * Dispatches a decoded MLS system event to the appropriate handler.
 *
 * Called from setupMessageHandler after JSON-parsing `msg.system.data`.
 * Always returns `true` (ACK) - unknown events are silently ignored so
 * they don't block the delivery queue.
 */

export async function handleSystemEvent(
  event: string,
  data: any,
  ctx: SystemEventContext
): Promise<boolean> {
  const {
    mlsService,
    storage,
    userId,
    pin,
    conversations,
    messageReactions,
    addMessageToChat,
    batchAddMessages,
    deleteConversation,
    saveConversation,
    getSelectedContact,
    setSelectedContact,
    onReadReceiptReceived,
    log,
    convo,
    convoKey,
    senderNorm,
    persistMlsStateNow,
    deliveryMeta,
  } = ctx;

  if (event === 'channel_key_distribution') {
    const channelId = String(data.channelId || '');
    const distributionId = String(data.distributionId || '');
    const encryptedChannelKey = String(data.encryptedChannelKey || '');
    const keyVersion = Number(data.keyVersion || 0);
    const epochKeysRaw = Array.isArray(data.epochKeys) ? data.epochKeys : [];

    const epochKeys = epochKeysRaw

      .map((entry: any) => ({
        keyVersion: Number(entry?.keyVersion),
        encryptedChannelKey: String(entry?.encryptedChannelKey || ''),
      }))
      .filter(
        (entry: { keyVersion: number; encryptedChannelKey: string }) =>
          Number.isFinite(entry.keyVersion) && entry.keyVersion > 0 && !!entry.encryptedChannelKey
      );

    const fallbackCurrent =
      encryptedChannelKey && Number.isFinite(keyVersion) && keyVersion > 0
        ? [{ keyVersion, encryptedChannelKey }]
        : [];
    const keysToImport = epochKeys.length > 0 ? epochKeys : fallbackCurrent;

    if (!channelId || !distributionId || keysToImport.length === 0) {
      return true;
    }

    try {
      for (const item of keysToImport) {
        const rawKeyMat = Uint8Array.from(atob(item.encryptedChannelKey), (c) => c.charCodeAt(0));
        await importChannelEpochKey(channelId, item.keyVersion, rawKeyMat);
      }

      const channelSvc = new ChannelService();
      await channelSvc
        .markKeyDistributionReceived(channelId, distributionId, keyVersion)
        .catch(() => {});
      await channelSvc.ackKeyDistribution(channelId, distributionId, keyVersion).catch(() => {});

      const displayName = data.channelName || channelId;
      const inviteEnvelope = serializeEnvelope(
        mkChannelInviteEnvelope(channelId, displayName, data.workspaceName)
      );
      await addMessageToChat('system', inviteEnvelope, convoKey, { isSystem: true });
      log(
        `[CHANNEL-KEY] ${keysToImport.length} key(s) received via MLS for #${displayName} (up to v${keyVersion}).`
      );
    } catch (e) {
      log(
        `[CHANNEL-KEY] Echec traitement distribution ${distributionId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    return true;
  }

  if (event === 'groupRenamed' && data.newName) {
    conversations.set(convoKey, { ...convo, name: data.newName });
    if (storage) await saveConversation(convoKey);
    const getName = await resolveDisplayNames([senderNorm]);
    await addMessageToChat(
      'system',
      `${getName(senderNorm)} renamed the group to "${data.newName}"`,
      convoKey,
      { isSystem: true }
    );
    log(`📝 Group renamed to "${data.newName}" by ${getName(senderNorm)}`);
    return true;
  }

  if (event === 'groupImageChanged') {
    const imageMediaId =
      typeof data.imageMediaId === 'string' && data.imageMediaId ? data.imageMediaId : null;
    conversations.set(convoKey, { ...convo, imageMediaId });
    if (storage) await saveConversation(convoKey);
    const getName = await resolveDisplayNames([senderNorm]);
    await addMessageToChat(
      'system',
      imageMediaId
        ? `${getName(senderNorm)} changed the group photo`
        : `${getName(senderNorm)} removed the group photo`,
      convoKey,
      { isSystem: true }
    );
    log(`🖼️ Group photo changed by ${getName(senderNorm)} (media=${imageMediaId ?? 'null'})`);
    return true;
  }

  if (event === 'memberRemoved' && data.targetUser) {
    const getName = await resolveDisplayNames([senderNorm, data.targetUser]);
    if (data.targetUser.toLowerCase() === userId.toLowerCase()) {
      // Current user was kicked - purge the conversation immediately
      try {
        mlsService.forgetGroup(convo.id);
      } catch {
        /* non-blocking */
      }
      persistMlsStateNow();
      if (deleteConversation) await deleteConversation(convoKey);
      conversations.delete(convoKey);
      if (getSelectedContact() === convoKey) setSelectedContact(null);
      log(`[INFO] Kicked from group "${convoKey}" by ${getName(senderNorm)}`);
    } else {
      await addMessageToChat(
        'system',
        `${getName(senderNorm)} removed ${getName(data.targetUser)} from the group`,
        convoKey,
        { isSystem: true }
      );
    }
    return true;
  }

  if (event === 'memberAdded') {
    const newUserIds: string[] =
      data.newUsers && Array.isArray(data.newUsers)
        ? data.newUsers
        : data.newUser
          ? [data.newUser]
          : [];
    const getName = await resolveDisplayNames([senderNorm, ...newUserIds]);
    const added = newUserIds.map((u: string) => getName(u)).join(', ');
    if (added) {
      await addMessageToChat(
        'system',
        `${getName(senderNorm)} added ${added} to the group`,
        convoKey,
        { isSystem: true }
      );
    }
    return true;
  }

  if (event === 'groupDeleted') {
    const getName = await resolveDisplayNames([senderNorm]);
    const senderName = getName(senderNorm);
    try {
      mlsService.forgetGroup(convo.id);
    } catch {
      /* non-blocking */
    }
    persistMlsStateNow();

    if (senderNorm === userId) {
      // Deletion performed by us on another device: remove immediately
      // without user interaction (syncing our own action).
      if (getSelectedContact() === convoKey) setSelectedContact(null);
      conversations.delete(convoKey);
      await deleteConversation?.(convoKey).catch(() => {});
      log(`[INFO] Group deleted on another device - conversation removed immediately`);
    } else {
      // Deleted by another participant: add a visible message and set the
      // conversation to `removed` so the user can read the history before closing.
      await addMessageToChat('system', `${senderName} deleted this conversation.`, convoKey, {
        isSystem: true,
      });
      const updated = conversations.get(convoKey);
      if (updated) conversations.set(convoKey, { ...updated, lifecycle: 'removed' });
      await saveConversation(convoKey).catch(() => {});
      log(`[INFO] Group deleted by ${senderName} - conversation marked removed`);
    }
    return true;
  }

  if (event === 'read_receipt') {
    const msgIds: string[] = data.messageIds ?? [];
    const c = conversations.get(convoKey);
    if (c && msgIds.length > 0) {
      const msgIdSet = new Set(msgIds);
      let updated = false;
      const updatedMessages = c.messages.map((m) => {
        if (!msgIdSet.has(m.id)) return m;
        const readBy = m.readBy ?? [];
        if (readBy.includes(senderNorm)) return m;
        updated = true;
        return {
          ...m,
          readBy: [...readBy, senderNorm],
          readAt: m.readAt ?? deliveryMeta?.queuedCreatedAt ?? Date.now(),
        };
      });
      // Receipt emitted by OURSELVES from another device: we read this
      // conversation elsewhere → reset the unread count to zero to synchronise
      // the "read" state across our devices (readBy alone does not drive the unread badge).
      const selfRead = senderNorm === userId;
      if (updated || selfRead) {
        conversations.set(convoKey, {
          ...c,
          messages: updated ? updatedMessages : c.messages,
          ...(selfRead ? { unreadCount: 0 } : {}),
        });
        if (selfRead) await saveConversation?.(convoKey).catch(() => {});
      }
      if (updated) {
        log(`[READ] Receipt from ${senderNorm} → ${msgIds.length} message(s) marked read`);
        if (storage) {
          for (const msgId of msgIds) {
            const m = updatedMessages.find((x) => x.id === msgId);
            if (m) {
              try {
                await storage.saveMessage(
                  {
                    id: m.id,
                    conversationId: convoKey,
                    senderId: m.senderId,
                    content: m.content,
                    timestamp: messageTime(m),
                    readBy: m.readBy,
                    readAt: m.readAt,
                    reactions: messageReactions.get(m.id),
                    serverTimestamp: m.serverTimestamp,
                  },
                  pin
                );
              } catch {
                // Non-blocking
              }
            }
          }
        }
        onReadReceiptReceived?.({
          conversationKey: convoKey,
          senderId: senderNorm,
          messageIds: msgIds,
        });
      }
    }
    return true;
  }

  if (event === 'delete_message') {
    const c = conversations.get(convoKey);
    if (c && data.messageId) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1) {
        const orig = c.messages[idx];
        const deletedMsg = {
          ...orig,
          isDeleted: true,
          content: 'This message has been deleted.',
        };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? deletedMsg : m)),
        });
        if (storage) {
          try {
            await storage.saveMessage(
              {
                id: deletedMsg.id,
                conversationId: convoKey,
                senderId: deletedMsg.senderId,
                content: deletedMsg.content,
                timestamp: messageTime(deletedMsg),
                readBy: deletedMsg.readBy,
                reactions: messageReactions.get(deletedMsg.id),
                isDeleted: true,
              },
              pin
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if (event === 'edit_message' && data.messageId && data.newContent) {
    const c = conversations.get(convoKey);
    if (c) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1) {
        const orig = c.messages[idx];
        const editedAt = typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
        const editedMsg = {
          ...orig,
          isEdited: true,
          editedAt,
          content: data.newContent,
          readBy: [] as string[],
        };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? editedMsg : m)),
        });
        if (storage) {
          try {
            await storage.saveMessage(
              {
                id: editedMsg.id,
                conversationId: convoKey,
                senderId: editedMsg.senderId,
                content: data.newContent,
                timestamp: messageTime(editedMsg),
                readBy: [],
                reactions: messageReactions.get(editedMsg.id),
                isEdited: true,
              },
              pin
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if (event === 'history_bundle') {
    try {
      const msgs: Array<{
        id: string;
        senderId: string;
        content: string;
        timestamp: number;
      }> = Array.isArray(data.messages) ? data.messages : [];
      if (msgs.length > 0) {
        const existingIds = new Set(convo.messages.map((m) => m.id));
        const toAdd = msgs
          .filter((m) => !existingIds.has(m.id))
          .map((m) => ({
            senderId: m.senderId.toLowerCase(),
            content: m.content,
            messageId: m.id,
            timestamp: new Date(m.timestamp),
          }));
        if (toAdd.length > 0) {
          log(`[HISTORY_BUNDLE] ${toAdd.length} messages received from the inviting peer`);
          if (batchAddMessages) {
            await batchAddMessages(toAdd, convoKey);
          } else {
            for (const item of toAdd) {
              await addMessageToChat(item.senderId, item.content, convoKey, item);
            }
          }
        }
      }
    } catch {
      /* malformed bundle - ignore silently */
    }
    return true;
  }

  if (event === 'remove_reaction' && data.messageId && data.emoji) {
    const reactions = messageReactions.get(data.messageId) || [];
    const filtered = reactions.filter((r) => !(r.userId === senderNorm && r.emoji === data.emoji));
    messageReactions.set(data.messageId, filtered);

    const c = conversations.get(convoKey);
    if (c) {
      const msgIdx = c.messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx !== -1) {
        const nextMsgs = [...c.messages];
        nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: filtered };
        conversations.set(convoKey, { ...c, messages: nextMsgs });
        if (storage) {
          const target = nextMsgs[msgIdx];
          try {
            await storage.saveMessage(
              {
                id: target.id,
                conversationId: convoKey,
                senderId: target.senderId,
                content: target.content,
                timestamp: target.timestamp.getTime(),
                readBy: target.readBy,
                reactions: filtered,
              },
              pin
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if ((event === 'pin' || event === 'unpin') && data.messageId) {
    applyPin(convoKey, String(data.messageId), event === 'pin');
    return true;
  }

  // Unknown system event - ACK silently to avoid blocking the delivery queue
  return true;
}
