/**
 * Migration 145 and the respondent `where` against a REAL PostgreSQL: the unit spec's fake honours
 * the clause by construction, so only a database proves the column, its default, its CHECK and the
 * conditional publish write.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- form-status.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { FORM_DRAFT, FORM_PUBLISHED, assertFormNotDraft, respondentFormWhere } from './form-status';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const OLD = '00000000-0000-4000-8000-00000000f142';
const DRAFT = '00000000-0000-4000-8000-00000000f143';

maybe('form status against PostgreSQL', () => {
  const schema = `form_status_it_${Math.random().toString(36).slice(2, 10)}`;
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
      entities: [Form],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The columns the reads below name, and one form written BEFORE the migration.
    await q(`CREATE TABLE forms (id uuid PRIMARY KEY, "deletedAt" timestamptz,
      "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q(`INSERT INTO forms (id) VALUES ($1)`, [OLD]);
    const migration = readFileSync(
      join(process.cwd(), 'src', 'migrations', '145_forms_status.sql'),
      'utf8'
    );
    await q(migration);
    // Idempotent for CD: a second run changes nothing and does not fail.
    await q(migration);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('publishes every form that existed before it, and a row naming no status', async () => {
    const [old] = await q(`SELECT status FROM forms WHERE id = $1`, [OLD]);
    expect(old.status).toBe(FORM_PUBLISHED);
  });

  it('refuses a status outside draft | published', async () => {
    await expect(
      q(`INSERT INTO forms (id, status) VALUES (gen_random_uuid(), 'hidden')`)
    ).rejects.toThrow(/forms_status_check/);
  });

  it('hides a draft from the respondent where, and shows it once published', async () => {
    await q(`INSERT INTO forms (id, status) VALUES ($1, 'draft')`, [DRAFT]);
    const repo = ds.getRepository(Form);
    const read = (id: string) =>
      repo.findOne({ select: { id: true }, where: respondentFormWhere(id) });
    expect(await read(DRAFT)).toBeNull();
    expect(await read(OLD)).toMatchObject({ id: OLD });
    await expect(assertFormNotDraft(ds.manager, DRAFT, 'a post')).rejects.toMatchObject({
      response: { code: 'FORM_IS_DRAFT' },
    });

    // The publish write of `FormsService.publish`: conditional on the draft, so a second one is 0.
    const publish = () =>
      repo
        .createQueryBuilder()
        .update(Form)
        .set({ status: FORM_PUBLISHED })
        .where('id = :id AND status = :draft', { id: DRAFT, draft: FORM_DRAFT })
        .execute();
    expect((await publish()).affected).toBe(1);
    expect((await publish()).affected).toBe(0);
    expect(await read(DRAFT)).toMatchObject({ id: DRAFT });
    await expect(assertFormNotDraft(ds.manager, DRAFT, 'a post')).resolves.toBeUndefined();
  });
});
