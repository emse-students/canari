import { saveMlsState } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type {
  AddMessageToChatOptions,
  ChatMessage,
  Conversation,
  MessageReaction,
} from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { decodeAppMessage } from '$lib/proto/codec';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import {
  appMsgToEnvelope,
  isOwnMessage,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { readStoredTimestampMs, toValidDate } from '$lib/utils/dates';
import { normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { toggleMessageReaction } from '$lib/utils/chat/messageReactions';

/** Return the localStorage key used to persist the set of already-processed ciphertext fingerprints for a group. */
function seenHistoryKey(userId: string, groupId: string): string {
  return `history_seen_cipher:${userId}:${groupId}`;
}

/** Return the localStorage key used to persist the last-processed Redis stream ID for incremental history fetching. */
function lastStreamIdKey(userId: string, groupId: string): string {
  return `history_last_stream_id:${userId}:${groupId}`;
}

/** Read the last-processed Redis stream ID from localStorage; returns undefined if not set. */
function loadLastStreamId(userId: string, groupId: string): string | undefined {
  return localStorage.getItem(lastStreamIdKey(userId, groupId)) ?? undefined;
}

/** Persist the latest processed Redis stream ID so the next history fetch is incremental. */
function saveLastStreamId(userId: string, groupId: string, streamId: string): void {
  try {
    localStorage.setItem(lastStreamIdKey(userId, groupId), streamId);
  } catch {
    /* quota exceeded — graceful degradation */
  }
}

/** Load the set of already-seen ciphertext fingerprints from localStorage (used to skip duplicate history entries). */
function loadSeenCipherHashes(userId: string, groupId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenHistoryKey(userId, groupId)) ?? '[]'));
  } catch {
    return new Set();
  }
}

/** Persist the seen-ciphertext fingerprint set to localStorage, capped at 5 000 entries to bound storage growth. */
function saveSeenCipherHashes(userId: string, groupId: string, hashes: Set<string>): void {
  // Keep the cache bounded to avoid unbounded localStorage growth.
  const MAX_HASHES = 5000;
  const arr = [...hashes];
  const bounded = arr.length > MAX_HASHES ? arr.slice(arr.length - MAX_HASHES) : arr;
  try {
    localStorage.setItem(seenHistoryKey(userId, groupId), JSON.stringify(bounded));
  } catch {
    /* quota exceeded — graceful degradation */
  }
}

/** Converts raw StoredMessage rows (from IndexedDB) to ChatMessage objects, flagging each as isOwn based on senderId. */
export function mapStoredMessagesToChatMessages(storedMessages: StoredMessage[], userId: string) {
  return storedMessages.map((m) => {
    return {
      id: m.id,
      senderId: m.senderId,
      content: m.content,
      timestamp: toValidDate(readStoredTimestampMs(m.timestamp)),
      isOwn: isOwnMessage(m.senderId, userId),
      isSystem: m.senderId === 'system',
      readBy: m.readBy,
      reactions: m.reactions,
      readAt: m.readAt,
      serverTimestamp: m.serverTimestamp,
      ...(m.isDeleted ? { isDeleted: true } : {}),
      ...(m.isEdited ? { isEdited: true } : {}),
    } satisfies ChatMessage;
  });
}

/** Replays stored ciphertext messages for a conversation by decrypting them via the MLS service and writing the results to local DB and the reactive conversation state. */
export async function replayConversationHistory(params: {
  mlsService: IMlsService;
  id: string;
  contactName: string;
  userId: string;
  pin: string;
  /** Write decrypted messages directly to local DB (DB-first architecture). */
  storage: IStorage | null;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  messageReactions: Map<string, MessageReaction[]>;
  log: (msg: string) => void;
}) {
  const {
    mlsService,
    id,
    contactName,
    userId,
    pin,
    storage,
    getConversation,
    setConversation,
    messageReactions,
    log,
  } = params;

  try {
    // Incremental fetch: only retrieve messages after the last processed stream ID.
    // This avoids re-delivering messages whose ratchet keys have already been consumed
    // (which would produce TooDistantInThePast / CiphertextGenerationOutOfBounds errors).
    // Fix #7: If DB was cleared (e.g. browser storage wipe) without clearing localStorage,
    // the cursor points past messages that no longer exist locally. Reset it so the full
    // history is re-fetched.
    let afterStreamId = loadLastStreamId(userId, id);
    if (afterStreamId && storage) {
      try {
        const storedMsgs = await storage.getMessages(id, pin);
        if (storedMsgs.length === 0) {
          try {
            localStorage.removeItem(lastStreamIdKey(userId, id));
          } catch {
            /* ignore */
          }
          afterStreamId = undefined;
        }
      } catch {
        /* if DB check fails, proceed with existing cursor */
      }
    }
    const history = await mlsService.fetchHistory(id, afterStreamId);
    if (history.length === 0) return;

    // Track the highest stream ID we process so the next sync starts from there.
    let latestStreamId: string | undefined;

    const seenCipherHashes = loadSeenCipherHashes(userId, id);
    let seenUpdated = false;

    let addedMsg = 0;
    let mlsUpdated = false;

    // Collect reaction mutations so we can persist them to DB in one pass after
    // the main message batch write (reactions reference messages from previous
    // sessions that are already in DB).
    const reactionUpdates = new Map<string, MessageReaction[]>(); // msgId → final state
    // delete_message / edit_message events from history: collected here and persisted
    // to DB after the main batch save so the DB reload in loadExistingConversations
    // reflects the correct state without a second network round-trip.
    const deletedMessageIds = new Set<string>();
    const editedMessages = new Map<string, { content: string; editedAt: Date }>();
    // Read receipts from history update in-memory state but NOT the DB; the batch
    // save below writes regular messages without readBy (full replace via IndexedDB
    // put), which would overwrite any readBy already saved for those messages.
    // We collect the receipts here and re-apply them to DB after the batch save.
    const readReceiptDbUpdates: Array<{ msgId: string; senderNorm: string; readAt?: number }> = [];

    // Batch-collect decoded messages to flush in one UI update at the end.
    const pendingMessages: Array<{ senderId: string; content: string } & AddMessageToChatOptions> =
      [];
    let historyIngestSeq = 0;

    for (const msg of history) {
      // Update latest stream ID (Redis stream IDs sort lexicographically)
      if (msg.id && (!latestStreamId || msg.id > latestStreamId)) {
        latestStreamId = msg.id;
      }

      // Use the Redis stream ID as fingerprint — globally unique, no collision risk.
      // Fall back to timestamp+content prefix for entries without an ID.
      const cipherFingerprint = msg.id || `${msg.timestamp}:${msg.content.slice(0, 64)}`;
      if (seenCipherHashes.has(cipherFingerprint)) {
        continue;
      }

      try {
        const bytesStr = atob(msg.content);
        const bytes = new Uint8Array(bytesStr.length);
        for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i);

        const decryptedBytes = await mlsService.processIncomingMessage(id, bytes);
        if (!decryptedBytes) continue;

        const parsed = decodeAppMessage(decryptedBytes);

        const serverMs = parseServerTimestampMs(msg.timestamp);
        const envelope = parsed ? appMsgToEnvelope(parsed, serverMs) : null;
        if (envelope) {
          pendingMessages.push({
            senderId: msg.sender_id,
            content: envelope.content,
            ...envelope.options,
            ingestSequence: historyIngestSeq++,
          });
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.reaction) {
          const messageId = parsed.reaction.messageId ?? '';
          const senderNorm = msg.sender_id.toLowerCase();
          const reactions = messageReactions.get(messageId) || [];
          const emoji = parsed.reaction.emoji ?? '';
          const filtered = toggleMessageReaction(reactions, senderNorm, emoji);
          if (!filtered) continue;
          messageReactions.set(messageId, filtered);
          reactionUpdates.set(messageId, filtered);
          mlsUpdated = true;
          continue;
        } else if (parsed?.system) {
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
            } else if (
              parsed.system.event === 'edit_message' &&
              data.messageId &&
              data.newContent
            ) {
              const editedAt =
                typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
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
              const trimmed = cur.filter(
                (r) => !(r.userId === senderReactNorm && r.emoji === data.emoji)
              );
              messageReactions.set(data.messageId, trimmed);
              reactionUpdates.set(data.messageId, trimmed);
            }
          } catch {
            // Keep history replay robust even if a control payload is malformed.
          }

          if (systemText) {
            const systemServerMs = parseServerTimestampMs(msg.timestamp);
            pendingMessages.push({
              senderId: 'system',
              content: systemText,
              isSystem: true,
              messageId: parsed.messageId || undefined,
              timestamp: systemServerMs !== undefined ? new Date(systemServerMs) : undefined,
              ingestSequence: historyIngestSeq++,
            });
            addedMsg++;
          }
          mlsUpdated = true;
          continue;
        }
      } catch (err) {
        const errStr = String(err);
        if (
          errStr.includes('CannotDecryptOwnMessage') ||
          errStr.includes('WrongEpoch') ||
          errStr.includes('SecretReuseError')
        ) {
          // Mark as seen so subsequent history sync rounds do not reprocess
          // the same stale ciphertext forever.
          seenCipherHashes.add(cipherFingerprint);
          seenUpdated = true;
          continue;
        }
        console.warn(`History msg error: ${err}`);
      } finally {
        seenCipherHashes.add(cipherFingerprint);
        seenUpdated = true;
      }

      if (historyIngestSeq > 0 && historyIngestSeq % 8 === 0) {
        await yieldToMainThread();
      }
    }

    if (seenUpdated) {
      saveSeenCipherHashes(userId, id, seenCipherHashes);
    }

    // Flush all decoded messages in a single batch DB write.
    if (pendingMessages.length > 0 && storage) {
      const toStore: StoredMessage[] = pendingMessages.map((pm) => ({
        id: normalizeMessageId(pm.messageId) ?? crypto.randomUUID(),
        conversationId: id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: resolveMessageTimestamp(pm, [], isOwnMessage(pm.senderId, userId)).getTime(),
        ...(pm.isSystem ? { readBy: [] } : {}),
      }));
      await storage.saveMessages(toStore, pin);
    }

    // Re-apply readBy updates AFTER the batch save, since the batch save wrote
    // regular messages without readBy (IndexedDB put = full replace). Without
    // this pass, read receipts processed from history are lost when the DB is
    // reloaded in useConversations.loadHistoryForConversation.
    if (storage && readReceiptDbUpdates.length > 0) {
      try {
        const allMessages = await storage.getMessages(id, pin);
        const toUpdate: StoredMessage[] = [];
        for (const { msgId, senderNorm, readAt } of readReceiptDbUpdates) {
          const m = allMessages.find((x) => x.id === msgId);
          if (m) {
            const readBy = m.readBy ?? [];
            if (!readBy.includes(senderNorm)) {
              toUpdate.push({
                ...m,
                readBy: [...readBy, senderNorm],
                ...(readAt != null && m.readAt == null ? { readAt } : {}),
              });
            }
          }
        }
        if (toUpdate.length > 0) {
          await storage.saveMessages(toUpdate, pin);
        }
      } catch {
        // Non-blocking
      }
    }

    // Persist reaction mutations to DB. Reactions reference messages from previous
    // sessions, so we fetch the affected rows and re-save with updated reactions.
    if (storage && reactionUpdates.size > 0) {
      try {
        const allMessages = await storage.getMessages(id, pin);
        const toUpdate: StoredMessage[] = [];
        for (const m of allMessages) {
          if (reactionUpdates.has(m.id)) {
            toUpdate.push({ ...m, reactions: reactionUpdates.get(m.id) });
          }
        }
        if (toUpdate.length > 0) {
          await storage.saveMessages(toUpdate, pin);
        }
      } catch {
        // Non-blocking
      }
    }

    // Persist delete/edit mutations from history to DB so they survive the DB reload
    // that follows in loadExistingConversations (which overwrites in-memory state).
    if (storage && (deletedMessageIds.size > 0 || editedMessages.size > 0)) {
      try {
        const allMessages = await storage.getMessages(id, pin);
        const toUpdate: StoredMessage[] = [];
        for (const m of allMessages) {
          if (deletedMessageIds.has(m.id)) {
            toUpdate.push({ ...m, isDeleted: true, content: 'Ce message a été supprimé.' });
          } else if (editedMessages.has(m.id)) {
            const edit = editedMessages.get(m.id)!;
            toUpdate.push({ ...m, isEdited: true, content: edit.content });
          }
        }
        if (toUpdate.length > 0) {
          await storage.saveMessages(toUpdate, pin);
        }
      } catch {
        // Non-blocking
      }
    }

    // Persist the last processed Redis stream ID so the next sync is incremental.
    if (latestStreamId) {
      saveLastStreamId(userId, id, latestStreamId);
    }

    if (mlsUpdated) {
      const stateBytes = await mlsService.saveState(pin);
      saveMlsState(userId, stateBytes);
      log(`[OK] ${addedMsg} msg rattrapes pour ${contactName}.`);
    }
  } catch (err) {
    // Non-blocking: log the error and continue so other conversations still load
    log(
      `[WARN] Echec replay historique pour ${contactName}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const HEX_ID_RE = /\b[0-9a-f]{64}\b/g;

/**
 * Retroactively resolves 64-char hex user IDs baked into stored system message
 * content (e.g. "abc…def a ajouté xyz…uvw au groupe") that were stored before
 * async name resolution was applied. Updates the local DB so future loads are
 * already clean.
 */
export async function retroactivelyResolveHexIds(
  messages: ChatMessage[],
  storage: IStorage | null,
  conversationId: string,
  pin: string
): Promise<ChatMessage[]> {
  const hexIds = new Set<string>();
  for (const m of messages) {
    if (m.isSystem) {
      for (const id of m.content.match(HEX_ID_RE) ?? []) hexIds.add(id);
    }
  }
  if (hexIds.size === 0) return messages;

  const getName = await resolveDisplayNames([...hexIds]);

  const updated = messages.map((m) => {
    if (!m.isSystem) return m;
    const newContent = m.content.replace(HEX_ID_RE, (id) => getName(id));
    return newContent === m.content ? m : { ...m, content: newContent };
  });

  if (storage) {
    const toSave: StoredMessage[] = updated
      .filter((m, i) => m !== messages[i])
      .map((m) => ({
        id: m.id,
        conversationId,
        senderId: 'system',
        content: m.content,
        timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
        readBy: m.readBy ?? [],
        reactions: m.reactions,
        ...(m.isDeleted ? { isDeleted: true } : {}),
        ...(m.isEdited ? { isEdited: true } : {}),
      }));
    if (toSave.length > 0) storage.saveMessages(toSave, pin).catch(() => {});
  }

  return updated;
}
