import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_ERASURE_COVERAGE, ERASURE_STATEMENTS } from './account-erasure';

/**
 * EVERY COLUMN THAT CAN NAME AN ACCOUNT HAS A DISPOSITION, AND EVERY DISPOSITION HAS A STATEMENT.
 *
 * The erasure used to be a hand-written list, and it missed comments, reactions and votes on other
 * people's posts, form answers, reminders, notifications, minesweeper, reviewer grants and a dozen
 * authorship columns - because nothing compared the list with the schema. This reads the schema:
 * every `*.entity.ts`, plus the tables that exist only as migration SQL, against the shared
 * definition of "a column that holds an account id" (`libs/contracts/account-reference-columns.json`,
 * also read by chat-delivery-service). Source parsing rather than TypeORM metadata, because the
 * metadata needs a DataSource and the assertion is about what the files say.
 */
const contract = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'account-reference-columns.json'),
    'utf8'
  )
) as { pattern: string; excludeSuffixes: string[] };
const pattern = new RegExp(contract.pattern, 'i');

/** A column name is matched with its underscores removed, so `granted_by` reads as `grantedby`. */
const refersToAccount = (column: string): boolean =>
  pattern.test(column.replace(/_/g, '')) &&
  !contract.excludeSuffixes.some(
    (s) => column.endsWith(s) || column.endsWith(`_${s.toLowerCase()}`)
  );

/** Tables created by migration SQL with no entity: the scan of entities cannot see them. */
const RAW_TABLES = ['read_grants', 'read_grant_journal'];

const SRC = join(__dirname, '..');

function entityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...entityFiles(path));
    else if (name.endsWith('.entity.ts')) out.push(path);
  }
  return out;
}

/** Every column of every table this service owns, as `table.column`. */
function allColumns(): string[] {
  const out: string[] = [];
  for (const file of entityFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const table = /@Entity\(\s*'([a-z_]+)'/.exec(source)?.[1];
    if (!table) continue;
    // The DATABASE name: a decorator's `name: 'user_id'` wins over the property's own name.
    const props = source.matchAll(
      /@(?:Primary)?(?:Generated)?Column([\s\S]*?)\n\s+(?:readonly\s+)?(\w+)[!?]?:/g
    );
    for (const [, decorator, prop] of props) {
      out.push(`${table}.${/name:\s*'(\w+)'/.exec(decorator)?.[1] ?? prop}`);
    }
  }
  const migrations = join(SRC, 'migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(migrations, file), 'utf8');
    for (const table of RAW_TABLES) {
      const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(
        sql
      )?.[1];
      if (!body) continue;
      for (const line of body.split('\n')) {
        const column = /^\s*"?([a-zA-Z_]+)"?\s+[a-z]/.exec(line)?.[1];
        if (column) out.push(`${table}.${column}`);
      }
    }
  }
  return [...new Set(out)].sort();
}

/** The columns whose name says they hold an account id. */
function accountReferences(columns: string[]): string[] {
  return columns.filter((c) => refersToAccount(c.split('.')[1]));
}

describe('account erasure coverage (social)', () => {
  const columns = allColumns();
  const found = accountReferences(columns);

  it('finds the columns it is meant to find, so an empty scan cannot pass', () => {
    expect(found).toEqual(
      expect.arrayContaining([
        'posts.authorId',
        'submissions.email',
        'read_grants.user_id',
        'read_grant_journal.actor',
      ])
    );
  });

  it('gives every account-naming column a disposition', () => {
    expect(found.filter((c) => !(c in ACCOUNT_ERASURE_COVERAGE))).toEqual([]);
  });

  it('classifies nothing that is not a column any more', () => {
    // Against EVERY column, not only the matched ones: `submissions.answers` names no account and
    // is still erased, with the row it belongs to.
    expect(Object.keys(ACCOUNT_ERASURE_COVERAGE).filter((c) => !columns.includes(c))).toEqual([]);
  });

  it('carries out every delete and anonymisation with a statement that names its column', () => {
    const unbacked = Object.entries(ACCOUNT_ERASURE_COVERAGE)
      .filter(([, d]) => d.action === 'delete' || d.action === 'anonymise')
      .filter(([key, d]) => {
        const [table, column] = key.split('.');
        const col = ('via' in d && d.via) || column;
        const verb = d.action === 'delete' ? /^\s*DELETE FROM/ : /^\s*UPDATE/;
        return !ERASURE_STATEMENTS.some(
          (s) =>
            verb.test(s.sql) &&
            new RegExp(`\\b${table}\\b`).test(s.sql) &&
            (s.sql.includes(`"${col}"`) || new RegExp(`\\b${col}\\b`).test(s.sql))
        );
      })
      .map(([key]) => key);
    expect(unbacked).toEqual([]);
  });

  it('gives every kept column its reason', () => {
    const shortReasons = Object.entries(ACCOUNT_ERASURE_COVERAGE).filter(
      ([, d]) => d.action === 'kept' && d.reason.length <= 20
    );
    expect(shortReasons).toEqual([]);
  });

  it('binds the account id and the replacement as parameters, never by interpolation', () => {
    for (const s of ERASURE_STATEMENTS) {
      expect(s.sql).toContain('$1');
      expect(s.sql).not.toContain('${');
    }
  });
});
