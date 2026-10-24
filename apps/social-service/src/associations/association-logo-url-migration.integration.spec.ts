/**
 * Migration 106 against a REAL PostgreSQL: the rows it rewrites, the rows it leaves, and the audit
 * copy it keeps of every value it changes - so a rewrite never loses a value silently, a legitimate
 * `http://` logo included.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (CI's
 * `test-social-integration` sets it and fails on a skipped test):
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- association-logo-url-migration.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '106_association_logo_url_allowlist.sql'),
  'utf8'
);

const OWN = '00000000-0000-4000-8000-000000000001';
const HTTPS = '00000000-0000-4000-8000-000000000002';
const PLAIN_HTTP = '00000000-0000-4000-8000-000000000003';
const MARKUP_WITH_MEDIA = '00000000-0000-4000-8000-000000000004';
const NONE = '00000000-0000-4000-8000-000000000005';
const MEDIA = '00000000-0000-4000-8000-0000000000a1';

maybe('migration 106 against PostgreSQL (association logo URL allowlist)', () => {
  const schema = `logo_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;
  const notices: string[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    client.on('notice', (n) => notices.push(n.message ?? ''));
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The minimal shape the migration touches - the ORM owns the rest in real life.
    await client.query(`CREATE TABLE associations (
      id uuid PRIMARY KEY, "logoUrl" varchar, "logoMediaId" uuid,
      "updatedAt" timestamptz NOT NULL DEFAULT '2026-01-02T03:04:05Z')`);
    await client.query(
      `INSERT INTO associations (id, "logoUrl", "logoMediaId") VALUES
        ($1, '/api/media/public/${MEDIA}?v=12', $6),
        ($2, 'https://example.org/logo.png', NULL),
        ($3, 'http://example.org/logo.png', NULL),
        ($4, 'https://x.test/a.png" data-x="1', $6),
        ($5, NULL, NULL)`,
      [OWN, HTTPS, PLAIN_HTTP, MARKUP_WITH_MEDIA, NONE, MEDIA]
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('applies twice without error, and the second run changes nothing', async () => {
    await client.query(MIGRATION);
    await client.query(MIGRATION);
    expect(notices.filter((n) => n.startsWith('migration 106:'))).toEqual([
      'migration 106: 2 association logo URL(s) rewritten, old values kept in association_logo_url_rewrites',
      'migration 106: 0 association logo URL(s) rewritten, old values kept in association_logo_url_rewrites',
    ]);
  });

  it('keeps a value inside the allowlist and rewrites the others', async () => {
    const { rows } = await client.query(`SELECT id, "logoUrl" FROM associations ORDER BY id`);
    expect(rows).toEqual([
      { id: OWN, logoUrl: `/api/media/public/${MEDIA}?v=12` },
      { id: HTTPS, logoUrl: 'https://example.org/logo.png' },
      { id: PLAIN_HTTP, logoUrl: null },
      { id: MARKUP_WITH_MEDIA, logoUrl: `/api/media/public/${MEDIA}` },
      { id: NONE, logoUrl: null },
    ]);
  });

  it('copies every changed value, with its updatedAt, before rewriting it', async () => {
    const { rows } = await client.query(
      `SELECT "associationId", "oldLogoUrl", "newLogoUrl", "associationUpdatedAt",
              "rewrittenAt" IS NOT NULL AS stamped
         FROM association_logo_url_rewrites ORDER BY "associationId"`
    );
    expect(rows).toEqual([
      {
        associationId: PLAIN_HTTP,
        oldLogoUrl: 'http://example.org/logo.png',
        newLogoUrl: null,
        associationUpdatedAt: new Date('2026-01-02T03:04:05Z'),
        stamped: true,
      },
      {
        associationId: MARKUP_WITH_MEDIA,
        oldLogoUrl: 'https://x.test/a.png" data-x="1',
        newLogoUrl: `/api/media/public/${MEDIA}`,
        associationUpdatedAt: new Date('2026-01-02T03:04:05Z'),
        stamped: true,
      },
    ]);
  });
});
