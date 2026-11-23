/**
 * THE ROW WRITES IN FLIGHT PER CONVERSATION, so a removal can order its store deletion after them.
 *
 * A batch write (`useMessaging.writeBatchRows`) asks the map whether its conversation still exists,
 * then awaits its inserts and the conversation's own row. A removal that cleared the store during
 * those awaits was followed by the inserts: the rows of a removed conversation came back. The two
 * are ordered here, by construction rather than by a clock:
 *
 * - the writer asks the map and REGISTERS in the same synchronous step ({@link beginConversationRowWrite}),
 *   and releases once its last write has settled;
 * - the remover takes the conversation out of the map FIRST, then waits for the writes registered
 *   under its key ({@link conversationRowWritesSettled}), and only then clears the store.
 *
 * A writer that asked before the map removal is registered before it, so the store is cleared after
 * its rows land and takes them; a writer that asks after it finds no conversation and inserts
 * nothing. Every registration is released in a `finally`, so the wait terminates when the writes do.
 *
 * [chat](../../../../../docs/wiki/frontend/modules/chat.md#adds-to-one-conversation-are-not-serialized-so-an-add-renders-onto-the-row-as-it-is-now-2026-11-23)
 */

interface KeyWrites {
  count: number;
  waiters: Array<() => void>;
}

const writesByKey = new Map<string, KeyWrites>();

/**
 * Registers one row write into `key`; the returned function releases it, once (a second call is a
 * no-op). Call it in the same synchronous step as the map check that allowed the write.
 */
export function beginConversationRowWrite(key: string): () => void {
  const entry = writesByKey.get(key) ?? { count: 0, waiters: [] };
  entry.count += 1;
  writesByKey.set(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count > 0) return;
    writesByKey.delete(key);
    for (const wake of entry.waiters.splice(0)) wake();
  };
}

/** Resolves once no row write registered under `key` is in flight (at once when none is). */
export function conversationRowWritesSettled(key: string): Promise<void> {
  const entry = writesByKey.get(key);
  if (!entry) return Promise.resolve();
  return new Promise((resolve) => entry.waiters.push(resolve));
}

/** How many row writes are in flight under `key` - for the removal's log line and the tests. */
export function conversationRowWritesInFlight(key: string): number {
  return writesByKey.get(key)?.count ?? 0;
}
