/**
 * `list` with the entry at `from` moved to `to`, or null for a move that changes nothing or falls
 * outside the list. A NEW array: the caller assigns it, so a `$state` proxy sees one write. Shared
 * by both grid editors' reorder (`productGridEditor.ts`, `matrixEditor.ts`).
 */
export function movedList<T>(list: readonly T[], from: number, to: number): T[] | null {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return null;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
