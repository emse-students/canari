import type { HistoryStreamRow } from '$lib/mls-client/historyTypes';
import { fromBase64 } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ChatMessage, Conversation, MessageReaction } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { MlsDecryptSession } from '$lib/mls-client/mlsDecryptSession';
import { applyReplaySystemEvent, type PendingHistoryMessage } from './historySystemEvents';
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
import { addMessageReaction } from '$lib/utils/chat/messageReactions';

/** Return the localStorage key used to persist the set of already-processed ciphertext fingerprints for a group. */
function seenHistoryKey(userId: string, groupId: string): string {
  return `history_seen_cipher:${userId}:${groupId}`;
}

/** Return the localStorage key used to persist the last-processed Redis stream ID for incremental history fetching. */
function lastStreamIdKey(userId: string, groupId: string): string {
  return `history_last_stream_id:${userId}:${groupId}`;
}

/** Read the last-processed Redis stream ID from localStorage; returns undefined if not set. */
export function readHistoryStreamCursor(userId: string, groupId: string): string | undefined {
  return localStorage.getItem(lastStreamIdKey(userId, groupId)) ?? undefined;
}

function loadLastStreamId(userId: string, groupId: string): string | undefined {
  return readHistoryStreamCursor(userId, groupId);
}

/** Persist the latest processed Redis stream ID so the next history fetch is incremental. */
function saveLastStreamId(userId: string, groupId: string, streamId: string): void {
  try {
    localStorage.setItem(lastStreamIdKey(userId, groupId), streamId);
  } catch {
    /* quota exceeded - graceful degradation */
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
    /* quota exceeded - graceful degradation */
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
      ...(m.isFcmPreview ? { isFcmPreview: true } : {}),
    } satisfies ChatMessage;
  });
}

/**
 * Makes a replay's durable progress markers (Redis stream cursor + seen ciphertext hashes)
 * persistent. The caller MUST run this only AFTER the encrypted MLS checkpoint has flushed,
 * so durable progress can never move ahead of the durable ratchet state (otherwise a crash
 * would skip messages whose ratchet advance was lost, forcing a costly re-add).
 */
export type MlsReplayCommit = () => void;

/**
 * Replays stored ciphertext messages for a conversation: decrypts them via a paged MLS
 * decrypt session, writes the results to local DB and the reactive conversation state.
 *
 * Decryption advances the MLS ratchet but this function does NOT persist progress markers
 * itself. It returns a {@link MlsReplayCommit} thunk (or `undefined` if there is nothing to
 * commit / on failure); the caller runs the thunk after the bulk-ingest window has flushed
 * the encrypted checkpoint. Wrap calls in {@link withMlsBulkIngest} to drive that flush.
 */
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
  /** First page already fetched (e.g. login batch history) — skipped on the first loop iteration. */
  primedFirstPage?: HistoryStreamRow[];
}): Promise<MlsReplayCommit | undefined> {
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
    primedFirstPage,
  } = params;

  let session: MlsDecryptSession | null = null;
  try {
    // Incremental fetch: only retrieve messages after the last processed stream ID.
    // This avoids re-delivering messages whose ratchet keys have already been consumed
    // (which would produce TooDistantInThePast / CiphertextGenerationOutOfBounds errors).
    // Fix #7: If DB was cleared (e.g. browser storage wipe) without clearing localStorage,
    // the cursor points past messages that no longer exist locally. Reset it so the full
    // history is re-fetched.
    let afterStreamId = loadLastStreamId(userId, id);
    const cursorBeforeDbCheck = afterStreamId;
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
    let fetchCursor = afterStreamId;
    let fetchedAnyPage = false;

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
    // Les champs reactions/readBy/isDeleted/isEdited sont optionnels et proviennent
    // uniquement du chemin history_bundle (migration) - AddMessageToChatOptions ne
    // les inclut pas car addMessageToChat n'en a pas besoin (les mutations arrivent
    // via des events MLS séparés pendant une session normale).
    const pendingMessages: PendingHistoryMessage[] = [];
    let historyIngestSeq = 0;
    /** Queues a decoded message into the page batch (assigns ingest order, bumps the count). */
    const pushPendingMessage = (entry: Omit<PendingHistoryMessage, 'ingestSequence'>): void => {
      pendingMessages.push({ ...entry, ingestSequence: historyIngestSeq++ });
      addedMsg++;
    };

    // Paged decrypt session: the ratchet advances worker-side across pages and is committed
    // to the live client once by session.finish() (run in the outer `finally`, always).
    session = await mlsService.createDecryptSession(id);

    // Batch login may have prefetched with a cursor we just invalidated (DB wipe).
    let pendingPrimedPage: HistoryStreamRow[] | undefined =
      cursorBeforeDbCheck && !afterStreamId ? undefined : primedFirstPage;
    let prefetchedNextPage: Promise<HistoryStreamRow[]> | null = null;

    while (true) {
      let history: HistoryStreamRow[];
      if (pendingPrimedPage !== undefined) {
        history = pendingPrimedPage;
        pendingPrimedPage = undefined;
      } else if (prefetchedNextPage) {
        history = await prefetchedNextPage;
        prefetchedNextPage = null;
      } else {
        history = await mlsService.fetchHistory(id, fetchCursor);
      }
      if (history.length === 0) {
        break;
      }
      fetchedAnyPage = true;

      const pageLastId = history[history.length - 1]?.id;
      const hasMore = Boolean(pageLastId && pageLastId !== fetchCursor);
      if (hasMore && pageLastId) {
        prefetchedNextPage = mlsService.fetchHistory(id, pageLastId);
      }

      const pageDecryptWork: Array<{
        msg: (typeof history)[number];
        cipherFingerprint: string;
        bytes: Uint8Array;
      }> = [];

      for (const msg of history) {
        const cipherFingerprint = msg.id || `${msg.timestamp}:${msg.content.slice(0, 64)}`;
        if (seenCipherHashes.has(cipherFingerprint)) {
          if (msg.id && (!latestStreamId || msg.id > latestStreamId)) {
            latestStreamId = msg.id;
          }
          continue;
        }
        pageDecryptWork.push({
          msg,
          cipherFingerprint,
          bytes: fromBase64(msg.content),
        });
      }

      const batchResults =
        pageDecryptWork.length > 0
          ? await session.decryptPage(pageDecryptWork.map((w) => w.bytes))
          : [];

      for (let workIdx = 0; workIdx < pageDecryptWork.length; workIdx++) {
        const { msg, cipherFingerprint } = pageDecryptWork[workIdx];
        const batchResult = batchResults[workIdx];

        // False = epoch/ratchet gap - recoverable after resync, must not be permanently skipped.
        let skipSeenHash = false;
        let advanceStreamCursor = false;
        try {
          if (!batchResult.ok) {
            throw new Error(batchResult.error);
          }
          const decryptedBytes = batchResult.plaintext;
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
            const updated = addMessageReaction(reactions, senderNorm, emoji);
            if (!updated) continue; // déjà présente ou cap atteint - no-op
            messageReactions.set(messageId, updated);
            reactionUpdates.set(messageId, updated);
            mlsUpdated = true;
            continue;
          } else if (parsed?.system) {
            await applyReplaySystemEvent({
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
            });
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
            // Non-recoverable - mark as seen to avoid infinite reprocessing.
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            continue;
          }
          if (errStr.includes('GAP_QUEUED')) {
            // Recoverable epoch/ratchet gap: do NOT mark as seen so the entry is
            // retried on the next history load after epoch resync.
            skipSeenHash = true;
            console.warn(`[History] GAP_QUEUED retryable: ${errStr.slice(0, 200)}`);
          } else {
            console.warn(`History msg error: ${err}`);
          }
        } finally {
          if (!skipSeenHash) {
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            advanceStreamCursor = true;
          }
        }

        if (advanceStreamCursor && msg.id && (!latestStreamId || msg.id > latestStreamId)) {
          latestStreamId = msg.id;
        }

        if (workIdx > 0 && workIdx % 8 === 0) {
          await yieldToMainThread();
        }
      }

      // Cursor + seen hashes are NOT persisted per page here: they are deferred to the
      // returned commit thunk so they only become durable after the encrypted checkpoint.
      if (!hasMore) break;
      fetchCursor = pageLastId!;
    }

    // Flush all decoded messages in a single batch DB write.
    if (pendingMessages.length > 0 && storage) {
      // Load existing DB state before the upsert so we can preserve isDeleted / isEdited
      // flags that were set by events already in seenCipherHashes (and therefore not
      // re-processed in this replay run).  Without this, saveMessages(store.put) would
      // overwrite a backup-imported deleted row with the original non-deleted content.
      const existingById = new Map<string, StoredMessage>();
      try {
        for (const m of await storage.getMessages(id, pin)) {
          existingById.set(m.id, m);
        }
      } catch {
        // Non-blocking: if the read fails we proceed without preservation (best-effort).
      }

      const toStore: StoredMessage[] = pendingMessages.map((pm) => {
        const msgId = normalizeMessageId(pm.messageId) ?? crypto.randomUUID();
        const prev = existingById.get(msgId);
        return {
          id: msgId,
          conversationId: id,
          senderId: pm.senderId.toLowerCase(),
          // Preserve deleted/edited content from DB if the mutation event was already
          // processed in a prior run and is now in seenCipherHashes.
          // prev.isDeleted/isEdited : état d'une run précédente (seenCipherHashes).
          // pm.isDeleted/isEdited   : état transmis par le history_bundle.
          // Les deux sources sont combinées pour que les nouvelles installations
          // reflètent les suppressions/éditions sans avoir rejoué les events MLS.
          content:
            prev?.isDeleted || pm.isDeleted
              ? 'Ce message a été supprimé.'
              : prev?.isEdited
                ? prev.content
                : pm.content,
          timestamp: resolveMessageTimestamp(pm, [], isOwnMessage(pm.senderId, userId)).getTime(),
          ...(pm.isSystem
            ? { readBy: [] }
            : (pm.readBy ?? []).length > 0
              ? { readBy: pm.readBy }
              : {}),
          ...(prev?.isDeleted || pm.isDeleted ? { isDeleted: true } : {}),
          ...(prev?.isEdited || pm.isEdited ? { isEdited: true } : {}),
          ...((pm.reactions ?? []).length > 0 ? { reactions: pm.reactions } : {}),
          ...(pm.serverTimestamp != null ? { serverTimestamp: pm.serverTimestamp } : {}),
          ...(pm.readAt != null ? { readAt: pm.readAt } : {}),
        };
      });
      await storage.saveMessages(toStore, pin);
    }

    // Single post-save read: apply readBy, reaction, delete/edit mutations in one pass.
    // All three update types need the post-batch-save DB state and touch independent fields,
    // so they can be merged and written back in a single saveMessages call.
    const needsPostUpdate =
      storage &&
      (readReceiptDbUpdates.length > 0 ||
        reactionUpdates.size > 0 ||
        deletedMessageIds.size > 0 ||
        editedMessages.size > 0);
    if (needsPostUpdate) {
      try {
        const allMessages = await storage!.getMessages(id, pin);
        // Collect all mutations keyed by message ID, merging updates for the same message.
        const updatesById = new Map<string, StoredMessage>();

        for (const { msgId, senderNorm, readAt } of readReceiptDbUpdates) {
          const base = updatesById.get(msgId) ?? allMessages.find((x) => x.id === msgId);
          if (base) {
            const cur = updatesById.get(msgId) ?? base;
            const readBy = cur.readBy ?? [];
            if (!readBy.includes(senderNorm)) {
              updatesById.set(msgId, {
                ...cur,
                readBy: [...readBy, senderNorm],
                ...(readAt != null && cur.readAt == null ? { readAt } : {}),
              });
            }
          }
        }

        for (const m of allMessages) {
          if (reactionUpdates.has(m.id)) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              reactions: reactionUpdates.get(m.id),
            });
          }
          if (deletedMessageIds.has(m.id)) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isDeleted: true,
              content: 'Ce message a été supprimé.',
            });
          } else if (editedMessages.has(m.id)) {
            const edit = editedMessages.get(m.id)!;
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isEdited: true,
              content: edit.content,
            });
          }
        }

        const toUpdate = [...updatesById.values()];
        if (toUpdate.length > 0) {
          await storage!.saveMessages(toUpdate, pin);
        }
      } catch {
        // Non-blocking
      }
    }

    if (mlsUpdated) {
      log(`[OK] ${addedMsg} msg rattrapes pour ${contactName}.`);
    }

    if (!fetchedAnyPage) return undefined;

    // Durable progress is committed by the caller AFTER the encrypted checkpoint flush,
    // so the stream cursor / seen hashes never run ahead of the persisted ratchet state.
    return () => {
      if (latestStreamId) saveLastStreamId(userId, id, latestStreamId);
      if (seenUpdated) saveSeenCipherHashes(userId, id, seenCipherHashes);
    };
  } catch (err) {
    // Non-blocking: log the error and continue so other conversations still load
    log(
      `[WARN] Echec replay historique pour ${contactName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  } finally {
    // Commit the accumulated ratchet to the live client and release the worker / mutex.
    await session?.finish();
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
