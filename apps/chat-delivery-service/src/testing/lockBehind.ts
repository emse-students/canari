import type { Client } from 'pg';
import { ACTIVITY_DUMP_SQL, untilWaiting, type LockWait } from './lockWait';

/**
 * {@link untilWaiting} for sessions blocked BEHIND `holder`, a raw client keeping a lock: the
 * holder's own blocking tree, asked through `admin`, so no other session of the database can
 * answer for it. Transitive, because a second waiter on one row queues behind the first
 * (`pg_blocking_pids` names the first waiter, not the holder).
 */
export async function untilBlockedBehind(
  admin: Client,
  holder: Client,
  wait: Omit<LockWait, 'waiting' | 'dump'>
): Promise<void> {
  const [{ pid }] = (await holder.query('SELECT pg_backend_pid() AS pid')).rows as Array<{
    pid: number;
  }>;
  await untilWaiting({
    ...wait,
    waiting: async () =>
      (
        (
          await admin.query(
            `WITH RECURSIVE behind AS (
               SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
               UNION
               SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY(pg_blocking_pids(a.pid))
             )
             SELECT count(*)::int AS waiting FROM behind`,
            [pid]
          )
        ).rows as Array<{ waiting: number }>
      )[0].waiting,
    dump: async () => (await admin.query(ACTIVITY_DUMP_SQL)).rows,
  });
}
