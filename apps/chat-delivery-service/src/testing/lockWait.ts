/**
 * The ONE way an integration spec waits for "a session is blocked on a lock".
 *
 * A test that holds a lock from a second session and starts the operation under test must not go on
 * until the operation has REACHED its wait: read from the server, each round a real query, never a
 * sleep. The wait can fail to come (the operation settled without ever waiting, the probe asks about
 * the wrong sessions, the holder never started), and a probe that then loops until jest's timeout
 * reports "Exceeded timeout" - a verdict that names nothing. So every wait ends one of three ways:
 * the count is reached, the operation settled first (an event, said as the failure it is), or a
 * bounded number of reads went by and the error carries what the server shows.
 *
 * The caller keeps the SCOPING of `waiting` (its `application_name`, a holder's blocking tree or a
 * lock key): this helper only owns the loop and the failure. Never widen a probe to the whole
 * database - another suite's parked session answers for this one in a parallel run
 * (docs/wiki/durable-rules.md, "A PROOF READ FROM THE SERVER MUST BE ABOUT YOUR OWN SESSIONS").
 * Lives in `src/testing`, which the production build excludes.
 */

/** Reads a wait may take before it is declared absent; each is a real query, never a duration. */
export const LOCK_WAIT_READS = 10_000;

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
  /** True once the operation under test finished: it never waited, which is the failure. */
  settled?: () => boolean;
  /** Names the wait in the error ("the booking", "two stores"). */
  what: string;
  /** What the server shows, appended to the error of a wait that never came. */
  dump?: () => Promise<unknown>;
}

/**
 * Resolves once `waiting()` reaches `atLeast`. Throws, instead of leaving jest to time out, when
 * `settled()` says the operation finished without waiting, or when {@link LOCK_WAIT_READS} reads
 * went by (with `dump()` in the message). The count is read BEFORE `settled` is looked at, so an
 * operation that waited and then finished is still proved.
 */
export async function untilWaiting(wait: LockWait): Promise<void> {
  const atLeast = wait.atLeast ?? 1;
  let seen = 0;
  for (let reads = 0; reads < LOCK_WAIT_READS; reads++) {
    seen = await wait.waiting();
    if (seen >= atLeast) return;
    if (wait.settled?.()) {
      throw new Error(
        `${wait.what} settled without ever waiting on a lock (saw ${seen} of ${atLeast})`
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const shown = wait.dump ? JSON.stringify(await wait.dump()) : 'no dump given';
  throw new Error(
    `${wait.what}: never ${atLeast} session(s) waiting on a lock after ${LOCK_WAIT_READS} reads (last ${seen}); the server shows ${shown}`
  );
}
