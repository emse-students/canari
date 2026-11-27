import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Migration 187 as the deploy applies it. */
export const MIGRATION_187 = readFileSync(
  join(__dirname, '..', 'migrations', '187_formation_fsss_is_fisa.sql'),
  'utf8'
);

/** Every column migration 187 reads or rewrites, with the type a missing one is given here. */
const TOUCHED: readonly (readonly [table: string, column: string, type: string])[] = [
  ['spaces', 'formation', 'varchar(16)'],
  ['association_audiences', 'formation', 'varchar(16)'],
  ['read_grants', 'formation', 'varchar(16)'],
  ['agenda_subscriptions', 'formation', 'varchar(16)'],
  ['agenda_subscriptions', 'selectionKey', 'varchar(96)'],
  ['posts', 'reachSpaces', 'jsonb'],
  ['association_calendar_events', 'reachSpaces', 'jsonb'],
  ['users', 'formation', 'varchar(32)'],
  ['users', 'cursus', "jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ['forms', 'id', 'uuid'],
  ['forms', 'priceMatrix', 'jsonb'],
  ['forms', 'submitCondition', 'jsonb'],
  ['forms', 'items', "jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ['association_products', 'priceMatrix', 'jsonb'],
  ['form_drafts', 'formId', 'uuid'],
  ['form_drafts', 'document', 'jsonb'],
  ['form_drafts', 'baseFingerprint', 'text'],
  ['booking_spaces', 'audience', 'jsonb'],
  ['booking_spaces', 'items', "jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ['associations', 'slug', 'varchar(255)'],
  ['associations', 'name', 'varchar(255)'],
];

/**
 * Brings a test schema to the formations production holds after 1.8.3: what a file built through
 * 071 (spaces seeded FSSS, CHECKs on the old list) is respelt by the REAL migration 187, so the file
 * exercises the code against the values and constraints the deploy leaves - never a hand copy.
 *
 * A test schema is PARTIAL: each file builds the tables it exercises. 187 needs every table it
 * touches, so a missing table or column is created EMPTY in the file's own schema for the length of
 * the run and dropped right after - the file's schema leaves as it came, and a name the file resolves
 * through `public` still resolves there. Everything runs as ONE query, so a pooled caller keeps one
 * connection and one `search_path` throughout.
 *
 * @param query - The file's own query function, already on its schema's `search_path`.
 */
export async function applyFormationFisa(query: (sql: string) => Promise<unknown>): Promise<void> {
  const rows = (await query(
    `SELECT current_schema() AS schema, current_setting('search_path') AS path,
       coalesce((SELECT json_agg(table_name) FROM information_schema.tables
         WHERE table_schema = current_schema()), '[]') AS tables,
       coalesce((SELECT json_agg(table_name || '.' || column_name) FROM information_schema.columns
         WHERE table_schema = current_schema()), '[]') AS columns`
  )) as { rows?: unknown[] } | unknown[];
  const [here] = (Array.isArray(rows) ? rows : (rows.rows ?? [])) as {
    schema: string;
    path: string;
    tables: string[];
    columns: string[];
  }[];
  const tables = new Set(here.tables);
  const columns = new Set(here.columns);

  const created = [...new Set(TOUCHED.map(([t]) => t))].filter((t) => !tables.has(t));
  const added = TOUCHED.filter(([t, c]) => tables.has(t) && !columns.has(`${t}.${c}`));
  const build = [
    ...created.map(
      (t) =>
        `CREATE TABLE ${t} (${TOUCHED.filter(([table]) => table === t)
          .map(([, c, type]) => `"${c}" ${type}`)
          .join(', ')});`
    ),
    ...added.map(([t, c, type]) => `ALTER TABLE ${t} ADD COLUMN "${c}" ${type};`),
  ];
  const undo = [
    ...created.map((t) => `DROP TABLE ${t};`),
    ...added.map(([t, c]) => `ALTER TABLE ${t} DROP COLUMN "${c}";`),
  ];
  await query(
    [
      `SET search_path TO "${here.schema}";`,
      ...build,
      MIGRATION_187,
      ...undo,
      `SET search_path TO ${here.path};`,
    ].join('\n')
  );
}
