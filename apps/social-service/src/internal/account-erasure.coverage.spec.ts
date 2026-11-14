import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import { ACCOUNT_ERASURE_COVERAGE, ERASURE_STATEMENTS } from './account-erasure';

/**
 * EVERY COLUMN THAT CAN HOLD AN ACCOUNT ID HAS A DISPOSITION, AND EVERY DISPOSITION HAS A STATEMENT.
 *
 * The erasure used to be a hand-written list, and it missed comments, reactions and votes on other
 * people's posts, form answers, reminders, notifications, minesweeper, reviewer grants and a dozen
 * authorship columns - because nothing compared the list with the schema. This reads the schema:
 *
 * - every entity, through TYPEORM'S OWN METADATA (the decorators' arguments as TypeORM recorded
 *   them, database names included) - a regex over the source mis-read multi-line decorators and
 *   missed columns outright;
 * - the tables that exist only as migration SQL ({@link RAW_TABLES}), checked against every
 *   `CREATE TABLE` in the migrations so a new migration-only table cannot ship unclassified.
 *
 * A column can hold an account id in two ways, and both are found: its NAME says so (the shared
 * definition, `libs/contracts/account-reference-columns.json`, also read by chat-delivery-service),
 * or its TYPE is a container - `jsonb`, `json`, `simple-array`, `simple-json`, an array - which can
 * carry ids inside it whatever it is called (`posts.comments`, `posts.mentions`, `posts.reactions`).
 */
const contract = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'account-reference-columns.json'),
    'utf8'
  )
) as { pattern: string; excludeSuffixes: string[] };
const pattern = new RegExp(contract.pattern, 'i');

/** A column name is matched with its underscores removed, so `granted_by` reads as `grantedby`. */
const namesAnAccount = (column: string): boolean =>
  pattern.test(column.replace(/_/g, '')) &&
  !contract.excludeSuffixes.some(
    (s) => column.endsWith(s) || column.endsWith(`_${s.toLowerCase()}`)
  );

const CONTAINER_TYPES = new Set(['jsonb', 'json', 'simple-array', 'simple-json']);

/**
 * Tables created by migration SQL with no entity, and their account-holding columns' types: the
 * metadata cannot see them. Asserted against the migrations below, in both directions.
 */
const RAW_TABLES = [
  // The global association categories, read by no code since migration 147 (per-map carte zones)
  // and kept only until their drop: a label, a slug, an order - no account, nothing to erase.
  // Removed from this list BY the drop migration
  // (docs/wiki/backlog.d/drop-the-global-association-categories.md).
  'association_categories',
  'read_grants',
  'read_grant_journal',
  // Migration 132's per-reader switch "voit les commentaires": the reader, who set it.
  'read_grant_readers',
  'post_audiences',
  'channel_message_client_tombstones',
  // Migration 106's audit copy of the logo URLs it rewrote: association ids and URLs, no account.
  'association_logo_url_rewrites',
  // Migration 118's Lydia cashiers: the person, who added them, a sealed phone.
  'lydia_cashiers',
  // Migration 125's delegation acceptances: two association ids, who accepted, when.
  'payment_delegation_acceptances',
  // Migration 135's retired post ids: an id and a date, no account - written BY the erasure's own
  // delete of the member's posts, so a resend of one never brings it back.
  'deleted_post_ids',
  // Migration 080's per-association mute: its entity went with engagement WP-3, which copied the
  // rows into `account_bells` (migration 143); the table stays until its held drop.
  'association_push_mutes',
  // Migration 127's per-space pins (WP-PIN): who pinned.
  'post_space_pins',
  // Migration 129's dependency journal: the platform admin who changed a parent or a governor.
  'dependency_journal',
  // Migration 146's unpublished form revisions: a form id and the form's own content, no account -
  // they go with their form (ON DELETE CASCADE), as its other content does.
  'form_drafts',
  // Migration 155's dismissed follow suggestions (engagement WP-5): the reader, and a person target.
  'follow_suggestion_dismissals',
  // Migration 156's replay cap evictions (docs/wiki/live-replays.md): a live id, byte counts and a
  // date, no account - and pruned at 30 days by the live sweep.
  'live_replay_cap_evictions',
  // Migration 167's Lydia account bridges (lydia-account-bridge.ts): an association id, two
  // Business vendor tokens, a sealed Business key, readiness and counts - no account.
  'lydia_account_bridges',
  // Migration 168's Businesses Canari's enrolment created (lydia-contract-flux.ts): a vendor token,
  // an association id, a date - no account.
  'lydia_enrolled_businesses',
  // Migration 157's daily push counters (engagement WP-8): the recipient's own rows.
  'engagement_push_days',
  // Migration 163's weekly campus-trend counters: the reader's own rows.
  'campus_trend_weeks',
  // Migration 159 (engagement WP-9): the activity setting and the told-once ledger.
  'user_activity_settings',
  'post_engagement_notices',
];

const SRC = join(__dirname, '..');

function files(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, suffix));
    else if (name.endsWith(suffix)) out.push(path);
  }
  return out;
}

interface FoundColumn {
  key: string;
  container: boolean;
}

/** Every column of every entity, as TypeORM itself records it. */
function entityColumns(): FoundColumn[] {
  for (const file of files(SRC, '.entity.ts')) require(file);
  const storage = getMetadataArgsStorage();
  const tableOf = new Map<unknown, string>();
  for (const t of storage.tables) {
    if (t.type === 'regular' && typeof t.name === 'string') tableOf.set(t.target, t.name);
  }
  const out: FoundColumn[] = [];
  for (const c of storage.columns) {
    const table = tableOf.get(c.target);
    if (!table) continue;
    const type = typeof c.options.type === 'string' ? c.options.type : '';
    out.push({
      key: `${table}.${c.options.name ?? c.propertyName}`,
      container: CONTAINER_TYPES.has(type) || c.options.array === true,
    });
  }
  for (const j of storage.joinColumns) {
    const table = tableOf.get(j.target);
    if (table && j.name) out.push({ key: `${table}.${j.name}`, container: false });
  }
  return out;
}

const MIGRATIONS = join(SRC, 'migrations');
const migrationSql = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));

/** The columns of the migration-only tables, from their `CREATE TABLE`. */
function rawColumns(): FoundColumn[] {
  const out: FoundColumn[] = [];
  for (const sql of migrationSql()) {
    for (const table of RAW_TABLES) {
      const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(
        sql
      )?.[1];
      if (!body) continue;
      for (const line of body.split('\n')) {
        // Either case for the type (migration 090 spells it `VARCHAR`, 078 `varchar`), and a
        // table constraint (`PRIMARY KEY (...)`) is not a column.
        const m = /^\s*"?([a-zA-Z_]+)"?\s+([a-z]+)/i.exec(line);
        if (m && !/^(PRIMARY|CONSTRAINT|CHECK|UNIQUE|FOREIGN)$/i.test(m[1]))
          out.push({ key: `${table}.${m[1]}`, container: /^(jsonb|json)$/i.test(m[2]) });
      }
    }
  }
  return out;
}

const all = [...entityColumns(), ...rawColumns()];
const columns = [...new Set(all.map((c) => c.key))].sort();
const mustBeClassified = [
  ...new Set(
    all.filter((c) => c.container || namesAnAccount(c.key.split('.')[1])).map((c) => c.key)
  ),
].sort();

describe('account erasure coverage (social)', () => {
  it('reads the schema it is meant to read, so an empty scan cannot pass', () => {
    expect(mustBeClassified).toEqual(
      expect.arrayContaining(
        [
          'posts.authorId',
          'posts.comments',
          'posts.mentions',
          'posts.reactions',
          'submissions.email',
          'associations.isBDE',
          'read_grants.user_id',
          'read_grant_journal.actor',
          // An upper-case column type (`VARCHAR`) is read too.
          'channel_message_client_tombstones.authorId',
        ].filter((k) => k !== 'associations.isBDE')
      )
    );
    // A multi-line decorator is read as TypeORM reads it: the column name, never an option.
    expect(columns).toContain('associations.isBDE');
    expect(columns).toContain('association_calendar_events.status');
    expect(columns).not.toContain('association_calendar_events.type');
  });

  it('knows every table the migrations create without an entity', () => {
    const entityTables = new Set(entityColumns().map((c) => c.key.split('.')[0]));
    const created = new Set<string>();
    for (const sql of migrationSql()) {
      for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS "?([a-z_]+)"?/g)) created.add(m[1]);
    }
    const unknown = [...created].filter((t) => !entityTables.has(t) && !RAW_TABLES.includes(t));
    expect(unknown).toEqual([]);
    expect(RAW_TABLES.filter((t) => !created.has(t))).toEqual([]);
  });

  it('gives every column that can hold an account id a disposition', () => {
    expect(mustBeClassified.filter((c) => !(c in ACCOUNT_ERASURE_COVERAGE))).toEqual([]);
  });

  it('classifies nothing that is not a column any more', () => {
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

  it('gives every kept or code-carried column its reason', () => {
    const short = Object.entries(ACCOUNT_ERASURE_COVERAGE).filter(
      ([, d]) =>
        (d.action === 'kept' && d.reason.length <= 20) || (d.action === 'code' && d.by.length <= 20)
    );
    expect(short).toEqual([]);
  });

  it('binds the account id and the replacement as parameters, never by interpolation', () => {
    for (const s of ERASURE_STATEMENTS) {
      expect(s.sql).toContain('$1');
      expect(s.sql).not.toContain('${');
    }
  });
});
