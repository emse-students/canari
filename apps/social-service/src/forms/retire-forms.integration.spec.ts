/**
 * `retireForms` against a REAL PostgreSQL. Its unit spec mocks the query builder, and the mock once
 * returned the parentheses `EXISTS` needs that TypeORM's `getQuery()` does not: every form and
 * association delete was a syntax error from v1.2.4 and no spec noticed. Only a database parses SQL.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- retire-forms.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { retireForms } from './retire-forms';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a1';
const WITH_SUB = '00000000-0000-4000-8000-00000000f001';
const EMPTY = '00000000-0000-4000-8000-00000000f002';

maybe('retireForms against PostgreSQL', () => {
  const schema = `retire_forms_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // Only the columns the two statements touch, and the RESTRICT key of migration 081.
    await q(`
      CREATE TABLE forms (id uuid PRIMARY KEY, "associationId" uuid,
        "deletedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE submissions (id uuid PRIMARY KEY,
        "formId" uuid NOT NULL REFERENCES forms (id) ON DELETE RESTRICT);
    `);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('archives a form that holds a submission and deletes one that holds none', async () => {
    await q(`INSERT INTO forms (id, "associationId") VALUES ($1, $3), ($2, $3)`, [
      WITH_SUB,
      EMPTY,
      ASSO,
    ]);
    await q(`INSERT INTO submissions (id, "formId") VALUES (gen_random_uuid(), $1)`, [WITH_SUB]);

    const result = await ds.transaction((manager) => retireForms(manager, { associationId: ASSO }));

    expect(result).toEqual({ archived: 1, deleted: 1 });
    const rows = await q(`SELECT id, "deletedAt" FROM forms`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(WITH_SUB);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it('retires one form by id', async () => {
    await q(`INSERT INTO forms (id, "associationId") VALUES ($1, NULL)`, [EMPTY]);
    const result = await ds.transaction((manager) => retireForms(manager, { formId: EMPTY }));
    expect(result).toEqual({ archived: 0, deleted: 1 });
  });
});
