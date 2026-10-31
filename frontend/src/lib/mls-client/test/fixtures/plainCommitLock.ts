/**
 * The commit's hold of the MLS mutex, for a test context that stands in for `BaseMlsService` with a
 * plain object: the commit runs under that context's own `runUnderMlsLock` (read at call time, so a
 * case that swaps it later is followed), and its network loan lends nothing.
 *
 * Spread into the context: `{ ...plainCommitLock, runUnderMlsLock, ... }`. The loan itself - which
 * frames may borrow the mutex while a commit request is on the network - is pinned against the real
 * scheduler in `mlsPerGroupScheduler.test.ts` and `BaseMlsService.crossGroupDrain.test.ts`.
 */
export const plainCommitLock = {
  runCommitUnderMlsLock<T>(
    this: { runUnderMlsLock<U>(fn: () => Promise<U>): Promise<U> },
    _groupId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.runUnderMlsLock(fn);
  },
  lendMlsLockDuring<T>(_groupId: string, work: () => Promise<T>): Promise<T> {
    return work();
  },
};
