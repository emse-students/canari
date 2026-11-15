/**
 * The ONE way an integration spec waits for "a session is blocked on a lock".
 *
 * A test that holds a lock from a second session and starts the operation under test must not go on
 * until the operation has REACHED its wait: read from the server, each round a real query, never a
 * sleep. The wait can fail to come (the operation settled without waiting, the probe asks about the
 * wrong sessions, the holder never started), and a probe that then loops until jest's timeout
 * reports "Exceeded timeout" - a verdict that names nothing. So every wait ends one of three ways:
 * the count is reached, the operation settled first (an event), or a bounded number of reads went
 * by and the error carries what the server shows. A test whose verdict is read AFTER the wait (it
 * must release a lock first, or the operation settling without waiting is an outcome it asserts
 * on) asks for `onAbsent: 'return'` and MUST assert the result itself (`expect(waited)
 * .toMatchObject({ outcome: 'waiting' })`): an ignored result lets a wait that never came pass.
 * It never wraps a throw and never reads an error message.
 *
 * The caller keeps the SCOPING of `waiting` (its `application_name`, a holder's blocking tree or a
 * lock key): this helper only owns the loop and the failure. Never widen a probe to the whole
 * database - another suite's parked session answers for this one in a parallel run
 * (docs/wiki/durable-rules.md, "A PROOF READ FROM THE SERVER MUST BE ABOUT YOUR OWN SESSIONS").
 * Lives in `src/testing`, which the production build excludes.
 */

/**
 * Reads a wait may take before it is declared absent. Each is a real query, never a duration, and
 * the bound must end the wait BEFORE jest's own budget does (60 s for an integration spec,
 * `jest-integration-budget.cjs`), or the bare timeout is back. Derived, not timed: 60 s divided by
 * 2,000 reads leaves 30 ms for a read and its yield, many times the cost of the heaviest read used
 * here (the recursive holder-tree query is a scan of `pg_stat_activity`, well under a millisecond
 * on a quiet server). And the bound is generous in the other direction: the operation under test
 * advances on every yield, and reaches its lock in a handful of round trips.
 */
export const LOCK_WAIT_READS = 2_000;

/** What the server shows, for the error of a wait that never came. Database-wide: it is only read. */
export const ACTIVITY_DUMP_SQL = `SELECT pid, application_name, state, wait_event_type, wait_event,
  pg_blocking_pids(pid) AS blocked_by, left(query, 120) AS query
  FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;

/** A flag that turns true once `operation` settles, resolved or rejected; the rejection stays the caller's. */
export function settledFlag(operation: Promise<unknown>): () => boolean {
  let settled = false;
  void operation.then(
    () => (settled = true),
    () => (settled = true)
  );
  return () => settled;
}

/** What {@link untilWaiting} needs to know. */
export interface LockWait {
  /** One real read of how many sessions wait, scoped by the caller to the sessions it owns. */
  waiting: () => Promise<number>;
  /** Waiters to see before the wait is proved. Default 1. */
  atLeast?: number;
  /** True once the operation under test finished before the wait was proved. */
  settled?: () => boolean;
  /**
   * What a wait that does not come means (the operation settled, or the read bound): `'throw'`
   * (default) is the failure, with a message; `'return'` hands the outcome back for a test that
   * must release a lock before it asserts, and asserts on it itself.
   */
  onAbsent?: 'throw' | 'return';
  /** Names the wait in the error ("the booking", "two stores"). */
  what: string;
  /** What the server shows, appended to the error of a wait that never came. */
  dump?: () => Promise<unknown>;
}

/** Which end happened, the last count read, and what the server shows when the wait did not come. */
export interface LockWaitResult {
  outcome: 'waiting' | 'settled' | 'unseen';
  seen: number;
  /** `dump()` of a wait that did not come, in `'return'` mode, for the test's own assertion to show. */
  dump?: unknown;
}

/**
 * Resolves once `waiting()` reaches `atLeast`. Otherwise throws when `settled()` turns true or when
 * {@link LOCK_WAIT_READS} reads went by (with `dump()` in the message) - unless
 * `onAbsent: 'return'`, which resolves `{ outcome: 'settled' | 'unseen' }` instead. The count is read BEFORE `settled` is looked at, so
 * an operation that waited and then finished is still proved.
 */
export async function untilWaiting(wait: LockWait): Promise<LockWaitResult> {
  const atLeast = wait.atLeast ?? 1;
  let seen = 0;
  for (let reads = 0; reads < LOCK_WAIT_READS; reads++) {
    seen = await wait.waiting();
    if (seen >= atLeast) return { outcome: 'waiting', seen };
    if (wait.settled?.()) {
      if (wait.onAbsent === 'return') {
        return { outcome: 'settled', seen, dump: await wait.dump?.() };
      }
      throw new Error(
        `${wait.what} settled before ${atLeast} waiting session(s) were seen (saw ${seen})`
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const dump = await wait.dump?.();
  if (wait.onAbsent === 'return') return { outcome: 'unseen', seen, dump };
  const shown = wait.dump ? JSON.stringify(dump) : 'no dump given';
  throw new Error(
    `${wait.what}: ${atLeast} waiting session(s) not seen after ${LOCK_WAIT_READS} reads (last ${seen}); the server shows ${shown}`
  );
}
