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
import type { SealedStore } from './types';

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
export const MESSAGE_COLUMNS = 7;

/** Rows per INSERT statement: the largest batch that cannot exceed the parameter ceiling. */
export const MESSAGE_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMETERS / MESSAGE_COLUMNS);

/**
 * `INSERT OR REPLACE` for `rows` message rows, with positional placeholders.
 *
 * The placeholders are numbered across the whole statement (`$1…$6`, `$7…$12`, …) because that is
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
    'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending) VALUES ' +
    tuples.join(', ')
  );
}

/** Columns bound per outbox row in {@link outboxInsertSql}. */
export const OUTBOX_COLUMNS = 12;

/**
 * Outbox rows ONE statement can carry. A chat-reel take and its sends (RC-13) must fit in one: they
 * are written atomically or not at all, never split across statements.
 */
export const OUTBOX_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMETERS / OUTBOX_COLUMNS);

/**
 * `INSERT OR REPLACE` for `rows` outbox rows, placeholders numbered across the whole statement like
 * {@link messageInsertSql}. One row is the ordinary queued entry; several are a chat-reel take and
 * its sends, which ONE statement makes atomic.
 */
export function outboxInsertSql(rows: number): string {
  if (!Number.isInteger(rows) || rows < 1 || rows > OUTBOX_ROWS_PER_STATEMENT) {
    throw new Error(`outboxInsertSql takes 1 to ${OUTBOX_ROWS_PER_STATEMENT} rows, got ${rows}`);
  }
  const tuples = Array.from({ length: rows }, (_, row) => {
    const base = row * OUTBOX_COLUMNS;
    const placeholders = Array.from(
      { length: OUTBOX_COLUMNS },
      (_, column) => `$${base + column + 1}`
    );
    return `(${placeholders.join(', ')})`;
  });
  return (
    'INSERT OR REPLACE INTO outbox (id, conversation_id, sent_at, kind, status, attempts, last_attempt_at, next_attempt_at, server_errors, created_at, iv, cipher_text) VALUES ' +
    tuples.join(', ')
  );
}

/** The table and primary-key column behind each device-key-sealed store. */
const SEALED_STORE_TABLES: Record<SealedStore, { table: string; key: string }> = {
  messages: { table: 'messages', key: 'id' },
  graine: { table: 'graine', key: 'session_id' },
  outbox: { table: 'outbox', key: 'id' },
};

/** The table and key column of a sealed store, for the one `SELECT` that reads it. */
export function sealedStoreTable(store: SealedStore): { table: string; key: string } {
  return SEALED_STORE_TABLES[store];
}

/** Parameters bound per row in {@link sealedSwapSql}: id+iv, id+cipher, id+expected cipher. */
export const SEALED_SWAP_COLUMNS = 6;

/** Rows per compare-and-swap statement: the largest batch that cannot exceed the parameter ceiling. */
export const SEALED_SWAP_ROWS_PER_STATEMENT = Math.floor(
  MAX_BOUND_PARAMETERS / SEALED_SWAP_COLUMNS
);

/** One row of a sealed swap with its columns already in their TEXT form (base64). */
export interface SealedSwapText {
  id: string;
  expected: string;
  iv: string;
  cipherText: string;
}

/**
 * ONE statement that compare-and-swaps the sealed payload of `swaps.length` rows: a row changes only
 * if it still holds the ciphertext it was read with. One statement because a statement is the
 * largest unit of atomicity this plugin gives us (see the top of this file).
 *
 * The placeholders are numbered IN THE ORDER THEY APPEAR in the text, and the parameters returned
 * follow that same order - so the binding is right whether the driver binds `$N` by its number or by
 * its position. The two `CASE`s have no `ELSE`: the `WHERE` admits only rows named in the batch.
 */
export function sealedSwapStatement(
  store: SealedStore,
  swaps: readonly SealedSwapText[]
): { sql: string; params: string[] } {
  if (swaps.length < 1) throw new Error('sealedSwapStatement needs at least one row');
  const { table, key } = SEALED_STORE_TABLES[store];
  const params: string[] = [];
  const next = (value: string): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const ivCase = swaps.map((s) => `WHEN ${next(s.id)} THEN ${next(s.iv)}`).join(' ');
  const cipherCase = swaps.map((s) => `WHEN ${next(s.id)} THEN ${next(s.cipherText)}`).join(' ');
  const where = swaps
    .map((s) => `(${key} = ${next(s.id)} AND cipher_text = ${next(s.expected)})`)
    .join(' OR ');
  return {
    sql:
      `UPDATE ${table} SET iv = CASE ${key} ${ivCase} END, ` +
      `cipher_text = CASE ${key} ${cipherCase} END WHERE ${where}`,
    params,
  };
}

/** Parameters bound per row in {@link orderAtFillStatement}: id+key in the CASE, id in the IN list. */
export const ORDER_AT_FILL_COLUMNS = 3;

/** Rows per order-key fill statement: the largest batch that cannot exceed the parameter ceiling. */
export const ORDER_AT_FILL_ROWS_PER_STATEMENT = Math.floor(
  MAX_BOUND_PARAMETERS / ORDER_AT_FILL_COLUMNS
);

/**
 * ONE statement that writes the derived `order_at` of `rows.length` messages and clears their
 * `order_pending`, touching only the rows STILL pending: a row the app rewrote between the read and
 * this write already carries the key its own save computed, and the fill must not replace a fresher
 * value with the one it derived from the older ciphertext. Placeholders numbered in the order they
 * appear, like {@link sealedSwapStatement}.
 */
export function orderAtFillStatement(rows: ReadonlyArray<{ id: string; orderAt: number }>): {
  sql: string;
  params: Array<string | number>;
} {
  if (rows.length < 1) throw new Error('orderAtFillStatement needs at least one row');
  const params: Array<string | number> = [];
  const next = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const cases = rows.map((r) => `WHEN ${next(r.id)} THEN ${next(r.orderAt)}`).join(' ');
  const ids = rows.map((r) => next(r.id)).join(', ');
  return {
    sql: `UPDATE messages SET order_at = CASE id ${cases} END, order_pending = NULL WHERE order_pending = 1 AND id IN (${ids})`,
    params,
  };
}

/** Splits `items` into consecutive runs of at most `size`, preserving order. Never yields []. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
