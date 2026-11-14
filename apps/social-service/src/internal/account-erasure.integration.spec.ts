/**
 * THE SOCIAL ERASURE AGAINST A REAL POSTGRESQL: after it runs, NO ROW OF ANY TABLE IT TOUCHES STILL
 * CONTAINS THE ACCOUNT ID, and the other account's rows are untouched.
 *
 * The unit specs prove the statements exist and are wired; only a database proves they PARSE and
 * name real columns of the right type. The assertion is deliberately not per statement: it is
 * `row::text LIKE '%id%'` over every table, which a forgotten column cannot pass.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration specs here: CI provides no database,
 * so the file reports as skipped rather than passing. It needs a database that HAS the social
 * schema (a local estate's): each table is copied into a throwaway schema with `LIKE public.<table>`
 * (NOT NULL dropped so a fixture names only the columns it is about), and a table the estate does
 * not have yet is created from its migration. Nothing outside the throwaway schema is written.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/auth_db bun run test -- account-erasure.integration
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import {
  ACCOUNT_ERASURE_COVERAGE,
  ERASURE_STATEMENTS,
  eraseSocialRows,
  type SocialErasureResult,
} from './account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** Every `*.entity.ts` under `src`, loaded so TypeORM's metadata storage knows its table. */
async function loadEntities(dir = join(__dirname, '..')): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await loadEntities(path);
    else if (entry.name.endsWith('.entity.ts')) await import(path);
  }
}

/**
 * The entity class of a table production builds with TypeORM `synchronize` and no migration creates,
 * or undefined: a fresh scratch database lacks such a table, so the spec builds it from its entity
 * (CI synchronizes the whole schema, which is why only a local fresh-database run ever failed).
 */
function entityOfTable(table: string): Function | undefined {
  return getMetadataArgsStorage().tables.find((t) => t.name === table)?.target as
    | Function
    | undefined;
}

const ERASED = 'erased-it-0000';
const OTHER = 'other-it-0000';

/**
 * Every table a statement names, plus `posts` for the JSONB scrub and `spaces`, whose rows the
 * erasure locks before any map (`ERASURE_CARTE_SPACES_LOCK_SQL`).
 */
const TABLES = [
  ...new Set([
    'posts',
    'spaces',
    ...ERASURE_STATEMENTS.map((s) => /(?:FROM|UPDATE)\s+([a-z_]+)/.exec(s.sql)![1]),
  ]),
].sort();

/** The `CREATE TABLE IF NOT EXISTS <table> (...);` text of a migration, for a table the estate lacks. */
function createFromMigrations(table: string): string | null {
  const dir = join(__dirname, '..', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`).exec(sql);
    if (m) return m[0];
  }
  return null;
}

/** The `ADD COLUMN IF NOT EXISTS "<column>" <type>` clause a migration adds `column` with. */
function addColumnFromMigrations(table: string, column: string): string | null {
  const dir = join(__dirname, '..', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const m = new RegExp(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "?${column}"? ([a-z]+(?:\\(\\d+\\))?)`
    ).exec(sql);
    if (m) return `ADD COLUMN "${column}" ${m[1]}`;
  }
  return null;
}

maybe('account erasure against PostgreSQL', () => {
  let client: Client;
  const schema = `erasure_it_${Date.now()}`;
  /** Where the entity-built tables are synchronized, then copied from like `public`'s. */
  const buildSchema = `${schema}_build`;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await loadEntities();
    let builtFromEntities = false;
    for (const table of TABLES) {
      const exists = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const entity = exists.rowCount ? undefined : entityOfTable(table);
      if (entity) {
        if (!builtFromEntities) {
          // ALL entities, in one scratch schema: a relation names its neighbours, so one entity
          // alone does not initialise.
          const ds = new DataSource({
            type: 'postgres',
            url: URL,
            entities: getMetadataArgsStorage().tables.map((t) => t.target as Function),
            synchronize: false,
            // `public` stays on the path: an earlier spec of the same run may have installed
            // `uuid-ossp` there, and TypeORM's `CREATE EXTENSION IF NOT EXISTS` then installs
            // nothing - so `uuid_generate_v4()` resolves only through `public`.
            extra: { options: `-c search_path=${buildSchema},public` },
          });
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${buildSchema}`);
          await ds.initialize();
          await ds.synchronize();
          await ds.destroy();
          builtFromEntities = true;
        }
        await client.query(
          `CREATE TABLE ${schema}.${table} (LIKE ${buildSchema}.${table} INCLUDING DEFAULTS)`
        );
      } else if (exists.rowCount) {
        await client.query(
          `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`
        );
      } else {
        const ddl = createFromMigrations(table);
        if (!ddl) throw new Error(`no table ${table} in public and no migration creates it`);
        await client.query(`SET search_path TO ${schema}`);
        await client.query(ddl.replace(/REFERENCES\s+\w+\s*\([^)]*\)(\s+ON DELETE \w+)?/g, ''));
        // A fixture names only the columns it is about, so the key cannot be required either.
        await client.query(
          `ALTER TABLE ${schema}.${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`
        );
      }
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO'`,
        [schema, table]
      );
      for (const { column_name } of cols.rows) {
        await client.query(
          `ALTER TABLE ${schema}.${table} ALTER COLUMN "${column_name}" DROP NOT NULL`
        );
      }
    }
    // An estate a few migrations behind lacks the newest columns: add each covered one from the
    // migration that introduces it, so the test measures this code and not the estate's lag.
    for (const key of Object.keys(ACCOUNT_ERASURE_COVERAGE)) {
      const [table, column] = key.split('.');
      if (!TABLES.includes(table)) continue; // carried out by code, not by a statement here
      const present = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, table, column]
      );
      if (present.rowCount) continue;
      const add = addColumnFromMigrations(table, column);
      if (!add) throw new Error(`${key}: absent from the estate and added by no migration`);
      await client.query(`ALTER TABLE ${schema}.${table} ${add}`);
    }
    await client.query(`SET search_path TO ${schema}`);
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${buildSchema} CASCADE`);
    await client.end();
  });

  /** One row per covered column naming the erased account, and the same row naming the other one. */
  async function seed(): Promise<void> {
    for (const [key, d] of Object.entries(ACCOUNT_ERASURE_COVERAGE)) {
      if (d.action === 'kept' || d.action === 'code' || ('via' in d && d.via)) continue;
      // Seeded as a real token, a column and a comment text by `seedMention`.
      if (key === 'posts.mentions' || key === 'posts.markdown') continue;
      const [table, column] = key.split('.');
      for (const who of [ERASED, OTHER]) {
        const value = column === 'allowedUsers' ? `${who},third` : who;
        await client.query(`INSERT INTO ${table} ("${column}") VALUES ($1)`, [value]);
      }
    }
    await client.query(
      `INSERT INTO content_reports ("contentType", "contentId", "reporterId") VALUES ('user', $1, 'x')`,
      [ERASED]
    );
    await client.query(
      `INSERT INTO submissions ("userId", email, answers) VALUES ($1, 'me@example.org', '{"q":"mine"}')`,
      [ERASED]
    );
    // Somebody else's post carrying the erased account's comment, like, reaction and vote.
    await client.query(
      `INSERT INTO posts ("authorId", markdown, reactions, comments, polls)
       VALUES ($1, 'x', $2::jsonb, $3::jsonb, $4::jsonb)`,
      [
        OTHER,
        JSON.stringify({ [ERASED]: 'like', [OTHER]: 'love' }),
        JSON.stringify([
          { id: 'c1', userId: ERASED, displayName: 'Erased Person', text: 'mine', likes: [] },
          { id: 'c2', userId: OTHER, parentId: 'c1', text: 'reply', likes: [ERASED] },
        ]),
        JSON.stringify([
          {
            id: 'p',
            options: [{ id: 'a', votes: [ERASED, OTHER] }],
            votesByUser: { [ERASED]: ['a'], [OTHER]: ['a'] },
          },
        ]),
      ]
    );
  }

  /** Two associations the erased account is a member of, `CARTE.a1` with the other account too. */
  const CARTE = {
    a1: randomUUID(),
    a2: randomUUID(),
    a3: randomUUID(), // not one of the erased account's
    legacySpace: randomUUID(),
    rosterSpace: randomUUID(),
    strangerSpace: randomUUID(),
    legacyMap: randomUUID(),
    rosterMap: randomUUID(),
    strangerMap: randomUUID(),
  };
  /**
   * A realistic printed name with no id in it: a member of `CARTE.a3` who left, or the erased
   * account under its display name - the erasure cannot tell, which is the point.
   */
  const STRANGER_LINE = 'Camille Martin (Presidente) - Louis Bernard';
  /** The name the editor prints for an account; it holds the id, so a leftover name is found too. */
  const nameOf = (userId: string) => `Name of ${userId}`;

  /**
   * Two LIVE maps showing both accounts, as production holds them. The first was published before
   * rosters were stored: its directory prints the names in a `line` and carries no id. The second
   * carries its roster (`members`), and its line derived from it. Both have a card each and both
   * pick both accounts for a bubble's bureau; the second was created by the erased account. A third
   * map's ONLY trace of anyone is a legacy line of `CARTE.a3`, an association the erased account is
   * not a member of: no card, no pick, no id - nothing names the account, and it is still blanked.
   */
  async function seedCarte(): Promise<void> {
    await client.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, $3), ($1, $4), ($2, $3)`,
      [CARTE.a1, CARTE.a2, ERASED, OTHER]
    );
    await client.query(`INSERT INTO spaces (id) VALUES ($1), ($2), ($3)`, [
      CARTE.legacySpace,
      CARTE.rosterSpace,
      CARTE.strangerSpace,
    ]);
    const card = (userId: string) => ({ userId, name: nameOf(userId), role: 'President' });
    const layout = { bubbles: [{ assoId: CARTE.a1, selectedBureau: [ERASED, OTHER] }] };
    const units = [{ assoId: CARTE.a1, cards: [card(ERASED), card(OTHER)] }];
    const legacy = {
      units,
      directory: {
        heading: 'Annuaire',
        zones: [
          {
            label: 'Z',
            assos: [
              { assoId: CARTE.a1, line: `${nameOf(ERASED)} (Tresorier) - ${nameOf(OTHER)}` },
              { assoId: CARTE.a2, line: nameOf(ERASED) },
              { assoId: CARTE.a3, line: 'Third Person' },
            ],
          },
        ],
      },
    };
    const roster = {
      units,
      directory: {
        heading: 'Annuaire',
        zones: [
          {
            label: 'Z',
            assos: [
              {
                assoId: CARTE.a1,
                line: `${nameOf(ERASED)} (Tresorier) - ${nameOf(OTHER)}`,
                members: [
                  { userId: ERASED, name: nameOf(ERASED), role: 'Tresorier' },
                  { userId: OTHER, name: nameOf(OTHER), role: 'Membre' },
                ],
              },
            ],
          },
        ],
      },
    };
    await client.query(
      `INSERT INTO poster_projects (id, name, "spaceId", "createdBy", layout, publication, "publishedAt", "publicationFingerprint")
       VALUES ($1, 'legacy', $2, $3, $4::jsonb, $5::jsonb, now(), $6),
              ($7, 'roster', $8, $9, $4::jsonb, $10::jsonb, now(), $6)`,
      [
        CARTE.legacyMap,
        CARTE.legacySpace,
        OTHER,
        JSON.stringify(layout),
        JSON.stringify(legacy),
        'f'.repeat(64),
        CARTE.rosterMap,
        CARTE.rosterSpace,
        ERASED,
        JSON.stringify(roster),
      ]
    );
    const stranger = {
      units: [{ assoId: CARTE.a3, cards: [] }],
      directory: {
        heading: 'Annuaire',
        zones: [{ label: 'Z', assos: [{ assoId: CARTE.a3, line: STRANGER_LINE }] }],
      },
    };
    await client.query(
      `INSERT INTO poster_projects (id, name, "spaceId", "createdBy", layout, publication, "publishedAt", "publicationFingerprint")
       VALUES ($1, 'stranger', $2, $3, '{}'::jsonb, $4::jsonb, now(), $5)`,
      [CARTE.strangerMap, CARTE.strangerSpace, OTHER, JSON.stringify(stranger), 'f'.repeat(64)]
    );
  }

  /** A post by somebody else that MENTIONS the account: in its column, its text and a comment's. */
  async function seedMention(): Promise<void> {
    await client.query(
      `INSERT INTO posts ("authorId", markdown, mentions, comments)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        OTHER,
        `hello @[${ERASED.toUpperCase()}] and @[${OTHER}]`,
        `${ERASED},${OTHER}`,
        JSON.stringify([{ id: 'm1', userId: OTHER, text: `thanks @[${ERASED}]`, likes: [] }]),
      ]
    );
  }

  async function erase(): Promise<SocialErasureResult> {
    await client.query('BEGIN');
    try {
      const result = await eraseInTransaction();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // An aborted transaction refuses every later statement, the schema drop included - and the
      // open connection then holds the run for ever instead of reporting this error.
      await client.query('ROLLBACK');
      throw err;
    }
  }

  async function eraseInTransaction(): Promise<SocialErasureResult> {
    // The ONE implementation the route runs, over this connection.
    return eraseSocialRows(
      {
        write: async (sql, params) => (await client.query(sql, params)).rowCount ?? 0,
        read: async <T>(sql: string, params: unknown[]) =>
          (await client.query(sql, params)).rows as T[],
      },
      ERASED
    );
  }

  async function tablesStillNaming(id: string): Promise<string[]> {
    const out: string[] = [];
    for (const table of TABLES) {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE $1`,
        [`%${id}%`]
      );
      if (r.rows[0].n > 0) out.push(table);
    }
    return out;
  }

  it('leaves no row naming the account, keeps the other account, and is idempotent', async () => {
    await seed();
    await seedMention();
    await seedCarte();
    expect((await tablesStillNaming(ERASED)).length).toBeGreaterThan(10);
    const submissionsBefore = (await client.query(`SELECT count(*)::int AS n FROM submissions`))
      .rows[0].n;

    const first = await erase();
    expect(await tablesStillNaming(ERASED)).toEqual([]);

    // The other account is untouched wherever it was named - including the shared post.
    const otherTables = await tablesStillNaming(OTHER);
    expect(otherTables).toEqual(expect.arrayContaining(['posts', 'purchase_records', 'forms']));
    const post = (
      await client.query(`SELECT comments, polls, reactions FROM posts WHERE markdown = 'x'`)
    ).rows[0];
    expect(post.comments).toEqual([
      expect.objectContaining({ id: 'c2', parentId: null, likes: [] }),
    ]);
    expect(post.polls[0].options[0].votes).toEqual([OTHER]);
    expect(post.reactions).toEqual({ [OTHER]: 'love' });
    // A mention is anonymised in the column, the text and a comment; the other mention stays.
    const mention = (
      await client.query(
        `SELECT markdown, mentions, comments FROM posts WHERE markdown LIKE 'hello%'`
      )
    ).rows[0];
    expect(mention.markdown).toBe(`hello @[deleted] and @[${OTHER}]`);
    expect(mention.mentions).toBe(OTHER);
    expect(mention.comments[0].text).toBe('thanks @[deleted]');
    // Both maps stay live and keep the other member; the erased one leaves the cards, the rosters
    // and the layouts. EVERY legacy line prints names and no id, in every map: withheld.
    const maps = (
      await client.query(
        `SELECT name, layout, publication, "publishedAt", "publicationFingerprint", "createdBy"
           FROM poster_projects WHERE name IN ('legacy', 'roster')`
      )
    ).rows as {
      name: string;
      layout: unknown;
      publication: { units: { cards: unknown[] }[]; directory: { zones: { assos: unknown[] }[] } };
      publishedAt: Date | null;
      publicationFingerprint: string | null;
      createdBy: string;
    }[];
    const map = (name: string) => maps.find((m) => m.name === name)!;
    for (const m of maps) {
      expect(m.publishedAt).not.toBeNull();
      expect(m.publicationFingerprint).toBeNull();
      expect(m.layout).toEqual({ bubbles: [{ assoId: CARTE.a1, selectedBureau: [OTHER] }] });
      expect(m.publication.units[0].cards).toEqual([
        { userId: OTHER, name: nameOf(OTHER), role: 'President' },
      ]);
    }
    expect(map('legacy').publication.directory.zones[0].assos).toEqual([
      { assoId: CARTE.a1, line: '' },
      { assoId: CARTE.a2, line: '' },
      { assoId: CARTE.a3, line: '' },
    ]);
    // The map nothing ties to the account: its one legacy line is blanked all the same, and reported.
    const strangerMap = (
      await client.query(
        `SELECT publication, "publishedAt", "publicationFingerprint" FROM poster_projects WHERE id = $1`,
        [CARTE.strangerMap]
      )
    ).rows[0];
    expect(strangerMap.publishedAt).not.toBeNull();
    expect(strangerMap.publicationFingerprint).toBeNull();
    expect(strangerMap.publication.directory.zones[0].assos).toEqual([
      { assoId: CARTE.a3, line: '' },
    ]);
    expect(JSON.stringify(strangerMap.publication)).not.toContain('Camille');
    expect(first.cartesWithheld).toEqual(
      expect.arrayContaining([
        { id: CARTE.legacyMap, lines: 3 },
        { id: CARTE.strangerMap, lines: 1 },
      ])
    );
    expect(first.cartesWithheld).toHaveLength(2);
    expect(map('roster').publication.directory.zones[0].assos).toEqual([
      {
        assoId: CARTE.a1,
        line: nameOf(OTHER),
        members: [{ userId: OTHER, name: nameOf(OTHER), role: 'Membre' }],
      },
    ]);
    expect(map('roster').createdBy).not.toBe(ERASED);
    // A submission keeps its seat and loses its answers and address.
    const subs = await client.query(
      `SELECT count(*)::int AS seats,
              count(*) FILTER (WHERE answers::text LIKE '%mine%' OR email IS NOT NULL)::int AS named
         FROM submissions`
    );
    expect(subs.rows[0]).toEqual({ seats: submissionsBefore, named: 0 });

    // The queue's final pass: nothing left, nothing changes, nothing fails, nothing withheld again.
    const again = await erase();
    expect(again.cartesWithheld).toEqual([]);
    expect(await tablesStillNaming(ERASED)).toEqual([]);
  }, 120_000);
});
