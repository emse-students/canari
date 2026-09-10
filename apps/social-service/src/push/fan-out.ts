/**
 * Bounded fan-out for a best-effort side effect, and why a bare `Promise.all` is not it.
 *
 * Every push this service sends is one HTTP POST to the delivery service. `Promise.all` over the
 * recipients opens all of them AT ONCE, which was survivable while the widest fan-out was an
 * association's officers - a dozen or so. It stops being survivable the moment a publication is
 * announced to the whole feed audience: 356 users on the 2026-09-10 copy of production, so 356
 * simultaneous sockets from one cron tick, against a service sized for the steady rate rather than
 * for a burst. The failure that produces is not a lost notification, it is the delivery service
 * refusing everything for the duration - including the messages that had nothing to do with the
 * post.
 *
 * The bound belongs HERE and not at the call site, because the call sites are the ones that do not
 * know how many recipients they will get: `createNotifications` takes a list whose length is a
 * property of the audience, not of the caller.
 */

/** How many best-effort pushes may be in flight at once. */
export const PUSH_FAN_OUT_LIMIT = 16;

/** One item's failure, kept with the item so the caller can name it in a log. */
export interface FanOutFailure<T> {
  item: T;
  error: unknown;
}

/**
 * Runs `task` for every item, at most `limit` at a time, and resolves when all have settled.
 *
 * NEITHER ABANDONS NOR SWALLOWS, and both halves are the point. A rejection is caught so that one
 * failed recipient cannot drop the recipients queued behind it - the "a batch that catches once
 * loses every failure after the first" defect, which is just as real when the batch is a worker
 * pool. And every caught error is RETURNED rather than discarded, because in a best-effort path
 * the log is all a loss leaves, and only the caller knows how to name the item it belongs to.
 * A caller that ignores the returned array is the swallow this shape exists to make visible.
 *
 * Workers pull from a shared cursor rather than the list being pre-sliced into `limit` chunks: a
 * chunked split runs at the speed of its slowest chunk and leaves workers idle once their own
 * slice is done, which for HTTP calls of wildly different latency is most of the time.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<FanOutFailure<T>[]> {
  const failures: FanOutFailure<T>[] = [];
  if (items.length === 0) return failures;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        await task(item);
      } catch (error: unknown) {
        failures.push({ item, error });
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return failures;
}
