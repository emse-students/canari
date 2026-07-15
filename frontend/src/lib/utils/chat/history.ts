import type { HistoryStreamRow } from '$lib/mls-client/historyTypes';
import { fromBase64 } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ChatMessage, Conversation, MessageReaction } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { MlsDecryptSession } from '$lib/mls-client/mlsDecryptSession';
import { applyReplaySystemEvent, type PendingHistoryMessage } from './historySystemEvents';
import { decodeAppMessage } from '$lib/proto/codec';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import {
  appMsgToEnvelope,
  isOwnMessage,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { classifyIncomingDecryptError } from '$lib/mls-client/mlsDecryptError';
import { markEpochGap } from '$lib/utils/chat/epochGapRegistry';
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

/** Return the localStorage key used to persist per-ciphertext retry counters for undecryptable history frames. */
function retryCipherKey(userId: string, groupId: string): string {
  return `history_retry_cipher:${userId}:${groupId}`;
}

/**
 * Max number of separate replay runs an `epoch-gap` / `wrong-epoch` history frame may stay
 * un-seen (retryable) before it is treated as permanently undecryptable and consumed. Bounds the
 * per-sync refetch storm caused by frames that no epoch catch-up can ever resolve (an external
 * joiner's pre-join / forked-epoch ciphertexts) while still leaving room for a genuinely transient
 * gap to heal across a few reconnects. [[M2]]
 */
const MAX_HISTORY_DECRYPT_RETRIES = 6;

/**
 * Decides how a recoverable history decrypt failure (`epoch-gap` / `wrong-epoch`) should be
 * handled given how many prior replay runs already left this exact ciphertext un-seen. Returns
 * the incremented attempt count and whether the frame should stay retryable (`retry: true` -> keep
 * it un-seen so a later epoch catch-up can decrypt it) or be given up on (`retry: false` -> mark it
 * seen to stop the per-sync refetch storm from a frame no catch-up can ever resolve). [[M2]]
 */
export function nextHistoryRetryDecision(priorAttempts: number): {
  attempts: number;
  retry: boolean;
} {
  const attempts = priorAttempts + 1;
  return { attempts, retry: attempts < MAX_HISTORY_DECRYPT_RETRIES };
}

/** Load the per-ciphertext retry counters from localStorage (fingerprint -> failed-replay count). */
function loadRetryCipherCounts(userId: string, groupId: string): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(retryCipherKey(userId, groupId)) ?? '[]');
    return new Map(Array.isArray(raw) ? raw : []);
  } catch {
    return new Map();
  }
}

/** Persist the retry counters, capped at 2 000 entries (keeps the most-recently-touched) to bound growth. */
function saveRetryCipherCounts(userId: string, groupId: string, counts: Map<string, number>): void {
  const MAX_ENTRIES = 2000;
  const entries = [...counts.entries()];
  const bounded =
    entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  try {
    if (bounded.length === 0) {
      localStorage.removeItem(retryCipherKey(userId, groupId));
    } else {
      localStorage.setItem(retryCipherKey(userId, groupId), JSON.stringify(bounded));
    }
  } catch {
    /* quota exceeded - graceful degradation */
  }
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
/**
 * Decides whether a history replay run should flag a group as forked-behind (stale epoch gap).
 * True only when the group is held locally, replay hit an `epoch-gap` (missing commit), and the
 * local epoch did NOT advance during the replay (no catch-up commit resolved it). A transient gap
 * fixed by a commit in the same run must not be flagged, or a healthy group catching up would be
 * needlessly forgotten + re-Welcomed (churn).
 */
export function shouldFlagStaleEpochGap(
  groupWasLocal: boolean,
  sawEpochGap: boolean,
  epochBefore: number,
  epochAfter: number
): boolean {
  return groupWasLocal && sawEpochGap && epochAfter === epochBefore;
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

  // Stale-behind detection: a group present in local WASM whose replay hits an epoch gap
  // (missing commit) is forked behind the server. We capture the epoch on entry to tell a real
  // gap from a transient one that a catch-up commit resolves during this same replay.
  const groupWasLocal = mlsService.getLocalGroups().includes(id);
  const epochBefore = groupWasLocal ? mlsService.getEpoch(id) : -1;
  let sawEpochGap = false;

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

    // Per-ciphertext retry ledger: how many prior replay runs left this frame un-seen because it
    // failed with a recoverable epoch-gap / wrong-epoch. Bounds the refetch storm from frames no
    // catch-up can ever resolve (external joiner's pre-join / forked-epoch ciphertexts). [[M2]]
    const retryCounts = loadRetryCipherCounts(userId, id);
    let retryUpdated = false;

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
    // The reactions/readBy/isDeleted/isEdited fields are optional and come only from the
    // history_bundle path (migration) - AddMessageToChatOptions does not include them
    // because addMessageToChat does not need them (the mutations arrive via separate MLS
    // events during a normal session).
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
            if (!updated) continue; // already present or cap reached - no-op
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
          const kind = classifyIncomingDecryptError(err);
          if (kind === 'own-message' || kind === 'secret-reuse') {
            // Non-recoverable - mark as seen to avoid infinite reprocessing.
            // (Own message we can't decrypt, or a generation key already consumed/jetee.)
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            continue;
          }
          if (kind === 'epoch-gap' || kind === 'wrong-epoch') {
            // epoch-gap = we are BEHIND (missing a commit). Remember it so we can flag the group
            // for recovery at the end if no catch-up commit advances our epoch in this replay.
            if (kind === 'epoch-gap') sawEpochGap = true;
            const { attempts, retry } = nextHistoryRetryDecision(
              retryCounts.get(cipherFingerprint) ?? 0
            );
            if (retry) {
              // Recoverable: epoch/ratchet gap (epoch-gap), or a frame from an epoch this replay
              // has not reached yet (wrong-epoch - the commit may apply on a later load). Do NOT
              // mark it "seen" so the entry is retried at the next history load after epoch
              // resynchronization. Bounded so it cannot refetch-storm forever. [[M2]]
              skipSeenHash = true;
              retryCounts.set(cipherFingerprint, attempts);
              retryUpdated = true;
              console.warn(
                `[History] retryable ${attempts}/${MAX_HISTORY_DECRYPT_RETRIES} (${kind}): ${String(err).slice(0, 200)}`
              );
            } else {
              // Bounded retries exhausted: no epoch catch-up has resolved this frame across many
              // syncs, so it is permanently undecryptable for us (pre-join / forked epoch). Fall
              // through with skipSeenHash=false so the finally consumes it (marks seen + advances
              // the cursor), stopping the per-sync refetch storm. The `sawEpochGap` flag above
              // still lets shouldFlagStaleEpochGap escalate a genuinely stuck-behind group.
              retryCounts.delete(cipherFingerprint);
              retryUpdated = true;
              console.warn(
                `[History] permanently undecryptable after ${attempts} attempts (${kind}); marking seen`
              );
            }
          } else {
            console.warn(`History msg error: ${err}`);
          }
        } finally {
          if (!skipSeenHash) {
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            advanceStreamCursor = true;
            // Frame resolved (decrypted) or given up on: drop any retry counter so it can never
            // linger and re-trigger a give-up on a later, unrelated cursor position.
            if (retryCounts.delete(cipherFingerprint)) retryUpdated = true;
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
          // prev.isDeleted/isEdited : state from a previous run (seenCipherHashes).
          // pm.isDeleted/isEdited   : state carried by the history_bundle.
          // Both sources are combined so fresh installs reflect the deletions/edits
          // without having replayed the MLS events.
          content:
            prev?.isDeleted || pm.isDeleted
              ? chat_system_message_deleted()
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
              content: chat_system_message_deleted(),
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

    // Stale-behind: replay hit an epoch gap for a locally-held group and our epoch did NOT
    // advance (no catch-up commit applied). The local state is forked behind the server, but no
    // live frame will arrive to trigger the reactive escalation - register the gap so the sync
    // watchdog forces forget + re-Welcome. Without this a quiet stale group stays empty forever.
    if (shouldFlagStaleEpochGap(groupWasLocal, sawEpochGap, epochBefore, mlsService.getEpoch(id))) {
      markEpochGap(id);
      log(`[HISTORY] ${id.slice(0, 8)}… epoch gap during replay - flagged for recovery`);
    }

    if (!fetchedAnyPage) return undefined;

    // Durable progress is committed by the caller AFTER the encrypted checkpoint flush,
    // so the stream cursor / seen hashes never run ahead of the persisted ratchet state.
    return () => {
      if (latestStreamId) saveLastStreamId(userId, id, latestStreamId);
      if (seenUpdated) saveSeenCipherHashes(userId, id, seenCipherHashes);
      if (retryUpdated) saveRetryCipherCounts(userId, id, retryCounts);
    };
  } catch (err) {
    // Non-blocking: log the error and continue so other conversations still load
    log(
      `[WARN] History replay failed for ${contactName}: ${err instanceof Error ? err.message : String(err)}`
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
 * content (e.g. "abc…def added xyz…uvw to the group") that were stored before
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
