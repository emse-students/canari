import { Log } from '$lib/utils/Log';

/**
 * How many independent network reads one pass keeps in flight at once - THE one bound, shared by the
 * history elections (`historyReconcile.ts`), the absent-group sweep (`groupSweep.ts`) and the
 * discovery status reads (`actions.ts`).
 *
 * A LIMIT RATHER THAN `Promise.all`, because the number of groups is not bounded by anything the
 * user controls: fifty conversations would open fifty requests on a phone radio at the exact moment
 * it reconnects. Six makes a pass of N reads cost ceil(N / 6) round trips instead of N (measured
 * 2026-11-10 on dev at 500 ms RTT: four key-group status reads in a row, 2.6 s, at every
 * connection - `docs/wiki/frontend/weak-network-audit-2026-11-10.md`) while keeping the burst the
 * size of a normal page load.
 */
export const NETWORK_READ_CONCURRENCY = 6;

/** One item whose `work` threw, and what it threw. */
export interface BoundedFailure<T> {
  item: T;
  error: unknown;
}

/**
 * Runs `work` over EVERY item, at most `limit` at a time, and settles once all of them have - with
 * the items whose `work` threw, in the order they failed.
 *
 * EVERY ITEM RUNS. One failure says nothing about the next item (a status read refused for one
 * group is not a verdict on another), so it never stops the pass: it is caught per item, logged with
 * the item's name, and returned. What a failure COSTS is the caller's decision - one keeps the
 * group, another rethrows - so this helper decides nothing about it.
 *
 * NOTHING OUTLIVES THE RETURNED PROMISE. Every worker catches its own item, so `Promise.all` cannot
 * reject early and leave the other workers running detached after the caller has moved on.
 *
 * Items are handed out IN ORDER, each exactly once: the cursor moves between awaits, so no lock is
 * needed, and the array is read in place (never copied).
 *
 * @param name names an item in the failure line (an id, cut by the caller as its own lines are).
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  name: (item: T) => string
): Promise<BoundedFailure<T>[]> {
  const failures: BoundedFailure<T>[] = [];
  if (items.length === 0) return failures;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        Log.d('BoundedConcurrency', `${name(item)} failed, the rest still run: ${String(error)}`);
        failures.push({ item, error });
      }
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return failures;
}
