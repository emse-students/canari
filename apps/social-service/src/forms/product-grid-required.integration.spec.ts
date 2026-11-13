/**
 * MIGRATION 164 AGAINST A REAL PostgreSQL: every stored priced grid's "Obligatoire" switch turned
 * off (owner, 2026-11-13), on a copy of the shapes production holds - a merch form of four grids
 * beside a required text question, a form holding no grid, a grid already off, a soft-deleted form,
 * an open revision built on its form and one whose base had already moved.
 *
 * What only the database shows: the rewrite keeps every other question, key and the order of the
 * array; it is idempotent; an open revision at its base FOLLOWS the rewrite (its publication is not
 * refused as "changed since"), one already behind stays behind; and the ROLLBACK statement written
 * in the migration's header - read from the file, so the two cannot drift - restores the flags.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- product-grid-required.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { formChangedSinceRevision, writeFormDraft } from './form-draft-revision';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'migrations');
const MIGRATION_164 = readFileSync(join(MIGRATIONS, '164_product_grid_required_off.sql'), 'utf8');

/**
 * The ROLLBACK statement of 164's header: its comment lines indented under `-- ROLLBACK:`, the
 * `--   ` stripped. Read from the file, so the statement proven here is the one documented there.
 */
function rollbackStatement(sql: string): string {
  const lines = sql.split('\n');
  const start = lines.findIndex((line) => line.startsWith('-- ROLLBACK:'));
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('--   ')) {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.slice('--   '.length));
  }
  return body.join('\n');
}

const grid = (id: string, label: string, required: unknown) => ({
  id,
  label,
  type: 'product_grid',
  required,
  imageUrl: null,
  productGrid: {
    rows: [{ id: 'noir', label: 'Noir' }],
    columns: [
      { id: 'm', label: 'M' },
      { id: 'l', label: 'L' },
    ],
    maxPerCell: 5,
    closedCells: [],
    pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 3000 } } },
  },
});
const NAME = { id: 'q-nom', label: 'Nom', type: 'short_text', required: true, options: [] };

maybe('migration 164 against PostgreSQL: every stored grid turned optional', () => {
  const schema = `grid_required_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const ids: Record<string, string> = {};

  const itemsOf = async (key: string) =>
    (await q(`SELECT items FROM forms WHERE id = $1`, [ids[key]]))[0].items as Array<
      Record<string, unknown>
    >;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, OpeningReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(readFileSync(join(MIGRATIONS, '146_form_drafts.sql'), 'utf8'));
    await q('RESET lock_timeout');

    const repo = ds.getRepository(Form);
    const save = async (key: string, items: unknown[], over: Partial<Form> = {}) => {
      const form = await repo.save(
        repo.create({
          ownerId: 'owner',
          title: key,
          basePrice: 0,
          currency: 'eur',
          requiresPayment: true,
          allowMultipleSubmissions: true,
          items,
          ...over,
        } as Partial<Form>)
      );
      ids[key] = form.id;
    };
    // As every editor before the switch stored them: `required: true` on each grid.
    await save('merch', [
      NAME,
      grid('sweat', 'Sweat capuche', true),
      grid('col-rond', 'Sweat col rond', true),
      grid('zip', 'Sweat zippe', true),
      grid('veste', 'Veste softshell', true),
    ]);
    await save('survey', [NAME], { requiresPayment: false });
    await save('already-off', [grid('g', 'Tote bag', false)]);
    await save('flag-absent', [{ ...grid('g', 'Mug', true), required: undefined }]);
    await save('deleted', [grid('g', 'Bonnet', true)], { deletedAt: new Date() } as Partial<Form>);
    await save('draft-at-base', [grid('g', 'Casquette', true)]);
    await save('draft-behind', [grid('g', 'Gourde', true)]);

    // An open revision built on its form as it stands...
    await writeFormDraft(ds.manager, ids['draft-at-base'], 0, { title: 'typed' }, null);
    // ...and one whose form was written since it started (an older build editing it directly).
    await writeFormDraft(ds.manager, ids['draft-behind'], 0, { title: 'typed' }, null);
    await q(`UPDATE forms SET title = 'written since' WHERE id = $1`, [ids['draft-behind']]);

    await q(MIGRATION_164);
    // Idempotent for CD: the second run writes nothing and fails nothing.
    await q(MIGRATION_164);
    await q('RESET lock_timeout');
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('turns every grid of the merch form off, and keeps everything else as it was', async () => {
    const items = await itemsOf('merch');
    expect(items.map((item) => [item.id, item.required])).toEqual([
      ['q-nom', true],
      ['sweat', false],
      ['col-rond', false],
      ['zip', false],
      ['veste', false],
    ]);
    // Only the flag moved: the definitions, labels and keys are the ones stored.
    expect(items[1]).toEqual({ ...grid('sweat', 'Sweat capuche', true), required: false });
    expect(items[0]).toEqual(NAME);
  });

  it('leaves a form with no grid and a grid already off as they were; writes a missing flag', async () => {
    expect(await itemsOf('survey')).toEqual([NAME]);
    expect((await itemsOf('already-off'))[0].required).toBe(false);
    expect((await itemsOf('flag-absent'))[0].required).toBe(false);
    expect((await itemsOf('deleted'))[0].required).toBe(false);
  });

  it('a revision built on its form follows the rewrite; one already behind stays behind', async () => {
    expect(await formChangedSinceRevision(ds.manager, ids['draft-at-base'])).toBe(false);
    expect(await formChangedSinceRevision(ds.manager, ids['draft-behind'])).toBe(true);
  });

  it('leaves no stored grid required: a second run has nothing to write', async () => {
    const [{ count }] = await q(
      `SELECT count(*)::int AS count FROM forms f, jsonb_array_elements(f.items) AS i(item)
        WHERE i.item ->> 'type' = 'product_grid'
          AND i.item -> 'required' IS DISTINCT FROM 'false'::jsonb`
    );
    expect(count).toBe(0);
  });

  it('the ROLLBACK of its header restores every grid to required, and nothing else', async () => {
    const statement = rollbackStatement(MIGRATION_164);
    expect(statement).toMatch(/^UPDATE forms f SET items/);
    await q(statement);
    expect((await itemsOf('merch')).map((item) => item.required)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(await itemsOf('survey')).toEqual([NAME]);
    // And the migration runs again over the rolled-back rows (a redeploy after the rollback).
    await q(MIGRATION_164);
    await q('RESET lock_timeout');
    expect((await itemsOf('merch')).slice(1).every((item) => item.required === false)).toBe(true);
  });
});
