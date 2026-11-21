/**
 * AN ANONYMOUS FORM'S ANSWERS ARE STORED IN BATCHES, against a REAL PostgreSQL (migration 178).
 *
 * `FormsService.submit`, `setClosed` and `getSubmissions` run for real, and so do the sweep and
 * `retireForms`. What only a database shows: the batch moves in ONE write that no registry row shares
 * (the system column `xmin` read directly), nothing stored carries the time an answer was given, a
 * closing form's last answers join the latest group, a waiting answer holds its place on a full form,
 * and an archived form's answers are released rather than lost.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- anonymous-answer-batches.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';
import { ANONYMOUS_BATCH_SIZE } from './anonymous-answer-batches';
import { AnonymousAnswerReleaseScheduler } from './anonymous-answer-release.scheduler';
import { retireForms } from './retire-forms';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const OWNER = 'o'.repeat(64);
/** Respondents: distinct accounts, `u` + a padded index. */
const member = (n: number) => `u${String(n).padStart(63, '0')}`;

const ITEMS = [{ id: 'q1', label: 'Avis', type: 'short_text', required: true }];

maybe('anonymous answers stored in batches, against PostgreSQL (migration 178)', () => {
  const schema = `anon_batches_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let sweep: AnonymousAnswerReleaseScheduler;
  let next = 0;

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
    // Migration 178 as written, twice: it must be idempotent.
    const migration = readFileSync(
      join(__dirname, '../migrations/178_form_answers_held.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    await ds.query('RESET lock_timeout');
    await ds.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, archived boolean NOT NULL DEFAULT false)`
    );
    await ds.query(
      `CREATE TABLE users (id text PRIMARY KEY, "firstName" text, "lastName" text, campus text)`
    );

    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(OpeningReminder),
      { get: () => 'https://canari.example' } as any,
      { mayAct: async () => false, namesByIds: async () => new Map() } as any,
      { cotisationModeOf: async () => 'simple' } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      {
        build: async (input: { answers: Record<string, string[]> }) => ({
          cursus: [{ promo: null, formation: null }],
          cotisationTiers: [],
          answers: input.answers,
        }),
      } as any,
      ds.getRepository(FormRespondent),
      {} as any, // FormFilesService: an anonymous form holds no file question
      { enabled: () => false } as any,
      {} as any // FormItemImagesService
    );
    sweep = new AnonymousAnswerReleaseScheduler(ds);
    for (const level of ['log', 'debug', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function makeForm(over: Partial<Form> = {}): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: OWNER,
        title: 'Sondage',
        basePrice: 0,
        currency: 'eur',
        requiresPayment: false,
        anonymous: true,
        items: ITEMS,
        ...over,
      } as Partial<Form>)
    );
    return form.id;
  }

  /** `count` answers from accounts never used before, one submit each. */
  async function answer(formId: string, count: number): Promise<unknown[]> {
    const replies: unknown[] = [];
    for (let i = 0; i < count; i++) {
      next += 1;
      replies.push(
        await service.submit(formId, { userId: member(next), answers: { q1: `avis ${next}` } })
      );
    }
    return replies;
  }

  const n = async (sql: string, params: unknown[]) => Number((await ds.query(sql, params))[0].n);
  const stored = (formId: string) =>
    n(`SELECT count(*) AS n FROM submissions WHERE "formId" = $1`, [formId]);
  const held = (formId: string) =>
    n(`SELECT count(*) AS n FROM form_answers_held WHERE "formId" = $1`, [formId]);
  /** The distinct writes (`xmin`) the form's stored answers came from. */
  const writes = (formId: string) =>
    n(`SELECT count(DISTINCT xmin::text) AS n FROM submissions WHERE "formId" = $1`, [formId]);
  /** Stored answers sharing a write with ANY registry row - the pairing that must never exist. */
  const sharedWithRegistry = () =>
    n(
      `SELECT count(*) AS n FROM submissions s
        WHERE s."userId" IS NULL AND EXISTS (
          SELECT 1 FROM form_respondents r WHERE r.xmin::text = s.xmin::text)`,
      []
    );

  it('migration 178 makes a table that names and dates nothing, and is idempotent', async () => {
    const columns: { column_name: string; data_type: string }[] = await ds.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'form_answers_held' ORDER BY column_name`,
      [schema]
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'answers',
      'formId',
      'id',
      'lines',
      'priceLockedItemIds',
      'respondentIdentity',
    ]);
    expect(columns.some((c) => c.data_type.startsWith('timestamp'))).toBe(false);
  });

  it('holds answers below a batch, then stores the batch in one write no registry row shares', async () => {
    const formId = await makeForm();
    const first = await answer(formId, ANONYMOUS_BATCH_SIZE - 1);
    expect(first.every((reply) => JSON.stringify(reply) === '{"held":true}')).toBe(true);
    expect(await stored(formId)).toBe(0);
    expect(await held(formId)).toBe(ANONYMOUS_BATCH_SIZE - 1);
    // The registry is written at once: it is what refuses a second answer.
    expect(
      await n(`SELECT count(*) AS n FROM form_respondents WHERE "formId" = $1`, [formId])
    ).toBe(ANONYMOUS_BATCH_SIZE - 1);

    await answer(formId, 1);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE);
    expect(await writes(formId)).toBe(1);
    expect(await sharedWithRegistry()).toBe(0);

    // Nothing stored carries the instant: every date of the row is the release's UTC day.
    const clocks: { exact: string }[] = await ds.query(
      `SELECT count(*) FILTER (WHERE "createdAt" <> date_trunc('day', "createdAt")
                                  OR "updatedAt" <> "createdAt"
                                  OR "paymentRequestedAt" <> "createdAt") AS exact
         FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(Number(clocks[0].exact)).toBe(0);
    const rows: { userId: string | null; email: string | null; answers: unknown }[] =
      await ds.query(`SELECT "userId", email, answers FROM submissions WHERE "formId" = $1`, [
        formId,
      ]);
    expect(rows.every((row) => row.userId === null && row.email === null)).toBe(true);
  });

  it('still refuses a second answer from the same account while its first waits', async () => {
    const formId = await makeForm();
    next += 1;
    const who = member(next);
    await service.submit(formId, { userId: who, answers: { q1: 'un' } });
    const second = service.submit(formId, { userId: who, answers: { q1: 'deux' } });
    await expect(second).rejects.toBeInstanceOf(HttpException);
    await expect(second).rejects.toMatchObject({ response: { code: 'ALREADY_ANSWERED' } });
    expect(await held(formId)).toBe(1);
  });

  it('counts a waiting answer against the form capacity', async () => {
    const formId = await makeForm({ maxSubmissions: 2 });
    await answer(formId, 2);
    await expect(answer(formId, 1)).rejects.toMatchObject({ response: { code: 'FORM_FULL' } });
    expect(await held(formId)).toBe(2);
  });

  it('on close, the last answers below a batch join the latest group, in one write', async () => {
    const formId = await makeForm();
    await answer(formId, ANONYMOUS_BATCH_SIZE + 2);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE);
    expect(await held(formId)).toBe(2);

    await service.setClosed(formId, true, OWNER, false);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE + 2);
    // The two did not form a group of their own: the whole form is one write, one date.
    expect(await writes(formId)).toBe(1);
    expect(
      await n(`SELECT count(DISTINCT "createdAt") AS n FROM submissions WHERE "formId" = $1`, [
        formId,
      ])
    ).toBe(1);
    expect(await sharedWithRegistry()).toBe(0);
  });

  it('a form that never reached a batch delivers every answer once its end date came', async () => {
    const formId = await makeForm();
    await answer(formId, 2);
    // A manager reading the answers of an OPEN form releases nothing below a batch.
    expect(await service.getSubmissions(formId)).toHaveLength(0);
    expect(await service.heldAnswers(formId)).toEqual({ held: 2, batchSize: ANONYMOUS_BATCH_SIZE });

    await ds.query(`UPDATE forms SET "closedAt" = now() - interval '1 minute' WHERE id = $1`, [
      formId,
    ]);
    expect(await sweep.releaseOnce()).toBeGreaterThanOrEqual(2);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(2);
    expect(await writes(formId)).toBe(1);
    // Idempotent: nothing is due any more.
    expect(await held(formId)).toBe(0);
    expect(await sweep.releaseOnce()).toBe(0);
  });

  it('the sweep releases a full batch whose release after its submit did not happen', async () => {
    const formId = await makeForm();
    // As a crash between the submit's commit and its release would leave it.
    for (let i = 0; i < ANONYMOUS_BATCH_SIZE; i++) {
      await ds.query(
        `INSERT INTO form_answers_held ("formId", answers) VALUES ($1, '{"q1":"x"}'::jsonb)`,
        [formId]
      );
    }
    await sweep.releaseOnce();
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE);
  });

  it('retiring a form whose answers wait archives it and releases them, never losing one', async () => {
    const formId = await makeForm();
    await answer(formId, 1);
    const result = await ds.transaction((m) => retireForms(m, { formId }));
    expect(result).toEqual({ archived: 1, deleted: 0 });
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(1);
  });

  it('after every path above, no stored anonymous answer shares a write with the registry', async () => {
    expect(await sharedWithRegistry()).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM form_answers_held`, [])).toBe(
      2 + 1 // the capacity form and the second-answer form, both still open
    );
  });
});
