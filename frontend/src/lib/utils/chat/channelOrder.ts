/**
 * The order of a community's salons, as pure list operations.
 *
 * Kept out of the component and the composable so the same two rules serve the drag, the keyboard
 * and the live update, and so each can be tested without a DOM.
 */

/**
 * Moves the item `id` by `delta` places (-1 = up), or returns null when it cannot move (unknown id,
 * or already at that end). Null rather than the unchanged list so a caller never persists a no-op.
 */
export function moveById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  delta: number
): T[] | null {
  const from = items.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= items.length || delta === 0) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Puts `items` in the order `orderedIds` names. An item the list does not name keeps its relative
 * place after the named ones, and an id naming nothing is ignored: the server answers with the
 * salons THIS member may see, which can lag or lead what is on screen for a moment.
 */
export function orderByIds<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[]
): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  const named = items.filter((item) => rank.has(item.id));
  const unnamed = items.filter((item) => !rank.has(item.id));
  named.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...named, ...unnamed];
}
