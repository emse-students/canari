/**
 * Every method that WRITES messages drops the reconciliation's cached state key.
 *
 * A grep, deliberately, and for the same reason as the single-writer guard in
 * `conversations.retire.test.ts`: the defect this protects against is a NEW write path added by
 * someone who never read `historyStateKey.ts`, and no unit test can observe a path that does not
 * exist yet. The two backends are separate classes with separate write sites, so "IndexedDB was
 * updated and SQLite was not" is the shape the mistake actually takes.
 *
 * The consequence of missing one is not a slow cache: the key stands for "what this device holds",
 * so a stale one makes the device agree with a peer it no longer matches, and the difference is
 * never exchanged. The reverse mistake - invalidating too eagerly - costs one walk of the store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_DIR = join(process.cwd(), 'src', 'lib', 'db');

/**
 * Splits a storage class into its methods, keyed by name.
 *
 * Both files are one class of two-space-indented methods, so the boundary is unambiguous without a
 * parser - and a parser here would be a second thing to keep correct.
 */
function methodsOf(file: string): Map<string, string> {
  const source = readFileSync(join(DB_DIR, file), 'utf8');
  const lines = source.split('\n');
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of lines) {
    const start = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (start) {
      if (name) out.set(name, body.join('\n'));
      name = start[1];
      body = [];
    }
    body.push(line);
  }
  if (name) out.set(name, body.join('\n'));
  return out;
}

/** Whether the body drops the cached key itself, or hands the write to a method that does. */
const invalidates = (body: string) =>
  /invalidate(?:All)?HistoryStateKeys?\(/.test(body) ||
  /this\.(?:saveMessages?|deleteMessagesForConversation|deleteMessagesInTransaction)\(/.test(body);

/**
 * `init` runs the schema migrations, before this session has read - and so cached - anything, and
 * `constructor` writes nothing. Everything else that touches the message rows is in scope.
 */
const EXEMPT = new Set(['init', 'constructor']);

describe.each([
  {
    file: 'sqlite.ts',
    // Any statement that mutates the table. `SELECT` is deliberately not here, and the conflict
    // clause is optional because both writers use one (`INSERT OR REPLACE`, `INSERT OR IGNORE`).
    // `messageInsertSql(` is the same write one call further out: `saveMessages` builds its
    // statement in `sqliteBatch.ts`, so matching only literal SQL would miss the busiest site.
    writes:
      /(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE)\s+messages\b|messageInsertSql\(/,
  },
  {
    file: 'indexeddb.ts',
    // A readwrite transaction naming the message store. A `readonly` one cannot change anything.
    writes: /transaction\((?:\[[^\]]*'messages'[^\]]*\]|'messages')\s*,\s*'readwrite'\)/,
  },
])('$file', ({ file, writes }) => {
  it('invalidates the cached state key in every method that writes messages', () => {
    const offenders: string[] = [];
    for (const [name, body] of methodsOf(file)) {
      if (EXEMPT.has(name)) continue;
      if (writes.test(body) && !invalidates(body)) offenders.push(name);
    }
    expect(
      offenders,
      `these ${file} methods write messages without dropping the cached history state key`
    ).toEqual([]);
  });

  it('finds the write sites it claims to be checking', () => {
    // Without this the guard passes vacuously the day a regex stops matching - a rename of the
    // store, a reformat that breaks the call across lines - and reports nothing while checking
    // nothing.
    const writers = [...methodsOf(file)].filter(
      ([name, body]) => !EXEMPT.has(name) && writes.test(body)
    );
    // Five, today: the batch insert, the two per-conversation deletes, the import, and the two
    // whole-store sweeps - minus whichever of them delegates rather than writing itself.
    expect(writers.length).toBeGreaterThanOrEqual(5);
  });
});
