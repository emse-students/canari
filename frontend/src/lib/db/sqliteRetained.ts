/**
 * A TABLE HOLDING USER DATA IS NEVER DROPPED BY A MIGRATION - IT IS SET ASIDE, AND RELEASED ONLY ONCE
 * THE FILE PROVES ITS ROWS ARE WHERE THEY WERE MEANT TO GO (charter principle 2, "the essential is
 * never lost"; decided 2026-11-26, `docs/wiki/frontend/local-store-rebuild.md`).
 *
 * 1.8.1's v23 rebuild proved its copy and then dropped the old `messages` table; a defect between the
 * proof and the drop cost a user every message the device held. The single-flight open is the fix
 * for THAT defect. This is the guarantee for the next one, whatever it is: a migration that replaces
 * a table RENAMES the old one to {@link retainedName} inside its own guarded transaction, instead of
 * dropping it, and {@link settleRetainedTables} - run at EVERY open, before anything else touches the
 * store, and again by the migration itself once it is done - compares the copy with the live table:
 *
 * - every retained row the live table holds under the same primary key: the copy is released (a
 *   guarded drop that re-proves it under the write lock);
 * - a retained row the live table does NOT hold: said at error with both counts, and RESTORED - an
 *   `INSERT OR IGNORE` that adds the missing rows and replaces none - then proved and released. A
 *   copy that still cannot be proved is KEPT for the next open, and a migration of that table refuses
 *   while it is there.
 *
 * WHY A TABLE IN THE SAME FILE, NOT A SIBLING FILE (`VACUUM INTO`): the old table IS the copy, so it
 * costs nothing beyond the staging copy the rebuild already needs - a `VACUUM INTO` would add a third
 * copy of the WHOLE file - and it is restored by a statement, where a file would need a native command
 * to delete or swap it under a connection pool the plugin shares with every caller. And a full disk
 * cannot produce a migration without its copy: the staging copy is written first, and SQLite refuses
 * it before anything is set aside.
 */
import type { TableInfoRow } from './sqliteMigrations';

/** The prefix of a table a migration has set aside; the rest of the name is the table it replaced. */
const RETAINED_PREFIX = 'retained__';

/** The per-connection table the release's guard writes into; its CHECK is what refuses. */
const RETAINED_GUARD = 'retained_release_guard';

/** The name `table` is set aside under. */
export function retainedName(table: string): string {
  return `${RETAINED_PREFIX}${table}`;
}

/**
 * The statements that set `table` aside instead of dropping it - for INSIDE a migration's guarded
 * transaction. Its indexes are dropped first (derived data, made again on the table that replaces it):
 * a renamed table keeps its index names, which would turn the new table's `CREATE INDEX IF NOT EXISTS`
 * into a no-op.
 *
 * @param indexes the names of `table`'s own indexes (`sqlite_master`, `sql IS NOT NULL`).
 */
export function retainTableStatements(table: string, indexes: readonly string[]): string[] {
  return [
    ...indexes.map((index) => `DROP INDEX IF EXISTS main.${index}`),
    `ALTER TABLE main.${table} RENAME TO ${retainedName(table)}`,
  ];
}

/** The trigger that makes a kept copy follow the user's deletions; dropped with the copy. */
function followDeletesTrigger(table: string): string {
  return `retained_follows_deletes_${table}`;
}

/**
 * The trigger a migration creates, INSIDE its own transaction right after the table that replaces
 * `table` exists: a row the user (or a wipe) deletes from the live table is deleted from the set-aside
 * copy too. Without it a copy that survives a session - a release that failed - would have its rows
 * RESTORED at the next open as "missing", resurrecting what the user deleted. A deletion is the only
 * way a row legitimately leaves the live table, so following it keeps "missing" meaning "lost by a
 * defect". Dropped by the release, before the copy: a trigger naming a dropped table fails every delete.
 *
 * @param key the live table's primary key columns.
 */
export function retainedFollowsDeletesStatement(table: string, key: readonly string[]): string {
  const match = key.map((c) => `${c} IS old.${c}`).join(' AND ');
  return (
    `CREATE TRIGGER IF NOT EXISTS main.${followDeletesTrigger(table)} AFTER DELETE ON ${table} ` +
    `BEGIN DELETE FROM ${retainedName(table)} WHERE ${match}; END`
  );
}

/** NULL-safe match of a retained row `r` with a live row `t` on `key`. */
function keyMatch(key: readonly string[]): string {
  return key.map((c) => `t.${c} IS r.${c}`).join(' AND ');
}

/** The rows of the copy of `table` that `table` does not hold under the same `key`. */
function retainedMissingCountStatement(table: string, key: readonly string[]): string {
  return (
    `SELECT COUNT(*) AS n FROM main.${retainedName(table)} r ` +
    `WHERE NOT EXISTS (SELECT 1 FROM main.${table} t WHERE ${keyMatch(key)})`
  );
}

/** The restore: every row of the copy `table` lacks, added - never one replaced. */
function retainedRestoreStatement(table: string, columns: readonly string[]): string {
  const list = columns.join(', ');
  return `INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM main.${retainedName(table)}`;
}

/**
 * The release: ONE `execute`, one transaction. The guard re-proves, under the write lock the drop runs
 * under, that no row of the copy is missing from `table`; false is a `CHECK` violation under
 * `OR ROLLBACK`, which ends the transaction before the drop and leaves no transaction open on the
 * pooled connection.
 */
function retainedReleaseStatement(table: string, key: readonly string[]): string {
  return [
    `CREATE TEMP TABLE IF NOT EXISTS ${RETAINED_GUARD} (proven INTEGER NOT NULL CHECK (proven = 1))`,
    'BEGIN IMMEDIATE',
    `INSERT OR ROLLBACK INTO temp.${RETAINED_GUARD} (proven) SELECT NOT EXISTS (SELECT 1 FROM main.${retainedName(table)} r ` +
      `WHERE NOT EXISTS (SELECT 1 FROM main.${table} t WHERE ${keyMatch(key)}))`,
    `DROP TRIGGER IF EXISTS main.${followDeletesTrigger(table)}`,
    `DROP TABLE main.${retainedName(table)}`,
    `DELETE FROM temp.${RETAINED_GUARD}`,
    'COMMIT',
  ].join(';\n');
}

/** The slice of the plugin's handle the settlement uses. */
export interface RetainedDb {
  select(sql: string, params?: unknown[]): Promise<any[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Ends every connection of the store's pool and opens a FRESH pool on the same file in its place, so
 * the handle the caller holds keeps working (`SqliteStorage.recyclePool`: the plugin keys its pools by
 * path, so a `Database.load` of the same path replaces the closed one under the same handle).
 */
export type PoolRecycler = () => Promise<void>;

/**
 * Runs a script that holds its own raw `BEGIN`, and RECYCLES THE CONNECTION POOL when it fails.
 *
 * sqlx does not track a transaction raw SQL opened, so a failure that is not a guard's `CHECK` (I/O,
 * a full disk) leaves the transaction open on one pooled connection, which would answer the session's
 * next writes with "database is locked". Closing the pool closes that connection and SQLite rolls the
 * open transaction back. A guard's `CHECK ... OR ROLLBACK` has already ended its transaction, but the
 * failure cannot tell the two apart and a recycled pool is cheap - so the rule is the same for both.
 *
 * RECYCLED, NEVER LEFT CLOSED: {@link settleRetainedTables} keeps a copy it cannot release and lets the
 * open go on, so a pool closed here and not replaced would fail every statement after it - and, the
 * copy being still there at the next open, every open after it: a store made unusable by the very
 * copy that exists to protect it.
 */
export async function executeOwnTransaction(
  db: RetainedDb,
  script: string,
  recycle: PoolRecycler
): Promise<void> {
  try {
    await db.execute(script);
  } catch (e) {
    // The caller says the script's failure (once). A recycle that fails is said here, at error:
    // the caller's next statement will fail on the pool, and this line is what names why.
    try {
      await recycle();
    } catch (recycleError) {
      console.error(
        `[SQLite] the pool could not be recycled after a failed script (${String(e)}): ${String(recycleError)}`
      );
    }
    throw e;
  }
}

/** What {@link settleRetainedTables} did with one copy. */
export interface RetainedOutcome {
  table: string;
  retained: number;
  live: number;
  /** Rows of the copy the live table lacked before the restore. */
  missing: number;
  released: boolean;
}

/**
 * Settles every copy a migration set aside: proved, restored where it must be, released once proved.
 * EVERY OPEN, FIRST - so a copy a kill or a defect left behind is restored before anything reads or
 * writes the table - and by the migration that made the copy, right after it.
 *
 * Never throws for one copy: a copy it cannot settle is KEPT and said at error, which is what keeps the
 * rows; the next open tries again.
 */
export async function settleRetainedTables(
  db: RetainedDb,
  recycle: PoolRecycler
): Promise<RetainedOutcome[]> {
  const rows: any[] = await db.select(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, length($1)) = $1",
    [RETAINED_PREFIX]
  );
  const outcomes: RetainedOutcome[] = [];
  for (const row of rows) {
    const table = String(row.name).slice(RETAINED_PREFIX.length);
    try {
      outcomes.push(await settleOne(db, table, recycle));
    } catch (e) {
      console.error(
        `[SQLite] the copy of ${table} could not be settled - it is KEPT for the next open: ${String(e)}`
      );
    }
  }
  return outcomes;
}

async function settleOne(
  db: RetainedDb,
  table: string,
  recycle: PoolRecycler
): Promise<RetainedOutcome> {
  const liveInfo: TableInfoRow[] = await db.select(`PRAGMA table_info(${table})`);
  const copyInfo: TableInfoRow[] = await db.select(`PRAGMA table_info(${retainedName(table)})`);
  const key = liveInfo
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => String(c.name));
  const copyColumns = new Set(copyInfo.map((c) => String(c.name)));
  if (liveInfo.length === 0 || key.length === 0 || !key.every((c) => copyColumns.has(c))) {
    throw new Error(
      `${table} is absent or has no primary key the copy carries (key: ${key.join(', ') || 'none'})`
    );
  }
  const count = async (sql: string) => Number((await db.select(sql))[0]?.n ?? 0);
  const retained = await count(`SELECT COUNT(*) AS n FROM main.${retainedName(table)}`);
  const live = await count(`SELECT COUNT(*) AS n FROM main.${table}`);
  const missing = await count(retainedMissingCountStatement(table, key));
  if (missing > 0) {
    console.error(
      `[SQLite] ${missing} of ${retained} row(s) set aside from ${table} are NOT in it (it holds ${live}) - restoring them from the copy`
    );
    const shared = liveInfo.map((c) => String(c.name)).filter((c) => copyColumns.has(c));
    await db.execute(retainedRestoreStatement(table, shared));
  }
  await executeOwnTransaction(db, retainedReleaseStatement(table, key), recycle);
  const after = await count(`SELECT COUNT(*) AS n FROM main.${table}`);
  console.info(
    `[SQLite] the copy of ${table} is released: ${retained} row(s) set aside, all held (${after} now${missing > 0 ? `, ${missing} restored` : ''})`
  );
  return { table, retained, live, missing, released: true };
}
