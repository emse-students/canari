/**
 * Batching a multi-row INSERT into single statements, because a multi-statement TRANSACTION is not
 * available to us.
 *
 * `tauri-plugin-sql` opens the database with sqlx's `Pool::connect`, i.e. `PoolOptions::default()`,
 * whose `max_connections` is 10 - so `execute('BEGIN')`, the INSERTs and `execute('COMMIT')` are
 * three independent acquisitions that may land on three different connections. The transaction then
 * stays open on whichever connection began it and is released back to the pool, while the COMMIT
 * goes somewhere that never began one.
 *
 * Measured on device 2026-08-11: two `BEGIN`s issued concurrently on the same handle BOTH
 * succeeded, and one of the two `ROLLBACK`s that followed answered "cannot rollback - no
 * transaction is active" - the same string the app had been logging under load, alongside
 * "cannot start a transaction within a transaction" and "database is locked". The consequence was
 * not cosmetic: a `Persist sent` and an `Enqueue` failed outright, which is a message the sender
 * does not keep.
 *
 * So a statement is the largest unit of atomicity we can actually obtain: one `execute` is one
 * acquisition, and SQLite wraps a lone statement in its own implicit transaction. A batch larger
 * than the bound-parameter ceiling becomes several statements and is therefore no longer atomic as
 * a whole - which is acceptable here, and only here, because every row is written with
 * `INSERT OR REPLACE` under a primary key the caller already holds: re-running the batch converges.
 * A torn BEGIN/COMMIT across two connections has no such property.
 */

/**
 * The most conservative `SQLITE_MAX_VARIABLE_NUMBER` in the wild.
 *
 * SQLite raised the default to 32766 in 3.32, and the bundled build is newer than that - but the
 * ceiling is a COMPILE-TIME option of whichever library the plugin links, which is not ours to
 * choose and differs per platform. Sizing to the old default costs one extra statement per ~200
 * messages and removes the question.
 */
export const MAX_BOUND_PARAMETERS = 999;

/** Columns bound per message row in {@link messageInsertSql}. */
export const MESSAGE_COLUMNS = 5;

/** Rows per INSERT statement: the largest batch that cannot exceed the parameter ceiling. */
export const MESSAGE_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMETERS / MESSAGE_COLUMNS);

/**
 * `INSERT OR REPLACE` for `rows` message rows, with positional placeholders.
 *
 * The placeholders are numbered across the whole statement (`$1…$5`, `$6…$10`, …) because that is
 * what the plugin's SQLite binding expects; a repeated `$1` per tuple would bind every row to the
 * first message.
 */
export function messageInsertSql(rows: number): string {
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(`messageInsertSql needs at least one row, got ${rows}`);
  }
  const tuples = Array.from({ length: rows }, (_, row) => {
    const base = row * MESSAGE_COLUMNS;
    const placeholders = Array.from(
      { length: MESSAGE_COLUMNS },
      (_, column) => `$${base + column + 1}`
    );
    return `(${placeholders.join(', ')})`;
  });
  return (
    'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, cipher_text) VALUES ' +
    tuples.join(', ')
  );
}

/** Splits `items` into consecutive runs of at most `size`, preserving order. Never yields []. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
