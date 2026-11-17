import type { Queryable } from './report-accusations';

/**
 * THE `[UNINVITED_ENTRY]` COUNT, DURABLE (`uninvited_entries`, migration 053).
 *
 * The count the admission rule's fix-forward is read on used to be de-duplicated in one replica's
 * memory and printed only to one container's log, so every deploy reset it and a reading covered
 * the hours since the last one. Here the deduplication is the table's primary key: the first report
 * of an entry under a kind writes its row and is printed; every later one finds the row and is not.
 * No clock decides a count - `firstSeenAt` is aged out by the retention sweep, never compared.
 *
 * Read on production with one statement (docs/wiki/protocols/mls-protocol.md, "The count is a
 * table"): `SELECT kind, count(*) FROM uninvited_entries GROUP BY kind`.
 */

/** One entry as the log line prints it - every field already sanitized by the controller. */
export interface UninvitedEntryRow {
  groupId: string;
  entrant: string;
  epoch: string;
  kind: string;
  watchedFrom: string;
}

/**
 * Counts `entry` once: `true` when THIS call wrote its row (print the line), `false` when a report of
 * the same (group, entrant, epoch, kind) was counted before, by any replica, before any deploy.
 *
 * ONE STATEMENT, `INSERT ... ON CONFLICT DO NOTHING RETURNING`: two members reporting one entry at
 * the same instant serialise on the primary key, and only the statement that wrote the row returns
 * it - one line, never two, never none.
 */
export async function claimUninvitedEntry(
  db: Queryable,
  entry: UninvitedEntryRow
): Promise<boolean> {
  const rows = (await db.query(
    `INSERT INTO uninvited_entries ("groupId", entrant, epoch, kind, "watchedFrom")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING "groupId"`,
    [entry.groupId, entry.entrant, entry.epoch, entry.kind, entry.watchedFrom]
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Deletes the entries first counted before `before`, and returns how many went: the count keeps
 * what the log line would have kept (the retention window), and no longer.
 */
export async function deleteUninvitedEntriesBefore(db: Queryable, before: Date): Promise<number> {
  // TypeORM answers a DELETE on PostgreSQL as `[rows, rowCount]`.
  const [, removed] = (await db.query(`DELETE FROM uninvited_entries WHERE "firstSeenAt" < $1`, [
    before,
  ])) as [unknown[], number];
  return removed;
}
