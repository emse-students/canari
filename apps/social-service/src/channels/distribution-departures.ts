/**
 * THE TWO WRITES THAT DECIDE HOW A KEY-GROUP DEPARTURE ENDED, spelled once (migration 108,
 * `entities/distribution-departure.entity.ts`).
 *
 * Both insert the same primary key `(groupId, userId, departure)` and do nothing on a conflict, so
 * whichever commits first decides: the roster write's {@link RECORD_DEPARTED_SQL} (in the departure's
 * own transaction) or the drain's {@link RECORD_CANCELLED_SQL}. A second insert arriving while the
 * first is uncommitted WAITS for it - the primary key's own lock - and then does nothing if it
 * committed, or writes if it rolled back. That wait is what makes the answer final, and
 * `distribution-departure.integration.spec.ts` runs it against PostgreSQL in both orders.
 *
 * Parameters: `$1` groupId, `$2` userId, `$3` departure.
 */

/**
 * The community's removal lock, taken first in a departure's roster-write transaction and released
 * by its commit or rollback - so a permission re-checked inside that transaction is read against
 * writes serialised on the same community. `$1` is the workspace id.
 */
export const COMMUNITY_REMOVAL_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('community_removal:' || $1, 0))`;

/** The roster write's record; RETURNING says whether it won (a row) or the drain did (none). */
export const RECORD_DEPARTED_SQL = `INSERT INTO distribution_departures ("groupId", "userId", "departure", "outcome")
  VALUES ($1, $2, $3, 'departed')
  ON CONFLICT ("groupId", "userId", "departure") DO NOTHING
  RETURNING "departure"`;

/** The drain's question, deciding a departure nothing has recorded yet. */
export const RECORD_CANCELLED_SQL = `INSERT INTO distribution_departures ("groupId", "userId", "departure", "outcome")
  VALUES ($1, $2, $3, 'cancelled')
  ON CONFLICT ("groupId", "userId", "departure") DO NOTHING`;

/**
 * Every record of the groups `$1` (a uuid array), deleted with the groups themselves: a community's
 * deletion and a private salon's group retired. A group gone has no departure left to ask about -
 * chat-delivery's drain settles a row whose group is gone without asking.
 */
export const DELETE_GROUP_DEPARTURES_SQL = `DELETE FROM distribution_departures WHERE "groupId" = ANY($1::uuid[])`;

/** How the departure ended, read in a statement started after the insert's wait. */
export const READ_OUTCOME_SQL = `SELECT "outcome" FROM distribution_departures
  WHERE "groupId" = $1 AND "userId" = $2 AND "departure" = $3`;
