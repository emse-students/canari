/**
 * The seams between the live handlers, the message writers and the store of mutations whose message
 * is not here yet (`pendingMutations.ts` says what they are and why they are kept apart).
 *
 * **NO READ-THEN-WRITE GAP, FROM EITHER SIDE.** A mutation handler looks for its target, finds none,
 * and keeps the entry; a writer reads the entries, writes the body, and removes them. Interleaved, the
 * handler could keep its entry just after the writer read, and the entry would wait for a body that
 * had already landed. So each side WRITES FIRST AND LOOKS SECOND: the handler re-reads the target
 * after keeping the entry ({@link keepPendingMutation}), and the writer re-reads the entries after
 * writing the body ({@link settlePendingFor}). Whichever write lands second, its own look sees the
 * other's, so an entry is always settled by one of the two - and settling twice changes nothing,
 * because a deletion is final, an edit applies only over an older one and a reaction only over an
 * older state of the same pair. Each entry is removed only at the rank it was read at
 * (`deletePendingMutations`), so a newer one kept meanwhile survives the removal of an older.
 */
import type { Conversation, ChatMessage, MessageReaction } from '$lib/types';
import type { IStorage, PendingMutation, StoredMessagePatch } from '$lib/db/types';
import { mergeStoredMessage } from '$lib/db/messagePayload';
import {
  PENDING_MUTATION_LIMITS,
  settleAgainstPending,
  type SettledFields,
  type Settlement,
  type SettleTarget,
} from './pendingMutations';

/** A keyed slot read and written whole - a `SvelteMap`, or the archive replay's accessors. */
export interface KeyedSlots<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): unknown;
}

/** What keeping and settling an entry reads and writes. */
export interface PendingMutationDeps {
  storage: IStorage | null;
  deviceKey: () => string;
  conversations: KeyedSlots<Conversation>;
  /** What the screen draws a message's reactions from. */
  messageReactions: KeyedSlots<MessageReaction[]>;
  log: (msg: string) => void;
}

/** A short id for a log line. */
const short = (id: string) => id.slice(0, 8);

/** Entries the bounds evicted so far in this session, per conversation (see {@link countEvictions}). */
const evictedSoFar = new Map<string, number>();

/** The largest power of two at or below `n` (0 for 0). */
const powerFloor = (n: number) => (n <= 0 ? 0 : 2 ** (31 - Math.clz32(n)));

/**
 * Counts `n` evictions in `conversationId` and says so at warn each time the session's total for it
 * reaches a new power of two (1, 2, 4, 8, ...): a flood is visible, with its size, in a handful of
 * lines - never one line per put, which is the noise that hides the next defect.
 */
function countEvictions(conversationId: string, n: number): void {
  const before = evictedSoFar.get(conversationId) ?? 0;
  const after = before + n;
  evictedSoFar.set(conversationId, after);
  if (powerFloor(after) === powerFloor(before)) return;
  console.warn(
    `[PENDING] ${short(conversationId)}... is over its bounds of mutations awaiting their message (${PENDING_MUTATION_LIMITS.perSender} per sender, ${PENDING_MUTATION_LIMITS.perConversation} in all) - ${after} evicted this session, reactions first, then the oldest`
  );
}

/**
 * Keeps `entry`, whose target is neither shown nor stored, then looks for the target once more - it
 * may have been written between the caller's look and this write - and settles it if it is there.
 *
 * `frameAt` is the frame's SERVER time, the order the store evicts in. A frame with none is not kept
 * (no delivery route of this build omits it, so reaching that branch is a defect upstream, said at
 * error), and neither is one older than the conversation's shared history floor: nothing below the
 * floor is ever answered, so its message can never arrive.
 */
export async function keepPendingMutation(
  deps: PendingMutationDeps,
  entry: Omit<PendingMutation, 'at'>,
  frameAt: number | undefined
): Promise<void> {
  const { storage, deviceKey, conversations, log } = deps;
  const what = `${entry.kind} of ${short(entry.messageId)} by ${short(entry.sender)}`;
  if (frameAt === undefined || !Number.isFinite(frameAt)) {
    console.error(
      `[PENDING] ${what} arrived before its message with no server time - nothing orders it in the store, not kept`
    );
    return;
  }
  const floor = conversations.get(entry.conversationId)?.historyFloor ?? 0;
  if (frameAt < floor) {
    log(`[PENDING] ${what} predates the history floor - its message can never arrive, not kept`);
    return;
  }
  if (!storage) {
    // Every inbound path of this build runs with a store; one without has nowhere to keep it.
    console.error(`[PENDING] ${what} arrived before its message and there is no store to keep it`);
    return;
  }
  let write;
  try {
    write = await storage.putPendingMutation(
      { ...entry, at: frameAt },
      PENDING_MUTATION_LIMITS,
      deviceKey()
    );
  } catch (e) {
    console.error(`[PENDING] ${what} arrived before its message and could not be kept:`, e);
    return;
  }
  if (write.evicted > 0) countEvictions(entry.conversationId, write.evicted);
  log(
    !write.written
      ? `[PENDING] ${what} arrived before its message - a later one of the same sender is already kept`
      : write.kept
        ? `[PENDING] ${what} arrived before its message - kept for it`
        : `[PENDING] ${what} arrived before its message - written, then evicted by the same write (its sender is over the bound and this was its lowest)`
  );
  await settlePendingFor(deps, entry.conversationId, [entry.messageId]);
}

/**
 * The entries waiting for `ids` in `conversationId`, grouped by message - what a writer folds into
 * the bodies it is about to write ({@link settleAgainstPending}). Empty when there is no store or the
 * read fails, which is said: the entries then stay, and the writer's {@link settlePendingFor} after
 * its write settles them.
 */
export async function pendingFor(
  deps: Pick<PendingMutationDeps, 'storage' | 'deviceKey'>,
  conversationId: string,
  ids: readonly string[]
): Promise<Map<string, PendingMutation[]>> {
  const out = new Map<string, PendingMutation[]>();
  if (!deps.storage || ids.length === 0) return out;
  let read;
  try {
    read = await deps.storage.getPendingMutations(conversationId, ids, deps.deviceKey());
  } catch (e) {
    console.error(
      `[PENDING] the mutations awaiting ${ids.length} message(s) of ${short(conversationId)}… could not be read:`,
      e
    );
    return out;
  }
  if (read.removedUnreadable > 0) {
    // Found under this key's tags, so written under this key: bytes that no longer open are damaged,
    // and nothing could ever apply them. Removed by the read itself, said once for the batch.
    console.warn(
      `[PENDING] ${read.removedUnreadable} mutation(s) awaiting messages of ${short(conversationId)}... no longer open under this device's key - removed`
    );
  }
  for (const entry of read.entries) {
    const list = out.get(entry.messageId) ?? [];
    list.push(entry);
    out.set(entry.messageId, list);
  }
  return out;
}

/**
 * Logs what a settlement refused: each entry discarded for good (only a message's author may delete
 * or edit it), and the ones retained because the body's author is a claim nobody proved.
 */
export function logDiscarded(
  settlement: Pick<Settlement, 'discarded' | 'retained'>,
  author: string
): void {
  for (const entry of settlement.discarded) {
    console.warn(
      `[PENDING] Discarded a ${entry.kind} of ${short(entry.messageId)} by ${short(entry.sender)} - its author is ${short(author)}, and only an author may ${entry.kind} it`
    );
  }
  if (settlement.retained.length > 0) {
    console.log(
      `[PENDING] ${settlement.retained.length} mutation(s) of ${short(settlement.retained[0].messageId)} by someone other than its claimed, unproven author ${short(author)} - kept for a proven copy`
    );
  }
}

/** The stored half of a settlement. */
export function settledStoredPatch(fields: SettledFields): StoredMessagePatch {
  return { ...fields };
}

/** A shown message with a settlement applied. */
export function settledChatMessage(msg: ChatMessage, fields: SettledFields): ChatMessage {
  return {
    ...msg,
    ...(fields.isDeleted ? { isDeleted: true } : {}),
    ...(fields.content !== undefined ? { content: fields.content } : {}),
    ...(fields.isEdited ? { isEdited: true } : {}),
    ...(fields.editedAt !== undefined ? { editedAt: new Date(fields.editedAt) } : {}),
    ...(fields.reactions ? { reactions: fields.reactions } : {}),
  };
}

/**
 * Settles every entry waiting for `ids` whose message now exists, and removes those entries.
 *
 * **AN ENTRY IS CONSUMED ONLY ONCE THE ROW AT REST CARRIES IT.** A writer shows a message before it
 * stores it, so a message can be shown and not stored yet: the settlement is applied to what is shown
 * and the entries are KEPT, for the writer's own look after its write. Consuming them against memory
 * alone lost the mutation at rest, and a reload brought the body back. A message still absent keeps
 * its entries; a stored row this device cannot open is left alone, and so are they.
 */
export async function settlePendingFor(
  deps: PendingMutationDeps,
  conversationId: string,
  ids: readonly string[]
): Promise<void> {
  const { storage, deviceKey, conversations, log } = deps;
  if (!storage) return;
  const waiting = await pendingFor(deps, conversationId, ids);
  if (waiting.size === 0) return;

  const shown = new Map(
    (conversations.get(conversationId)?.messages ?? []).map((row) => [row.id, row])
  );
  let stored: Map<string, SettleTarget>;
  try {
    stored = (await storage.getMessagesByIds(conversationId, [...waiting.keys()], deviceKey()))
      .rows;
  } catch (e) {
    console.error(
      `[PENDING] the store could not say which of ${waiting.size} message(s) of ${short(conversationId)}... it holds - their mutations stay kept:`,
      e
    );
    return;
  }

  const consumed: PendingMutation[] = [];
  for (const [id, entries] of waiting) {
    const atRest = stored.get(id);
    if (!atRest) {
      const onScreen = shown.get(id);
      if (!onScreen) continue;
      const settlement = settleAgainstPending(onScreen, entries);
      if (settlement.fields) showSettled(deps, conversationId, id, settlement.fields);
      log(
        `[PENDING] ${short(id)} is shown and not stored yet - ${entries.length} mutation(s) applied to the screen, kept for its write`
      );
      continue;
    }
    // Settled against the row at rest - what must carry the entries - INSIDE the compare-and-set:
    // `merge` sees the row as it stands at the write, never the copy read above.
    let settlement: Settlement | null = null;
    try {
      await storage.mergeMessages(
        conversationId,
        [id],
        (current) => {
          const next = settleAgainstPending(current, entries);
          settlement = next;
          return next.fields ? mergeStoredMessage(current, settledStoredPatch(next.fields)) : null;
        },
        deviceKey()
      );
    } catch (e) {
      // Not removed: the entries are kept and settle again at the next look.
      console.error(`[PENDING] the settled state of ${short(id)} was not persisted:`, e);
      continue;
    }
    const done = settlement as Settlement | null;
    if (!done) {
      log(`[PENDING] ${short(id)} left the store before its mutations settled - they stay kept`);
      continue;
    }
    logDiscarded(done, atRest.senderId);
    consumed.push(...done.consumed);
    if (!done.fields) continue;
    showSettled(deps, conversationId, id, done.fields);
    log(
      `[PENDING] ${short(id)} met ${done.consumed.length} mutation(s) that arrived before it - ${shown.has(id) ? 'shown and stored' : 'stored, not shown'}`
    );
  }
  if (consumed.length === 0) return;
  try {
    await storage.deletePendingMutations(consumed, deviceKey());
  } catch (e) {
    // Settling them again is a no-op (see the module header), so a failed removal costs a re-read.
    console.error(`[PENDING] ${consumed.length} settled mutation(s) were not removed:`, e);
  }
}

/** Applies settled `fields` to what the screen draws of message `id`. */
function showSettled(
  deps: Pick<PendingMutationDeps, 'conversations' | 'messageReactions'>,
  conversationId: string,
  id: string,
  fields: SettledFields
): void {
  if (fields.reactions) deps.messageReactions.set(id, fields.reactions);
  const c = deps.conversations.get(conversationId);
  if (!c || !c.messages.some((row) => row.id === id)) return;
  deps.conversations.set(conversationId, {
    ...c,
    messages: c.messages.map((row) => (row.id === id ? settledChatMessage(row, fields) : row)),
  });
}
