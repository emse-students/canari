/**
 * Maps `items` through `fn` with at most `limit` calls in flight, results in input order.
 *
 * Exists so a request naming many ids cannot fan out into one database burst per id: a bounded pool
 * keeps one request's share of the connection pool fixed whatever the caller sends. A rejection
 * propagates and stops new work from starting.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
