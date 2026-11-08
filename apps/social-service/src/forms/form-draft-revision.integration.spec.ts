/**
 * Migration 146 and the revision statements against a REAL PostgreSQL: the compare-and-set is ONE
 * statement (`writeFormDraft`), and only a database proves that two saves built on the same revision
 * cannot both land, that the counter only grows, and that a refused publication leaves the revision.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- form-draft-revision.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import {
  closeFormDraft,
  formsWithUnpublishedChanges,
  readFormDraft,
  writeFormDraft,
} from './form-draft-revision';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const FORM = '00000000-0000-4000-8000-0000000a0143';
const OTHER = '00000000-0000-4000-8000-0000000b0143';

maybe('form revisions against PostgreSQL (migration 146)', () => {
  const schema = `form_drafts_it_${Math.random().toString(36).slice(2, 10)}`;
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
      synchronize: false,
      extra: { options: `-c search_path=${schema},public`, max: 4 },
    });
    await ds.initialize();
    await q(`CREATE TABLE forms (id uuid PRIMARY KEY)`);
    await q(`INSERT INTO forms (id) VALUES ($1), ($2)`, [FORM, OTHER]);
    const migration = readFileSync(
      join(process.cwd(), 'src', 'migrations', '146_form_drafts.sql'),
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

  it('reads revision 0 and no document for a form never saved', async () => {
    expect(await readFormDraft(ds.manager, OTHER)).toEqual({
      revision: 0,
      document: null,
      savedAt: null,
    });
  });

  it('lets exactly one of two saves built on the same revision land', async () => {
    const [a, b] = await Promise.all([
      writeFormDraft(ds.manager, FORM, 0, { title: 'A' }),
      writeFormDraft(ds.manager, FORM, 0, { title: 'B' }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b)!;
    expect(winner.revision).toBe(1);
    const stored = await readFormDraft(ds.manager, FORM);
    expect(stored.document).toEqual({ title: a ? 'A' : 'B' });
    // The next save names revision 1; one still naming 0 is refused.
    expect(await writeFormDraft(ds.manager, FORM, 1, { title: 'C' })).toMatchObject({
      revision: 2,
    });
    expect(await writeFormDraft(ds.manager, FORM, 0, { title: 'stale' })).toBeNull();
    expect(await formsWithUnpublishedChanges(ds.manager, [FORM, OTHER])).toEqual(new Set([FORM]));
  });

  it('only grows: an emptied revision refuses the number it had, and a fresh base 0', async () => {
    await ds.transaction(async (m) => {
      await readFormDraft(m, FORM, true);
      expect(await closeFormDraft(m, FORM)).toBe(3);
    });
    expect(await readFormDraft(ds.manager, FORM)).toMatchObject({ revision: 3, document: null });
    expect(await writeFormDraft(ds.manager, FORM, 2, { title: 'old tab' })).toBeNull();
    expect(await writeFormDraft(ds.manager, FORM, 0, { title: 'old tab' })).toBeNull();
    expect(await formsWithUnpublishedChanges(ds.manager, [FORM])).toEqual(new Set());
    expect(await writeFormDraft(ds.manager, FORM, 3, { title: 'D' })).toMatchObject({
      revision: 4,
    });
  });

  it('keeps the revision when the publication that held it is rolled back', async () => {
    await expect(
      ds.transaction(async (m) => {
        await readFormDraft(m, FORM, true);
        await closeFormDraft(m, FORM);
        throw new Error('the edit rules refused it');
      })
    ).rejects.toThrow('the edit rules refused it');
    expect(await readFormDraft(ds.manager, FORM)).toMatchObject({
      revision: 4,
      document: { title: 'D' },
    });
  });

  it('makes a save wait for the publication holding the row, then refuses it', async () => {
    let release!: () => void;
    let signalLocked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const locked = new Promise<void>((r) => (signalLocked = r));
    const publication = ds.transaction(async (m) => {
      await readFormDraft(m, FORM, true);
      signalLocked();
      await held;
      await closeFormDraft(m, FORM);
    });
    // The save starts only once the publication holds the row: it waits, then finds its base moved.
    await locked;
    const save = writeFormDraft(ds.manager, FORM, 4, { title: 'during' });
    release();
    await publication;
    expect(await save).toBeNull();
    expect(await readFormDraft(ds.manager, FORM)).toMatchObject({ revision: 5, document: null });
  });

  it('goes with its form', async () => {
    await q(`DELETE FROM forms WHERE id = $1`, [FORM]);
    expect(await readFormDraft(ds.manager, FORM)).toMatchObject({ revision: 0 });
  });
});
