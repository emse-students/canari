import { canari } from '$lib/proto/canari.js';
import type { AddMessageToChatOptions, Conversation, MessageReaction } from '$lib/types';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';

/** One Redis-stream history row as returned by `IMlsService.fetchHistory`. */
export type HistoryRow = { id?: string; sender_id: string; content: string; timestamp: string };

/** A decoded message queued for the single batched UI/DB write at the end of a replay page. */
export type PendingHistoryMessage = {
  senderId: string;
  content: string;
} & AddMessageToChatOptions & {
    reactions?: MessageReaction[];
    readBy?: string[];
    isDeleted?: boolean;
    isEdited?: boolean;
    readAt?: number;
  };

/**
 * Replay-side mutation sinks. Unlike the live path ({@link handleSystemEvent}), history
 * replay does not touch the DB per event: it accumulates mutations here and flushes them
 * once per page. Maps/sets/arrays are mutated by reference; messages to display go through
 * {@link ReplaySystemEventCtx.pushPendingMessage}.
 */
export interface ReplaySystemEventCtx {
  parsed: canari.AppMessage;
  msg: HistoryRow;
  contactName: string;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  messageReactions: Map<string, MessageReaction[]>;
  /** msgId -> final reaction list, applied to DB after the batch save. */
  reactionUpdates: Map<string, MessageReaction[]>;
  /** Message ids deleted via a `delete_message` event during this replay. */
  deletedMessageIds: Set<string>;
  /** Message ids edited via an `edit_message` event, with their new content. */
  editedMessages: Map<string, { content: string; editedAt: Date }>;
  /** Read receipts to re-apply to DB after the batch save (which would otherwise drop readBy). */
  readReceiptDbUpdates: Array<{ msgId: string; senderNorm: string; readAt?: number }>;
  /** Queues a decoded message for the page batch (assigns ingestSequence + bumps the added count). */
  pushPendingMessage: (entry: Omit<PendingHistoryMessage, 'ingestSequence'>) => void;
}

/**
 * Interprets a decoded MLS `system` event during history replay and routes its effect to the
 * accumulators in {@link ReplaySystemEventCtx}. Behaviour mirrors the live
 * {@link handleSystemEvent} but defers all writes to the page batch. Malformed control
 * payloads are swallowed so a single bad event never aborts the replay.
 */
export async function applyReplaySystemEvent(ctx: ReplaySystemEventCtx): Promise<void> {
  const {
    parsed,
    msg,
    contactName,
    getConversation,
    setConversation,
    messageReactions,
    reactionUpdates,
    deletedMessageIds,
    editedMessages,
    readReceiptDbUpdates,
    pushPendingMessage,
  } = ctx;

  if (!parsed.system) return;
  const senderNorm = msg.sender_id.toLowerCase();
  let systemText: string | null = null;

  try {
    const data = parsed.system.data ? JSON.parse(parsed.system.data) : {};

    if (parsed.system.event === 'groupRenamed' && data.newName) {
      const convo = getConversation(contactName);
      if (convo && convo.name !== data.newName) {
        setConversation(contactName, { ...convo, name: data.newName });
      }
      const getName = await resolveDisplayNames([senderNorm]);
      systemText = `${getName(senderNorm)} a renommé le groupe en "${data.newName}"`;
    } else if (parsed.system.event === 'memberRemoved' && data.targetUser) {
      const getName = await resolveDisplayNames([senderNorm, data.targetUser]);
      systemText = `${getName(senderNorm)} a retiré ${getName(data.targetUser)} du groupe`;
    } else if (parsed.system.event === 'memberLeft' && data.userId) {
      const getName = await resolveDisplayNames([data.userId]);
      systemText = `${getName(data.userId)} a quitté le groupe`;
    } else if (parsed.system.event === 'memberAdded') {
      const newUserIds: string[] =
        data.newUsers && Array.isArray(data.newUsers)
          ? data.newUsers
          : data.newUser
            ? [data.newUser]
            : [];
      const getName = await resolveDisplayNames([senderNorm, ...newUserIds]);
      const added = newUserIds.map((u: string) => getName(u)).join(', ');
      if (added) systemText = `${getName(senderNorm)} a ajouté ${added} au groupe`;
    } else if (parsed.system.event === 'groupDeleted') {
      const getName = await resolveDisplayNames([senderNorm]);
      systemText = `${getName(senderNorm)} a supprimé le groupe`;
    } else if (parsed.system.event === 'read_receipt') {
      const msgIds: string[] = data.messageIds ?? [];
      const convo = getConversation(contactName);
      if (convo && msgIds.length > 0) {
        const readAt = parseServerTimestampMs(msg.timestamp) ?? Date.now();
        let updated = false;
        const newMsgs = [...convo.messages];
        for (const msgId of msgIds) {
          const idx = newMsgs.findIndex((m) => m.id === msgId);
          if (idx !== -1) {
            const current = newMsgs[idx];
            const readBy = current.readBy || [];
            if (!readBy.includes(senderNorm)) {
              newMsgs[idx] = {
                ...current,
                readBy: [...readBy, senderNorm],
                readAt: current.readAt ?? readAt,
              };
              updated = true;
            }
          }
          readReceiptDbUpdates.push({ msgId, senderNorm, readAt });
        }
        if (updated) {
          setConversation(contactName, { ...convo, messages: newMsgs });
        }
      }
    } else if (parsed.system.event === 'delete_message' && data.messageId) {
      const convo = getConversation(contactName);
      if (convo) {
        const idx = convo.messages.findIndex((m) => m.id === data.messageId);
        if (idx !== -1) {
          const newMsgs = [...convo.messages];
          newMsgs[idx] = {
            ...newMsgs[idx],
            isDeleted: true,
            content: 'Ce message a été supprimé.',
          };
          setConversation(contactName, { ...convo, messages: newMsgs });
        }
      }
      deletedMessageIds.add(data.messageId);
    } else if (parsed.system.event === 'edit_message' && data.messageId && data.newContent) {
      const editedAt = typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
      const convo = getConversation(contactName);
      if (convo) {
        const idx = convo.messages.findIndex((m) => m.id === data.messageId);
        if (idx !== -1) {
          const newMsgs = [...convo.messages];
          newMsgs[idx] = {
            ...newMsgs[idx],
            isEdited: true,
            editedAt,
            content: data.newContent,
            readBy: [],
          };
          setConversation(contactName, { ...convo, messages: newMsgs });
        }
      }
      editedMessages.set(data.messageId, { content: data.newContent, editedAt });
    } else if (parsed.system.event === 'remove_reaction' && data.messageId && data.emoji) {
      const senderReactNorm = msg.sender_id.toLowerCase();
      const cur = messageReactions.get(data.messageId) || [];
      const trimmed = cur.filter((r) => !(r.userId === senderReactNorm && r.emoji === data.emoji));
      messageReactions.set(data.messageId, trimmed);
      reactionUpdates.set(data.messageId, trimmed);
    } else if (parsed.system.event === 'history_bundle') {
      // Le bundle est livré via la queue de messages; le traiter ici garantit qu'un
      // device arrivant en ligne après l'expiration de la queue (7 jours) récupère
      // quand même l'historique depuis Redis Streams.
      const bundleData = data.messages;
      if (Array.isArray(bundleData) && bundleData.length > 0) {
        const existingIds = new Set(
          (getConversation(contactName)?.messages ?? []).map((m) => m.id)
        );
        const serverMs = parseServerTimestampMs(msg.timestamp);
        for (const m of bundleData) {
          if (m?.id && !existingIds.has(m.id) && m.senderId && m.content) {
            pushPendingMessage({
              senderId: String(m.senderId).toLowerCase(),
              content: String(m.content),
              messageId: String(m.id),
              timestamp: typeof m.timestamp === 'number' ? new Date(m.timestamp) : undefined,
              // Préserver le serverTimestamp original de chaque message (tri stable).
              // Fallback sur serverMs (timestamp du bundle) seulement si absent.
              serverTimestamp: typeof m.serverTimestamp === 'number' ? m.serverTimestamp : serverMs,
              // Métadonnées transférées du device source : réactions, accusés,
              // suppressions et éditions - état complet au moment de la migration.
              ...(Array.isArray(m.reactions) && m.reactions.length > 0
                ? { reactions: m.reactions }
                : {}),
              ...(Array.isArray(m.readBy) && m.readBy.length > 0 ? { readBy: m.readBy } : {}),
              ...(m.isDeleted === true ? { isDeleted: true } : {}),
              ...(m.isEdited === true ? { isEdited: true } : {}),
              ...(typeof m.readAt === 'number' ? { readAt: m.readAt } : {}),
            });
          }
        }
        // Seed messageReactions depuis le bundle pour que les stream events de
        // réaction ultérieurs s'appliquent par-dessus, et non depuis un tableau vide.
        for (const m of bundleData) {
          if (m?.id && Array.isArray(m.reactions) && m.reactions.length > 0) {
            const msgId = String(m.id);
            if (!messageReactions.has(msgId)) {
              messageReactions.set(msgId, m.reactions);
            }
          }
        }
      }
    }
  } catch {
    // Keep history replay robust even if a control payload is malformed.
  }

  if (systemText) {
    const systemServerMs = parseServerTimestampMs(msg.timestamp);
    pushPendingMessage({
      senderId: 'system',
      content: systemText,
      isSystem: true,
      messageId: parsed.messageId || undefined,
      timestamp: systemServerMs !== undefined ? new Date(systemServerMs) : undefined,
    });
  }
}
