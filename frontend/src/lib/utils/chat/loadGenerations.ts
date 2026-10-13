/**
 * A generation number per key, so that of several overlapping loads of one thing only the LATEST
 * started may apply its result.
 *
 * WHY A GENERATION AND NOT AN IN-FLIGHT FLAG. A salon's history page is AUTHORITATIVE for its window
 * (`mergeMessagePage` drops a held row inside `[oldest, newest]` that the page does not carry), so a
 * load that STARTED earlier and FINISHES later can remove a row a newer load just decoded - load A
 * reads the page before seed S is held and leaves row R out, S lands, load B decodes R, then A
 * merges and R is gone. Refusing to start B while A runs would keep A's stale page instead; the
 * newer load is the one that knows more, so the older one yields. The order of STARTS decides,
 * never the order of completions and never a clock.
 */
export interface LoadGenerations {
  /** Opens a load of `key` and returns its generation; every earlier load of `key` is now stale. */
  begin(key: string): number;
  /** Whether the load that `begin` numbered `generation` is still the latest started for `key`. */
  isLatest(key: string, generation: number): boolean;
}

/** Creates an empty tracker. One per owner of the loads it orders. */
export function createLoadGenerations(): LoadGenerations {
  let counter = 0;
  const latest = new Map<string, number>();
  return {
    begin(key) {
      counter += 1;
      latest.set(key, counter);
      return counter;
    },
    isLatest(key, generation) {
      return latest.get(key) === generation;
    },
  };
}
