/**
 * Which comments ARRIVED since the list was last looked at, so exactly those play the entrance
 * (`motion-pop-in`): the reader's own comment, or one another member posted while the thread was
 * open. The first draw (`primed` false) is never an arrival, and neither is a page of older
 * comments (`onLoadOlder`) or a sort change, which bring several ids at once - nothing animates.
 *
 * @param known ids already seen; updated in place with every id in `ids`
 * @param ids the ids drawn now
 * @param primed whether the list was drawn before: false on the first call
 * @returns the ids to animate: the single new id, or none
 */
export function commentArrivals(
  known: Set<string>,
  ids: readonly string[],
  primed: boolean
): string[] {
  const fresh = ids.filter((id) => !known.has(id));
  for (const id of fresh) known.add(id);
  return primed && fresh.length === 1 ? fresh : [];
}
