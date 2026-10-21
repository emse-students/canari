/**
 * Keeps only the answer of the LATEST of several overlapping async loads.
 *
 * `begin()` is called when a load starts and returns `isCurrent`, asked after each await: it is true
 * only while no later load has begun. An older response that lands after a newer one is therefore
 * ignored instead of overwriting it - the order answers arrive in is the network's, never the
 * order the requests were made in.
 */
export function createLatestOnly(): () => () => boolean {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}
