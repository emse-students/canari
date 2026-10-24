/**
 * The slice of Tauri's SQL plugin the OUTBOX statements of `SqliteStorage` use, over a Map - so a
 * test drives the REAL storage class (its codec, its blob store, its write order) and can inject a
 * failure or a kill at any one statement. Shared by the blob-store suite and the RC-5 outbox suite.
 */
import type { SqliteStorage } from '$lib/db/sqlite';

/** A row as the `outbox` table holds it. */
export type FakeOutboxRow = Record<string, any>;

/** The fake database, its rows, and every statement it was handed (for byte budgets). */
export function fakeOutboxSql() {
  const rows = new Map<string, FakeOutboxRow>();
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async execute(sql: string, params: any[] = []) {
      executed.push({ sql, params });
      if (sql.includes('INSERT OR REPLACE INTO outbox')) {
        const [
          id,
          conv,
          sent,
          kind,
          status,
          attempts,
          last,
          next,
          serverErrors,
          created,
          iv,
          cipher,
        ] = params;
        rows.set(id, {
          id,
          conversation_id: conv,
          sent_at: sent,
          kind,
          status,
          attempts,
          last_attempt_at: last,
          next_attempt_at: next,
          server_errors: serverErrors,
          created_at: created,
          iv,
          cipher_text: cipher,
        });
      } else if (sql.includes('DELETE FROM outbox WHERE id')) {
        rows.delete(params[0]);
      } else if (sql.includes('UPDATE outbox SET')) {
        // COALESCE($n, column): a null parameter keeps the column.
        const row = rows.get(params[0]);
        if (row) {
          row.status = params[1] ?? row.status;
          row.attempts = params[2] ?? row.attempts;
          row.last_attempt_at = params[3] ?? row.last_attempt_at;
          row.next_attempt_at = params[4] ?? row.next_attempt_at;
          row.server_errors = params[5] ?? row.server_errors;
        }
      }
      return { rowsAffected: 1 };
    },
    async select(sql: string, params: any[] = []) {
      if (sql.includes('SELECT id FROM outbox WHERE id')) {
        return rows.has(params[0]) ? [{ id: params[0] }] : [];
      }
      if (sql.includes('SELECT id FROM outbox')) return [...rows.keys()].map((id) => ({ id }));
      if (sql.includes('SELECT kind FROM outbox')) {
        const r = rows.get(params[0]);
        return r ? [{ kind: r.kind }] : [];
      }
      if (sql.includes('SELECT * FROM outbox WHERE id')) {
        const r = rows.get(params[0]);
        return r ? [r] : [];
      }
      if (sql.includes('FROM outbox ORDER BY sent_at')) {
        // The light queue read: a media row's ciphertext is not selected.
        return [...rows.values()]
          .sort((a, b) => a.sent_at - b.sent_at || String(a.id).localeCompare(String(b.id)))
          .map((r) => (r.kind === 'media' ? { ...r, iv: null, cipher_text: null } : { ...r }));
      }
      throw new Error(`unexpected select: ${sql}`);
    },
  };
  return { db, rows, executed };
}

/**
 * Puts {@link fakeOutboxSql} under a real `SqliteStorage` the TEST constructed (its blobs stay in
 * fake-IndexedDB). The caller constructs it: `backendChoice.test.ts` allows naming a backend in a
 * test file and nowhere else.
 */
export function attachFakeOutboxSql(storage: SqliteStorage) {
  const sql = fakeOutboxSql();
  (storage as unknown as { db: unknown }).db = sql.db;
  return sql;
}
