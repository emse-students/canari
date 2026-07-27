/**
 * Serializes mutations of the reactive `conversations` Map PER groupId (audit H3).
 *
 * Context: two concurrent flows used to read then rewrite `conversations` around several
 * network/storage `await`s, interleaving on the same groupId (e.g. two Welcome receptions, or a
 * Welcome and a duplicate reconciliation re-keying the same direct conversation). If one slips
 * between the READ and the WRITE of the other, in-memory messages are overwritten (lost update).
 * `runExclusiveForGroup` guarantees that a single critical section per groupId runs at a time.
 *
 * ANTI-DEADLOCK INVARIANT: a section locked here must NEVER acquire the async MLS lock
 * (`runUnderMlsLock`). The sections involved only touch the Map and storage (SQLite/IndexedDB);
 * `forgetGroup` is synchronous (it does not take the MLS lock). Since no holder of THIS lock
 * waits on the MLS lock, there can be no wait cycle with a caller holding the MLS lock and
 * waiting on this one (e.g. `upsertConversation`).
 */
const groupChains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` in mutual exclusion with any other section passed for the SAME `groupId`.
 * Different groups do not block each other. The chain is cleaned up when it drains
 * (no memory leak for inactive groups).
 */
export function runExclusiveForGroup<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupChains.get(groupId) ?? Promise.resolve();
  // `then(fn, fn)`: chain regardless of the previous outcome (success OR failure) so an error
  // in an earlier section never blocks the queue.
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  groupChains.set(groupId, settled);
  void settled.then(() => {
    // Only delete if no newer section was chained in the meantime.
    if (groupChains.get(groupId) === settled) groupChains.delete(groupId);
  });
  return run;
}
