/**
 * The drag-and-drop rules of the carte editor's side panel, kept out of the page so they can be
 * tested: dragging an association row onto a zone assigns it, dragging a zone row onto another
 * reorders the zones (owner, 2026-11-11).
 *
 * Every function is pure: the page owns the events and the writes, these only decide WHAT a drop
 * means, and answer `null` for a drop that changes nothing so no write is sent for it.
 */

/** The `dataTransfer` type the editor's own drags carry; a foreign drag never carries it. */
export const CARTE_DRAG_MIME = 'application/x-canari-carte';

/** What is being dragged: an association row, or a zone row. */
export interface CarteDrag {
  kind: 'asso' | 'zone';
  id: string;
}

/** The payload written to `dataTransfer` when a drag starts. */
export function encodeDrag(drag: CarteDrag): string {
  return JSON.stringify(drag);
}

/** Reads a drag payload back; anything that is not one of ours is `null`, never a guess. */
export function decodeDrag(raw: string | null | undefined): CarteDrag | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { kind, id } = value as Record<string, unknown>;
    if ((kind !== 'asso' && kind !== 'zone') || typeof id !== 'string' || id === '') return null;
    return { kind, id };
  } catch {
    return null;
  }
}

/** The switch row a drop of an association onto a zone writes. */
export interface ZoneAssignment {
  associationId: string;
  zoneId: string | null;
}

/**
 * What dropping `drag` on the zone `targetZoneId` (`null` = the "no zone" group) writes.
 *
 * `null` when the drag is not an association, or it already sits in that zone.
 *
 * @param zoneOf - The zone of every association of the space, as `classifyMapAssociations` reads it.
 */
export function planAssociationDrop(
  drag: CarteDrag | null,
  targetZoneId: string | null,
  zoneOf: Readonly<Record<string, string | null>>
): ZoneAssignment | null {
  if (!drag || drag.kind !== 'asso' || !(drag.id in zoneOf)) return null;
  if ((zoneOf[drag.id] ?? null) === targetZoneId) return null;
  return { associationId: drag.id, zoneId: targetZoneId };
}

/**
 * The new zone order when the zone `drag.id` is dropped on the zone `targetZoneId`: it takes the
 * target's slot, so dragging down lands it after the target and dragging up before it.
 *
 * `null` when the drag is not a zone, either id is unknown, or nothing would move.
 */
export function planZoneReorder(
  zoneIds: readonly string[],
  drag: CarteDrag | null,
  targetZoneId: string
): string[] | null {
  if (!drag || drag.kind !== 'zone' || drag.id === targetZoneId) return null;
  const from = zoneIds.indexOf(drag.id);
  const to = zoneIds.indexOf(targetZoneId);
  if (from < 0 || to < 0) return null;
  return moveInList(zoneIds, from, to);
}

/**
 * The keyboard twin of the drag: the zone one step up (-1) or down (+1). `null` at either end or
 * for an unknown zone.
 */
export function moveZoneId(zoneIds: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = zoneIds.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= zoneIds.length) return null;
  return moveInList(zoneIds, from, to);
}

function moveInList(list: readonly string[], from: number, to: number): string[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The associations of each zone, in the panel's order: new first, then by name. The first group is
 * the "no zone" one (`zoneId` null); a zone id the map no longer has reads as no zone, so a row is
 * never lost.
 */
export function groupAssociationsByZone<T extends { id: string; name: string }>(
  associations: readonly T[],
  zoneIds: readonly string[],
  zoneOf: Readonly<Record<string, string | null>>,
  fresh: ReadonlySet<string>
): { zoneId: string | null; items: T[] }[] {
  const known = new Set(zoneIds);
  const bucket = (zoneId: string | null): T[] =>
    associations
      .filter((a) => {
        const own = zoneOf[a.id] ?? null;
        return (own !== null && known.has(own) ? own : null) === zoneId;
      })
      .sort(
        (x, y) => Number(fresh.has(y.id)) - Number(fresh.has(x.id)) || x.name.localeCompare(y.name)
      );
  return [null, ...zoneIds].map((zoneId) => ({ zoneId, items: bucket(zoneId) }));
}
