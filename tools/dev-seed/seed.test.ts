/**
 * THE DEV SEED, CHECKED AGAINST THE ENTITIES IT LANDS IN AND AGAINST THE PROMISE IT MAKES.
 *
 * Every assertion here stands in for a failure that would otherwise surface on the box, mid-reset,
 * inside the transaction that has just truncated dev - which rolls back cleanly, but only tells
 * you after the fact and only on the estate. So the questions are asked on the pull request:
 *
 *   - is the committed `infrastructure/dev/seed.sql` what the generator produces, every time;
 *   - is every person, association and address in it visibly fake;
 *   - does every reference inside the set point at a row the set contains;
 *   - does the SQL name only tables and columns the ENTITIES declare, give every column an INSERT
 *     cannot omit, and use only the values a closed type allows - derived by parsing the entity
 *     files, so a renamed column fails here and not on dev.
 *
 * Run by `make test-ci-scripts`: `bun test ./tools/dev-seed/`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entityFiles, parseEntityFile, readSchema } from './entities';
import {
  REPO_ROOT,
  SEED_EMAIL_DOMAIN,
  SEED_MARKER,
  SEED_SQL_PATH,
  type SeedRows,
  buildSeed,
  renderSql,
  userId,
} from './seed';

const rows: SeedRows = buildSeed();
const schema = readSchema(REPO_ROOT);

/** Every string value anywhere in the seed, JSON included, for the "is it fake" sweeps. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    if ('expr' in value) return [];
    return Object.values(value).flatMap(strings);
  }
  return [];
}

const ids = (table: string, column = 'id') => new Set(rows[table].map((r) => r[column]));

describe('determinism', () => {
  test('two renders are byte-identical', () => {
    expect(renderSql(buildSeed())).toBe(renderSql(buildSeed()));
  });

  test('the committed seed.sql is the generator output (run `bun tools/dev-seed/seed.ts --write`)', () => {
    const committed = readFileSync(join(REPO_ROOT, SEED_SQL_PATH), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderSql(rows));
  });

  test('no clock and no randomness reach the SQL: every time is relative to now()', () => {
    const sql = renderSql(rows);
    expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const value of Object.values(rows)
      .flat()
      .flatMap((r) => Object.values(r))) {
      if (value && typeof value === 'object' && 'expr' in value) {
        expect(value.expr).toMatch(
          /^(now\(\) - interval '\d+ days \d+ hours'|date_trunc\('day', now\(\)\) \+ interval '\d+ days \d+ hours')$/
        );
      }
    }
  });
});

describe('the SQL is data and nothing else', () => {
  const sql = renderSql(rows);
  const code = sql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .replace(/'(?:[^']|'')*'/g, "''");

  test('it carries no transaction control and no statement but INSERT', () => {
    expect(code).not.toMatch(
      /\b(BEGIN|COMMIT|ROLLBACK|TRUNCATE|DELETE|UPDATE|DROP|ALTER|CREATE|GRANT|COPY)\b/i
    );
    const statements = code
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) expect(s.startsWith('INSERT INTO "')).toBe(true);
  });

  test('the header the reset script reads matches the rows', () => {
    expect(sql).toContain(`-- seed-users: ${rows.users.length}\n`);
    expect(sql).toContain(`-- seed-marker: ${SEED_MARKER}\n`);
    expect(sql).toContain(`-- seed-tables: ${Object.keys(rows).join(' ')}\n`);
  });

  test('no media, no push token, nothing under MLS', () => {
    const forbidden =
      /^(push_token|key_package|one_time_key_package|dm_|mls_|queued_message|channel|workspace|pin_verifier|revoked_device|device_signature_key|auth_sessions)/;
    for (const table of Object.keys(rows)) expect(table).not.toMatch(forbidden);
    for (const list of Object.values(rows)) {
      for (const row of list) {
        for (const column of Object.keys(row)) {
          expect(column.toLowerCase()).not.toMatch(/media|logourl|imageurl|attachments|images/);
        }
      }
    }
  });
});

describe('every person and every address is fake', () => {
  test('every user carries the marker as last name and in the display name', () => {
    expect(rows.users.length).toBeGreaterThan(0);
    for (const u of rows.users) {
      expect(u.lastName).toBe(SEED_MARKER);
      expect(String(u.displayName)).toEndWith(` ${SEED_MARKER}`);
    }
  });

  test('every user id is the sha256 derivation of a public key, in the shape mentions expect', () => {
    for (const u of rows.users) expect(String(u.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.users[0].id).toBe(userId('alice'));
  });

  test('every association name says it is fictional', () => {
    for (const a of rows.associations) expect(String(a.name)).toMatch(/Fictif|Fictive/);
  });

  test('every e-mail anywhere is on the reserved, never-resolving domain', () => {
    const emails = Object.values(rows)
      .flat()
      .flatMap((r) => strings(r))
      .flatMap((s) => s.match(/[^\s@'"]+@[^\s@'"]+/g) ?? []);
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) expect(e).toEndWith(`@${SEED_EMAIL_DOMAIN}`);
  });

  test('no EMSE address and no real-looking school domain', () => {
    for (const s of Object.values(rows)
      .flat()
      .flatMap((r) => strings(r))) {
      expect(s.toLowerCase()).not.toMatch(/emse\.fr|mines-stetienne|rootz/);
    }
  });
});

describe('references inside the set resolve', () => {
  const users = ids('users');
  const associations = ids('associations');
  const fks: [string, string, Set<unknown>, boolean][] = [
    ['associations', 'createdBy', users, false],
    ['associations', 'categoryId', ids('association_categories'), true],
    ['association_audiences', 'associationId', associations, false],
    ['spaces', 'bdeAssociationId', associations, true],
    ['association_members', 'associationId', associations, false],
    ['association_members', 'userId', users, false],
    ['association_follows', 'followerUserId', users, false],
    ['association_follows', 'associationId', associations, false],
    ['user_follows', 'followerUserId', users, false],
    ['user_follows', 'followedUserId', users, false],
    ['association_calendar_events', 'associationId', associations, false],
    ['association_calendar_events', 'createdBy', users, false],
    ['association_calendar_events', 'validatedBy', users, true],
    ['posts', 'authorId', users, false],
    ['posts', 'associationId', associations, true],
  ];
  for (const [table, column, target, nullable] of fks) {
    test(`${table}.${column}`, () => {
      for (const row of rows[table]) {
        const value = row[column];
        if (value === null && nullable) continue;
        expect(target.has(value)).toBe(true);
      }
    });
  }

  test('ids are unique per table, and unique keys hold', () => {
    for (const [table, list] of Object.entries(rows)) {
      expect(new Set(list.map((r) => r.id)).size).toBe(list.length);
      void table;
    }
    expect(ids('associations', 'slug').size).toBe(rows.associations.length);
    expect(ids('association_categories', 'slug').size).toBe(rows.association_categories.length);
    const pairs = (t: string, a: string, b: string) =>
      new Set(rows[t].map((r) => `${r[a]}|${r[b]}`));
    expect(pairs('association_members', 'associationId', 'userId').size).toBe(
      rows.association_members.length
    );
    expect(pairs('spaces', 'formation', 'campus').size).toBe(10);
  });
});

describe('the SQL fits the schema the entities declare', () => {
  test('the parser reads every entity file it is given, so an empty schema cannot pass', () => {
    const files = entityFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(50);
    const parsed = files.map((f) => parseEntityFile(REPO_ROOT, f)).filter(Boolean);
    expect(parsed.length).toBe(files.length);
    expect(schema.get('users')?.columns.has('lastName')).toBe(true);
    // The decorator, not the property, names the column: `post.media` lives in `images`.
    expect(schema.get('posts')?.columns.has('images')).toBe(true);
    expect(schema.get('posts')?.columns.has('media')).toBe(false);
    expect(schema.get('platform_config')?.columns.has('min_client_version')).toBe(true);
  });

  for (const [table, list] of Object.entries(rows)) {
    describe(table, () => {
      const declared = schema.get(table);

      test('is a table an entity declares', () => {
        expect(declared).toBeDefined();
      });

      test('names only declared, insertable columns', () => {
        for (const column of Object.keys(list[0] ?? {})) {
          const c = declared?.columns.get(column);
          expect(c, `${table}.${column} is not declared by ${declared?.file}`).toBeDefined();
          expect(c?.readOnly, `${table}.${column} is insert: false`).toBe(false);
        }
      });

      test('provides every column an INSERT cannot omit', () => {
        const given = new Set(Object.keys(list[0] ?? {}));
        for (const c of declared?.columns.values() ?? []) {
          if (!c.optional) expect(given.has(c.name), `${table}.${c.name} is required`).toBe(true);
        }
      });

      test('writes only the values a closed type allows', () => {
        for (const row of list) {
          for (const [column, value] of Object.entries(row)) {
            const allowed = declared?.columns.get(column)?.allowed;
            if (!allowed || value === null) continue;
            expect(allowed, `${table}.${column}`).toContain(value as string);
          }
        }
      });
    });
  }
});
