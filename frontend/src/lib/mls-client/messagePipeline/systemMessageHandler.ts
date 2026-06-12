import type { Conversation } from '$lib/types';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import { serializeEnvelope, mkChannelInviteEnvelope } from '$lib/envelope';
import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { ChannelService } from '$lib/services/ChannelService';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { messageTime } from '$lib/utils/chat/messageOrder';
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
      const vault = channelKeyManager.getVault(channelId);
      for (const item of keysToImport) {
        const rawKeyMat = Uint8Array.from(atob(item.encryptedChannelKey), (c) => c.charCodeAt(0));
        await vault.rotateKey(item.keyVersion, rawKeyMat);
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
        `[CHANNEL-KEY] ${keysToImport.length} cle(s) recue(s) via MLS pour #${displayName} (jusqu'a v${keyVersion}).`
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
      `${getName(senderNorm)} a renommé le groupe en "${data.newName}"`,
      convoKey,
      { isSystem: true }
    );
    log(`📝 Groupe renommé en "${data.newName}" par ${getName(senderNorm)}`);
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
      log(`[INFO] Expulsé du groupe "${convoKey}" par ${getName(senderNorm)}`);
    } else {
      await addMessageToChat(
        'system',
        `${getName(senderNorm)} a retiré ${getName(data.targetUser)} du groupe`,
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
        `${getName(senderNorm)} a ajouté ${added} au groupe`,
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
      // Suppression effectuée par nous-mêmes sur un autre appareil : supprimer immédiatement
      // sans interaction utilisateur (synchronisation de notre propre action).
      if (getSelectedContact() === convoKey) setSelectedContact(null);
      conversations.delete(convoKey);
      await deleteConversation?.(convoKey).catch(() => {});
      log(`[INFO] Groupe supprimé sur un autre appareil - conversation retirée immédiatement`);
    } else {
      // Suppression par un autre participant : ajouter un message visible et marquer
      // deletedRemotely pour que l'utilisateur puisse lire l'historique avant de fermer.
      await addMessageToChat('system', `${senderName} a supprimé cette conversation.`, convoKey, {
        isSystem: true,
      });
      const updated = conversations.get(convoKey);
      if (updated) conversations.set(convoKey, { ...updated, deletedRemotely: true });
      await saveConversation(convoKey).catch(() => {});
      log(`[INFO] Groupe supprimé par ${senderName} - conversation marquée deletedRemotely`);
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
      // Receipt émis par NOUS-MÊMES depuis un autre appareil : on a lu cette
      // conversation ailleurs → remettre le compteur non-lus à zéro pour synchroniser
      // l'état "lu" entre nos appareils (le readBy seul ne pilote pas le badge non-lu).
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
        log(`[READ] Receipt from ${senderNorm} → ${msgIds.length} message(s) marqués lus`);
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
          content: 'Ce message a été supprimé.',
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
          log(`[HISTORY_BUNDLE] ${toAdd.length} messages reçus depuis l'invitant`);
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
      /* bundle malformé - ignorer silencieusement */
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

  // Unknown system event - ACK silently to avoid blocking the delivery queue
  return true;
}
