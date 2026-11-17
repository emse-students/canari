import { cutUserId } from './log-repeat';
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

/** One entry as the log line prints it - every field already classified by the controller. */
export interface UninvitedEntryRow {
  groupId: string;
  /** `<8 of the user>:<device>`, the line's `entrant=` (pseudonymous: the device id re-identifies). */
  entrantUserDevice: string;
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
    `INSERT INTO uninvited_entries ("groupId", "entrantUserDevice", epoch, kind, "watchedFrom")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING "groupId"`,
    [entry.groupId, entry.entrantUserDevice, entry.epoch, entry.kind, entry.watchedFrom]
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Deletes the entries first counted more than `retentionMs` ago, and returns how many went: the
 * count keeps what the log line would have kept (the retention window), and no longer.
 *
 * THE DATABASE'S CLOCK, `now()`, the one that wrote `firstSeenAt` - never this process's, so a
 * replica whose clock drifts neither keeps nor deletes a row early.
 */
export async function deleteUninvitedEntriesPastRetention(
  db: Queryable,
  retentionMs: number
): Promise<number> {
  // TypeORM answers a DELETE on PostgreSQL as `[rows, rowCount]`.
  const [, removed] = (await db.query(
    `DELETE FROM uninvited_entries WHERE "firstSeenAt" < now() - make_interval(secs => $1)`,
    [retentionMs / 1000]
  )) as [unknown[], number];
  return removed;
}

/**
 * Deletes the entries counted against an erased account, and returns how many went.
 *
 * A row holds the user id cut to eight characters ({@link cutUserId}) before the `:`, so that is what
 * is matched. Another account whose id shares those eight characters loses its rows too: a count,
 * never a decision, and the collision is one in 4 billion for the hex ids this estate mints.
 */
export async function deleteUninvitedEntriesOfAccount(
  db: Queryable,
  userId: string
): Promise<number> {
  const [, removed] = (await db.query(
    `DELETE FROM uninvited_entries WHERE split_part("entrantUserDevice", ':', 1) = $1`,
    [cutUserId(userId)]
  )) as [unknown[], number];
  return removed;
}
