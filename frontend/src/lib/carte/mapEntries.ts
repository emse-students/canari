import type { PosterEntry } from '$lib/associations/api';

/**
 * Which associations of a map's space the map shows, which it has switched off, and which are NEW
 * (owner, 2026-11-08).
 *
 * New is answered by durable state: an association of the space with no entry has never been seen
 * by this map - created, or given an audience reaching the space, since. It is offered switched OFF
 * with a badge and never reaches the live map until switched on. An entry naming an association
 * that is no longer of the space is ignored: the space decides what is offered.
 *
 * @param spaceAssociationIds - Every association the map's space offers today (server-computed).
 * @param entries - The map's switches.
 */
export function classifyMapAssociations(
  spaceAssociationIds: readonly string[],
  entries: readonly PosterEntry[]
): {
  on: Set<string>;
  off: Set<string>;
  fresh: Set<string>;
  zoneOf: Record<string, string | null>;
} {
  const byId = new Map(entries.map((e) => [e.associationId, e]));
  const on = new Set<string>();
  const off = new Set<string>();
  const fresh = new Set<string>();
  const zoneOf: Record<string, string | null> = {};
  for (const id of spaceAssociationIds) {
    const entry = byId.get(id);
    zoneOf[id] = entry?.zoneId ?? null;
    if (!entry) fresh.add(id);
    else if (entry.enabled) on.add(id);
    else off.add(id);
  }
  return { on, off, fresh, zoneOf };
}

/**
 * The saved placements of associations the map does not draw right now - switched off, or no
 * longer of its space.
 *
 * They are kept in the persisted layout rather than dropped: switching an association off is not
 * deleting its hand-made placement (owner, 2026-11-08: "switched OFF, not deleted"), and the
 * layout merge reseeds anything it has never seen with a fresh position and a random silhouette.
 *
 * @param saved - The placements read from the saved layout.
 * @param drawn - The association ids the model draws now.
 */
export function parkedPlacements<T extends { assoId: string }>(
  saved: readonly T[],
  drawn: ReadonlySet<string>
): T[] {
  return saved.filter((b) => typeof b?.assoId === 'string' && !drawn.has(b.assoId));
}
