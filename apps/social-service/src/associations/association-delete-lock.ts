/**
 * The locks an association's deletion takes BEFORE it deletes anything, in ONE global order.
 *
 * Deleting association A deletes A's events; migration 074's trigger then takes those events'
 * co-owner rows and `coorganise` proposals, which can name B. Deleting the row of A then cascades
 * into the co-owner rows and proposals where A co-organises B's events. `remove(B)` does the same
 * in mirror, so two deletes of linked associations each held a row the other's cascade needed:
 * `40P01`, one delete aborted (backlog entry of 2026-10-19, review of #2116).
 *
 * The fix is the lock order every other writer already follows: take EVERY association the delete
 * reaches through co-organisation, sorted by id, in one statement, before any delete. Two such
 * deletes then queue behind each other instead of crossing. A concurrent acceptance of a new
 * co-organisation takes its organiser's association `FOR KEY SHARE` first
 * (`ProposalsService.lockInOrder`), which `FOR UPDATE` conflicts with, so the reached set cannot grow
 * under a held lock.
 */

/** The minimal shape of a TypeORM `EntityManager` this needs, so a spec can hand it a raw client. */
export interface QueryRunnerLike {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * The association itself plus every association linked to it by an accepted or pending
 * co-organisation, in either direction, locked `FOR UPDATE` in id order. `ORDER BY` with `FOR
 * UPDATE` locks in the sorted order (the lock node sits above the sort).
 */
export const LOCK_ASSOCIATIONS_REACHED_BY_COORGANISATION_SQL = `
  SELECT a.id FROM associations a
   WHERE a.id = $1
      OR a.id IN (SELECT co.association_id FROM association_calendar_event_co_owners co
                    JOIN association_calendar_events e ON e.id = co.event_id
                   WHERE e."associationId" = $1)
      OR a.id IN (SELECT e."associationId" FROM association_calendar_event_co_owners co
                    JOIN association_calendar_events e ON e.id = co.event_id
                   WHERE co.association_id = $1)
      OR a.id IN (SELECT p."toAssociationId" FROM proposals p
                   WHERE p.kind = 'coorganise' AND p."fromAssociationId" = $1)
      OR a.id IN (SELECT p."fromAssociationId" FROM proposals p
                   WHERE p.kind = 'coorganise' AND p."toAssociationId" = $1)
   ORDER BY a.id
   FOR UPDATE OF a`;

/**
 * Locks association `id` and every association its deletion reaches through co-organisation, in id
 * order. Must be the first statement of the deletion's transaction.
 *
 * @returns how many association rows are held (1 means no co-organisation links it to another).
 */
export async function lockAssociationsReachedByCoorganisation(
  manager: QueryRunnerLike,
  id: string
): Promise<number> {
  const rows = (await manager.query(LOCK_ASSOCIATIONS_REACHED_BY_COORGANISATION_SQL, [id])) as {
    id: string;
  }[];
  return rows.length;
}
