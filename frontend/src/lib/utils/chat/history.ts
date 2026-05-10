import { saveMlsState } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ChatMessage, Conversation, MessageReaction } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { decodeAppMessage, MediaKind } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope, parseEnvelope } from '$lib/envelope';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

function bytesToHex(bytes?: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return '';
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function seenHistoryKey(userId: string, groupId: string): string {
  return `history_seen_cipher:${userId}:${groupId}`;
}

function lastStreamIdKey(userId: string, groupId: string): string {
  return `history_last_stream_id:${userId}:${groupId}`;
}

function loadLastStreamId(userId: string, groupId: string): string | undefined {
  return localStorage.getItem(lastStreamIdKey(userId, groupId)) ?? undefined;
}

function saveLastStreamId(userId: string, groupId: string, streamId: string): void {
  try {
    localStorage.setItem(lastStreamIdKey(userId, groupId), streamId);
  } catch {
    /* quota exceeded — graceful degradation */
  }
}

function loadSeenCipherHashes(userId: string, groupId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenHistoryKey(userId, groupId)) ?? '[]'));
  } catch {
    return new Set();
  }
}

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

function mediaKindToType(kind?: number | null): 'image' | 'video' | 'audio' | 'file' {
  switch (kind) {
    case MediaKind.MEDIA_IMAGE:
      return 'image';
    case MediaKind.MEDIA_VIDEO:
      return 'video';
    case MediaKind.MEDIA_AUDIO:
      return 'audio';
    default:
      return 'file';
  }
}

export function mapStoredMessagesToChatMessages(storedMessages: StoredMessage[], userId: string) {
  return storedMessages.map((m) => {
    // Content is a serialized MessageEnvelope (new) or legacy JSON/plain-text.
    // parseEnvelope handles all three cases transparently.
    let content = m.content;
    let replyTo: ChatMessage['replyTo'] = undefined;

    try {
      const parsed = JSON.parse(m.content);
      // Legacy format: { content: string, replyTo?: ... }
      if (parsed.content && !parsed.kind) {
        if (typeof parsed.content === 'string') {
          // If nested content is already an envelope string, keep its semantic kind.
          const nestedEnvelope = parseEnvelope(parsed.content);
          content = serializeEnvelope(nestedEnvelope);
        } else {
          content = serializeEnvelope(mkTextEnvelope(String(parsed.content ?? ''), parsed.replyTo));
        }
        replyTo = parsed.replyTo;
      }
      // New envelope format — content stays as-is, replyTo is inside the envelope.
    } catch {
      // Legacy plain text — leave content as-is; parseEnvelope will wrap it.
    }

    return {
      id: m.id,
      senderId: m.senderId,
      content,
      timestamp: new Date(m.timestamp),
      isOwn: m.senderId.toLowerCase() === userId.toLowerCase(),
      replyTo,
      readBy: m.readBy,
      reactions: m.reactions,
      ...(m.isDeleted ? { isDeleted: true } : {}),
      ...(m.isEdited ? { isEdited: true } : {}),
    } satisfies ChatMessage;
  });
}

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
    let gapDetected = false;

    // Collect reaction mutations so we can persist them to DB in one pass after
    // the main message batch write (reactions reference messages from previous
    // sessions that are already in DB).
    const reactionUpdates = new Map<string, MessageReaction[]>(); // msgId → final state
    // Read receipts from history update in-memory state but NOT the DB; the batch
    // save below writes regular messages without readBy (full replace via IndexedDB
    // put), which would overwrite any readBy already saved for those messages.
    // We collect the receipts here and re-apply them to DB after the batch save.
    const readReceiptDbUpdates: Array<{ msgId: string; senderNorm: string }> = [];

    // Batch-collect decoded messages to flush in one UI update at the end.
    const pendingMessages: Array<{
      senderId: string;
      content: string;
      replyTo?: { id: string; senderId: string; content: string };
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
    }> = [];

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

        if (parsed?.text) {
          if (parsed.text.content) {
            pendingMessages.push({
              senderId: msg.sender_id,
              content: serializeEnvelope(mkTextEnvelope(parsed.text.content ?? '')),
              messageId: parsed.messageId || undefined,
              timestamp: new Date(msg.timestamp),
            });
            addedMsg++;
            mlsUpdated = true;
            continue;
          }
        } else if (parsed?.reply) {
          const replyTo = parsed.reply.replyTo
            ? {
                id: parsed.reply.replyTo.id ?? '',
                senderId: parsed.reply.replyTo.senderId ?? '',
                content: parsed.reply.replyTo.preview ?? '',
              }
            : undefined;
          pendingMessages.push({
            senderId: msg.sender_id,
            content: serializeEnvelope(mkTextEnvelope(parsed.reply.content ?? '', replyTo)),
            replyTo,
            messageId: parsed.messageId || undefined,
            timestamp: new Date(msg.timestamp),
          });
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.media) {
          pendingMessages.push({
            senderId: msg.sender_id,
            content: serializeEnvelope(
              mkMediaEnvelope(
                {
                  type: mediaKindToType(parsed.media.kind),
                  mediaId: parsed.media.mediaId ?? '',
                  key: bytesToHex(parsed.media.key),
                  iv: bytesToHex(parsed.media.iv),
                  mimeType: parsed.media.mimeType ?? '',
                  size: parsed.media.size ?? 0,
                  fileName: parsed.media.fileName ?? undefined,
                },
                parsed.media.caption || undefined
              )
            ),
            messageId: parsed.messageId || undefined,
            timestamp: new Date(msg.timestamp),
          });
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.reaction) {
          const messageId = parsed.reaction.messageId ?? '';
          const senderNorm = msg.sender_id.toLowerCase();
          const reactions = messageReactions.get(messageId) || [];
          const emoji = parsed.reaction.emoji ?? '';
          const filtered = reactions.filter((r) => !(r.userId === senderNorm && r.emoji === emoji));
          filtered.push({ emoji, userId: senderNorm });
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
              const senderName = getUserDisplayNameSync(senderNorm, senderNorm);
              systemText = `${senderName} a renommé le groupe en "${data.newName}"`;
            } else if (parsed.system.event === 'memberRemoved' && data.targetUser) {
              const senderName = getUserDisplayNameSync(senderNorm, senderNorm);
              const targetName = getUserDisplayNameSync(data.targetUser, data.targetUser);
              systemText = `${senderName} a retiré ${targetName} du groupe`;
            } else if (parsed.system.event === 'memberAdded') {
              const senderName = getUserDisplayNameSync(senderNorm, senderNorm);
              const added =
                data.newUsers && Array.isArray(data.newUsers)
                  ? data.newUsers.map((u: string) => getUserDisplayNameSync(u, u)).join(', ')
                  : getUserDisplayNameSync(data.newUser, data.newUser);
              if (added) systemText = `${senderName} a ajouté ${added} au groupe`;
            } else if (parsed.system.event === 'groupDeleted') {
              const senderName = getUserDisplayNameSync(senderNorm, senderNorm);
              systemText = `${senderName} a supprimé le groupe`;
            } else if (parsed.system.event === 'read_receipt') {
              const msgIds: string[] = data.messageIds ?? [];
              const convo = getConversation(contactName);
              if (convo && msgIds.length > 0) {
                let updated = false;
                const newMsgs = [...convo.messages];
                for (const msgId of msgIds) {
                  const idx = newMsgs.findIndex((m) => m.id === msgId);
                  if (idx !== -1) {
                    const current = newMsgs[idx];
                    const readBy = current.readBy || [];
                    if (!readBy.includes(senderNorm)) {
                      newMsgs[idx] = { ...current, readBy: [...readBy, senderNorm] };
                      updated = true;
                    }
                  }
                  readReceiptDbUpdates.push({ msgId, senderNorm });
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
            } else if (
              parsed.system.event === 'edit_message' &&
              data.messageId &&
              data.newContent
            ) {
              const convo = getConversation(contactName);
              if (convo) {
                const idx = convo.messages.findIndex((m) => m.id === data.messageId);
                if (idx !== -1) {
                  const newMsgs = [...convo.messages];
                  newMsgs[idx] = {
                    ...newMsgs[idx],
                    isEdited: true,
                    editedAt:
                      typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date(),
                    content: data.newContent,
                    readBy: [],
                  };
                  setConversation(contactName, { ...convo, messages: newMsgs });
                }
              }
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
            pendingMessages.push({
              senderId: 'system',
              content: systemText,
              isSystem: true,
              messageId: parsed.messageId || undefined,
              timestamp: new Date(msg.timestamp),
            });
            addedMsg++;
          }
          mlsUpdated = true;
          continue;
        } else {
          // Legacy plain text or unknown format
          const legacyText = new TextDecoder().decode(decryptedBytes);
          pendingMessages.push({
            senderId: msg.sender_id,
            content: serializeEnvelope(mkTextEnvelope(legacyText)),
            timestamp: new Date(msg.timestamp),
          });
          addedMsg++;
          mlsUpdated = true;
          continue;
        }
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('GAP_QUEUED:')) {
          // The ratchet is behind. Trigger async recovery and abort this history
          // batch — it will be replayed on the next loadHistory call after the
          // ratchet has caught up via fetchMissingMessages.
          // gapDetected=true prevents finally from marking this message as seen
          // and prevents latestStreamId from being persisted, so the next call
          // re-fetches from before the GAP and retries this message.
          console.warn(`[HISTORY] GAP détecté sur groupe=${id} — déclenchement recovery`);
          gapDetected = true;
          void mlsService.fetchMissingMessages(id);
          break;
        }
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
        if (!gapDetected) {
          seenCipherHashes.add(cipherFingerprint);
          seenUpdated = true;
        }
      }
    }

    if (seenUpdated) {
      saveSeenCipherHashes(userId, id, seenCipherHashes);
    }

    // Flush all decoded messages in a single batch DB write.
    if (pendingMessages.length > 0 && storage) {
      const toStore: StoredMessage[] = pendingMessages.map((pm) => ({
        id: pm.messageId || crypto.randomUUID(),
        conversationId: id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: (pm.timestamp ?? new Date()).getTime(),
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
        for (const { msgId, senderNorm } of readReceiptDbUpdates) {
          const m = allMessages.find((x) => x.id === msgId);
          if (m) {
            const readBy = m.readBy ?? [];
            if (!readBy.includes(senderNorm)) {
              toUpdate.push({ ...m, readBy: [...readBy, senderNorm] });
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

    // Persist the last processed Redis stream ID so the next sync is incremental.
    // Skip if a GAP was detected — the cursor must not advance past the unprocessed message.
    if (latestStreamId && !gapDetected) {
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
