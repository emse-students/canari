import type { HistoryStreamRow } from '$lib/mls-client/historyTypes';
import { fromBase64 } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ChatMessage, Conversation, MessageReaction, ReadWatermarks } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { MlsDecryptSession } from '$lib/mls-client/mlsDecryptSession';
import {
  applyReplaySystemEvent,
  replayMutationIsAuthorised,
  type PendingHistoryMessage,
} from './historySystemEvents';
import { decodeAppMessage } from '$lib/proto/codec';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import {
  appMsgToEnvelope,
  isOwnMessage,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import { classifyIncomingDecryptError } from '$lib/mls-client/mlsDecryptError';
import { markEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { reconcileGroup } from '$lib/utils/chat/historyReconcile';
import { readStoredTimestampMs, toValidDate } from '$lib/utils/dates';
import { normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import { mergeReadWatermarks } from '$lib/utils/chat/readState';
import { mergeHistoryFloor } from '$lib/utils/chat/historyWindow';

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

/**
 * ONE set per (user, group), shared by the archive replay and by live delivery.
 *
 * The sharing is a CORRECTNESS requirement, not a saved parse. The replay loads this set when it
 * starts, mutates it for the whole walk, and writes it back once at the end. A live mark that went
 * straight to localStorage would therefore be erased by that final write - made from a copy taken
 * before the mark existed - and the false loss it exists to prevent would return at the next
 * reload, unchanged. Two writers and one durable slot is last-write-wins; the only fix is that
 * there be one object.
 */
const seenCache = new Map<string, Set<string>>();

/** Load the set of already-seen ciphertext fingerprints for a group, hydrating the shared cache once. */
function loadSeenCipherHashes(userId: string, groupId: string): Set<string> {
  const cacheKey = seenHistoryKey(userId, groupId);
  const cached = seenCache.get(cacheKey);
  if (cached) return cached;
  let hydrated: Set<string>;
  try {
    hydrated = new Set(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
  } catch {
    hydrated = new Set();
  }
  seenCache.set(cacheKey, hydrated);
  return hydrated;
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

/** Groups whose shared set holds marks not yet written, drained once at the end of the current tick. */
const pendingSeenFlush = new Map<string, { userId: string; groupId: string }>();
let seenFlushScheduled = false;

/**
 * Persist the marks accumulated on THIS tick, one write per group.
 *
 * A microtask, never a timer. It is not a delay hoping more marks turn up - it is the end of the
 * current turn, so a drain handing over forty frames pays one `JSON.stringify` instead of forty
 * over a set capped at five thousand entries, and a lone frame is still written before anything can
 * observe the gap. Nothing is load-bearing if it ran late anyway: the in-memory set is already
 * correct the instant the mark is added, and the write only has to survive a reload.
 */
function scheduleSeenFlush(userId: string, groupId: string): void {
  pendingSeenFlush.set(seenHistoryKey(userId, groupId), { userId, groupId });
  if (seenFlushScheduled) return;
  seenFlushScheduled = true;
  queueMicrotask(() => {
    seenFlushScheduled = false;
    const due = [...pendingSeenFlush.values()];
    pendingSeenFlush.clear();
    for (const entry of due) {
      const set = seenCache.get(seenHistoryKey(entry.userId, entry.groupId));
      if (set) saveSeenCipherHashes(entry.userId, entry.groupId, set);
    }
  });
}

/**
 * Record that this device has CONSUMED a frame's ratchet generation outside the archive replay.
 *
 * Live delivery and the queue drain both decrypt frames the shared archive also holds, and neither
 * moves this device's position in that archive. The replay later walks the same row, finds a
 * generation already spent, and reports it as real loss - for a message the device received
 * perfectly, displayed, and still holds. That is a false alarm on the one signal that must never
 * cry wolf, and on prod it fired on every device's own ordinary traffic.
 *
 * The mark is keyed on the frame's BYTES because they are the only thing the two paths share: an
 * archive row is addressed by a Redis stream id, a live envelope by a `queued_message` uuid, and
 * the two namespaces never intersect - the server discards the stream id at write time. The
 * ciphertext does intersect: the SAME string is written to the stream and published in the
 * envelope, with no re-encoding anywhere between them.
 *
 * NOT called from the Android background decrypt. That path loads a throwaway copy of the state and
 * never writes `mls.bin` back (`src-tauri/src/mobile/background.rs`), so the foreground genuinely
 * does read the frame again from its queue; marking it consumed there would skip a message that
 * nobody has read.
 */
export function markHistoryFrameConsumed(
  userId: string,
  groupId: string,
  fingerprint: string
): void {
  if (!userId || !groupId) return;
  const seen = loadSeenCipherHashes(userId, groupId);
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  scheduleSeenFlush(userId, groupId);
}

/**
 * Has this device already consumed this exact ciphertext, in ANY session?
 *
 * The mirror of {@link markHistoryFrameConsumed}, and it exists because the ledger was one-way.
 * Live delivery told the replay what it had consumed; the replay told live delivery nothing, so a
 * frame the replay had just decrypted arrived live moments later, found a spent generation, and was
 * reported as a LOST frame for a message this device was already displaying (WP-FALSELOSS-2,
 * measured on prod 2026-08-13: three MSG checks dirty, `copiesOnReceiver: 1` in the very record
 * carrying the loss).
 *
 * The in-memory ring (`hasFrameBeenProcessed`) cannot answer this. It holds 200 frames per group and
 * dies with the page, so it can only speak for what THIS session delivered live - and a consumption
 * made by the replay, or by any earlier session, is invisible to it by construction. This set is the
 * durable half, keyed on the frame's bytes for the reason spelt out above: the two paths share no
 * identifier, only the ciphertext.
 */
export function hasHistoryFrameBeenConsumed(
  userId: string,
  groupId: string,
  fingerprint: string
): boolean {
  if (!userId || !groupId) return false;
  return loadSeenCipherHashes(userId, groupId).has(fingerprint);
}

/** @internal Drops the shared sets between Vitest cases, so one case cannot answer another's question. */
export function resetSeenCipherCacheForTests(): void {
  seenCache.clear();
  pendingSeenFlush.clear();
  seenFlushScheduled = false;
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
      reactions: m.reactions,
      serverTimestamp: m.serverTimestamp,
      ...(m.isDeleted ? { isDeleted: true } : {}),
      ...(m.isEdited ? { isEdited: true } : {}),
      ...(m.editedAt ? { editedAt: toValidDate(m.editedAt) } : {}),
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
  deviceKeyB64: string;
  /** Write decrypted messages directly to local DB (DB-first architecture). */
  storage: IStorage | null;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  /** Persists the conversation's metadata row - which is where the read watermarks live. */
  saveConversation?: (contactName: string) => Promise<void>;
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
    deviceKeyB64,
    storage,
    getConversation,
    setConversation,
    saveConversation,
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
  /**
   * A frame in this replay will never be readable here, so a peer has to re-encrypt it. Carried to
   * the end of the replay rather than acted on where it is discovered: a page can hold forty such
   * frames and they are all one difference.
   */
  let sawUnreadableFrame = false;

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
        const storedMsgs = await storage.getMessages(id, deviceKeyB64);
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

    /**
     * Move this device's position past a row the replay does not need to decrypt.
     *
     * Monotonic and row-by-row on purpose: the cursor only ever advances over entries actually
     * walked, in stream order, so it can never JUMP over a frame that is genuinely missing. That is
     * why "consuming a frame live advances the archive position" is implemented as a mark plus this
     * walk rather than as a direct write of the cursor - a frame delivered live while an earlier one
     * had already fallen out of the server queue would otherwise carry the cursor past a real hole,
     * and turn a repairable gap into a permanent one.
     */
    const advancePast = (rowId?: string): void => {
      if (rowId && (!latestStreamId || rowId > latestStreamId)) latestStreamId = rowId;
    };

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
    // Each carries WHO claims the mutation: the author check needs the stored row, which is only
    // read after the batch save.
    const deletedMessages = new Map<string, { by: string }>();
    const editedMessages = new Map<string, { content: string; editedAt: Date; by: string }>();
    // Read state accumulated over the whole page: one instant per participant, merged as `max`,
    // applied to the conversation once at the end. It is conversation-level state, so it is not
    // affected by the batch save below at all - which is exactly what made the per-message version
    // fragile enough to need a repair pass of its own.
    const readWatermarkUpdates: ReadWatermarks = {};
    // The shared history floor the page carried, merged the same way and applied in the same write.
    // A box rather than a number, because the handler that fills it cannot reassign a local.
    const historyFloorUpdate = { at: 0 };

    // Batch-collect decoded messages to flush in one UI update at the end.
    // The reactions/isDeleted/isEdited fields are optional and come only from the
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
          advancePast(msg.id);
          continue;
        }
        const bytes = fromBase64(msg.content);
        // Consumed already by live delivery or by the queue drain, which read this frame without
        // ever touching this cursor. Recognised by its bytes - `markHistoryFrameConsumed` says why
        // no identifier is shared between the two paths. Folded into the stream-id key on first
        // sight, so every later replay answers from the cheap check above and the position keeps
        // moving past it without decoding anything.
        if (seenCipherHashes.has(frameFingerprint(bytes))) {
          seenCipherHashes.add(cipherFingerprint);
          seenUpdated = true;
          advancePast(msg.id);
          continue;
        }
        pageDecryptWork.push({ msg, cipherFingerprint, bytes });
      }

      const batchResults =
        pageDecryptWork.length > 0
          ? await session.decryptPage(pageDecryptWork.map((w) => w.bytes))
          : [];

      for (let workIdx = 0; workIdx < pageDecryptWork.length; workIdx++) {
        const { msg, cipherFingerprint, bytes } = pageDecryptWork[workIdx];
        const batchResult = batchResults[workIdx];

        // False = epoch/ratchet gap - recoverable after resync, must not be permanently skipped.
        let skipSeenHash = false;
        let advanceStreamCursor = false;
        try {
          if (!batchResult.ok) {
            throw new Error(batchResult.error);
          }
          /**
           * THE GENERATION IS SPENT AS OF THIS LINE, AND LIVE DELIVERY HAS TO BE ABLE TO LEARN IT.
           *
           * The stream id written in the `finally` below says "the replay is past this ROW", which
           * no live frame can ever look itself up by - the two namespaces never intersect. So the
           * bytes are marked here as well, exactly as `markHistoryFrameConsumed` marks them coming
           * the other way. Without it the ledger was one-directional: a frame the replay decrypted
           * arrived live a moment later, `handleUnreadableFrame` found nothing in either place it
           * could look, and a message already on screen was reported LOST and reconciled for
           * (WP-FALSELOSS-2).
           *
           * Placed on the SUCCESS path only, and that is the whole safety argument. A frame that
           * failed to decrypt did not consume anything, and claiming it here would tell live
           * delivery "I have read this" about a frame nobody has read - which is the one mistake
           * that turns a real loss silent. The give-up branches below therefore mark the row, never
           * the bytes.
           */
          seenCipherHashes.add(frameFingerprint(bytes));
          seenUpdated = true;
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
            // Replay applies both legs: the frame carries `removed`, and the merge is ordered by
            // `at` rather than by the position the entry happens to hold in the stream.
            const updated = applyReaction(
              reactions,
              senderNorm,
              emoji,
              Number(parsed.reaction.at ?? 0),
              parsed.reaction.removed === true
            );
            if (!updated) continue; // already held something at least as recent - no-op
            messageReactions.set(messageId, updated);
            reactionUpdates.set(messageId, updated);
            mlsUpdated = true;
            continue;
          } else if (parsed?.system) {
            await applyReplaySystemEvent({
              parsed,
              msg,
              contactName,
              userId,
              getConversation,
              setConversation,
              messageReactions,
              reactionUpdates,
              deletedMessages,
              editedMessages,
              readWatermarkUpdates,
              historyFloorUpdate,
              pushPendingMessage,
            });
            mlsUpdated = true;
            continue;
          }
        } catch (err) {
          const kind = classifyIncomingDecryptError(err);
          if (kind === 'own-message') {
            // MLS gives no echo of our own message; there is nothing to read and nothing is lost.
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            continue;
          }
          if (kind === 'secret-reuse' || kind === 'past-epoch-application') {
            // Unreadable for good, at one end of the ratchet or the other: the generation is spent
            // (`secret-reuse`), or the epoch's secrets are gone (`past-epoch-application`, what a
            // re-joined group holds for everything sent before the join). Either way the frame will
            // never decrypt - mark it seen or the replay reprocesses it forever.
            //
            // But WHICH message it was is the whole question, and this is the one place that holds
            // the evidence to answer it: a frame already read carries a fingerprint in
            // `seenCipherHashes` and is skipped before ever reaching the decrypt, so anything
            // arriving HERE is a frame this device has never read. That is real loss, and a
            // reconciliation is the only thing that can recover it. A false positive costs exactly
            // one comparison, which is what makes reconciling on suspicion safe.
            seenCipherHashes.add(cipherFingerprint);
            seenUpdated = true;
            sawUnreadableFrame = true;
            console.warn(
              `[History] frame never read here and unreadable for good (${kind}); will reconcile (group ${id})`
            );
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
              // This is the ONLY moment the app learns that history is genuinely missing rather
              // than merely late: a frame we saw, will never read, and can only obtain re-encrypted
              // from a member. The frame itself is about to be consumed and will never fail again
              // to remind us, so the replay carries the fact to its own end and reconciles there -
              // once for the whole page, whatever the number of dead frames in it.
              sawUnreadableFrame = true;
              console.warn(
                `[History] permanently undecryptable after ${attempts} attempts (${kind}); marking seen and reconciling`
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
        for (const m of await storage.getMessages(id, deviceKeyB64)) {
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
          // No lookup: this path builds rows from the bundle, and what we already hold is read from
          // `prev` above rather than searched for.
          timestamp: resolveMessageTimestamp(
            pm,
            () => undefined,
            isOwnMessage(pm.senderId, userId)
          ).getTime(),
          ...(prev?.isDeleted || pm.isDeleted ? { isDeleted: true } : {}),
          ...(prev?.isEdited || pm.isEdited ? { isEdited: true } : {}),
          // Same two sources as `content` above. What we already hold wins - it came from the edit
          // event itself - and the bundle supplies it on a fresh install, which has no row to
          // preserve it from and would otherwise show "edited" with no time for ever.
          ...(prev?.editedAt || pm.editedAt ? { editedAt: prev?.editedAt ?? pm.editedAt } : {}),
          ...((pm.reactions ?? []).length > 0 ? { reactions: pm.reactions } : {}),
          ...(pm.serverTimestamp != null ? { serverTimestamp: pm.serverTimestamp } : {}),
        };
      });
      await storage.saveMessages(toStore, deviceKeyB64);
    }

    // The conversation-level state the page carried - read watermarks and the shared floor - applied
    // in one step. Neither is part of the message pass below and neither ever was a per-message
    // concern: what they cost is one entry per participant, whether the page held ten messages or
    // ten thousand.
    const convoForRead = getConversation(contactName);
    if (convoForRead) {
      const mergedWatermarks = mergeReadWatermarks(
        convoForRead.readWatermarks,
        readWatermarkUpdates
      );
      const mergedFloor = mergeHistoryFloor(convoForRead.historyFloor, historyFloorUpdate.at);
      if (mergedWatermarks || mergedFloor !== null) {
        setConversation(contactName, {
          ...convoForRead,
          ...(mergedWatermarks ? { readWatermarks: mergedWatermarks } : {}),
          ...(mergedFloor !== null ? { historyFloor: mergedFloor } : {}),
        });
        await saveConversation?.(contactName).catch(() => {});
      }
    }

    // Single post-save read: apply reaction and delete/edit mutations in one pass.
    // All of them need the post-batch-save DB state and touch independent fields,
    // so they can be merged and written back in a single saveMessages call.
    const needsPostUpdate =
      storage && (reactionUpdates.size > 0 || deletedMessages.size > 0 || editedMessages.size > 0);
    if (needsPostUpdate) {
      try {
        const allMessages = await storage!.getMessages(id, deviceKeyB64);
        // Collect all mutations keyed by message ID, merging updates for the same message.
        const updatesById = new Map<string, StoredMessage>();

        for (const m of allMessages) {
          if (reactionUpdates.has(m.id)) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              reactions: reactionUpdates.get(m.id),
            });
          }
          // The stored row is the first place the author is known for a mutation whose message was
          // not in memory when the event was replayed, so the claim is checked HERE too - not only
          // in `applyReplaySystemEvent`.
          const deletion = deletedMessages.get(m.id);
          const edit = editedMessages.get(m.id);
          if (deletion && replayMutationIsAuthorised(m, deletion.by, 'delete')) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isDeleted: true,
              content: chat_system_message_deleted(),
            });
          } else if (edit && replayMutationIsAuthorised(m, edit.by, 'edit')) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isEdited: true,
              content: edit.content,
              editedAt: edit.editedAt.getTime(),
            });
          }
        }

        const toUpdate = [...updatesById.values()];
        if (toUpdate.length > 0) {
          await storage!.saveMessages(toUpdate, deviceKeyB64);
        }
      } catch {
        // Non-blocking
      }
    }

    if (mlsUpdated) {
      log(`[OK] ${addedMsg} message(s) caught up for ${contactName}.`);
    }

    // Stale-behind: replay hit an epoch gap for a locally-held group and our epoch did NOT
    // advance (no catch-up commit applied). The local state is forked behind the server, but no
    // live frame will arrive to trigger the reactive escalation - register the gap so the sync
    // watchdog forces forget + re-Welcome. Without this a quiet stale group stays empty forever.
    if (shouldFlagStaleEpochGap(groupWasLocal, sawEpochGap, epochBefore, mlsService.getEpoch(id))) {
      markEpochGap(id);
      log(`[HISTORY] ${id.slice(0, 8)}… epoch gap during replay - flagged for recovery`);
    }

    // Something in this replay is lost to this device for good. Ask a peer that still holds it -
    // once, now that the whole page has been walked and the store is settled.
    if (sawUnreadableFrame) {
      log(`[HISTORY] ${id.slice(0, 8)}… holds frames it can never read - reconciling`);
      void reconcileGroup(mlsService, id, log);
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
  deviceKeyB64: string
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
        reactions: m.reactions,
        ...(m.isDeleted ? { isDeleted: true } : {}),
        ...(m.isEdited ? { isEdited: true } : {}),
      }));
    if (toSave.length > 0) storage.saveMessages(toSave, deviceKeyB64).catch(() => {});
  }

  return updated;
}
