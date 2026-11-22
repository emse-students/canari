/**
 * AN ANONYMOUS FORM'S ANSWERS ARE STORED IN BATCHES, against a REAL PostgreSQL (migration 178), and
 * dated by their WEEK only (migration 181, owner 2026-11-22).
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
import { HttpException, Logger, NotFoundException } from '@nestjs/common';
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
import {
  ANONYMOUS_BATCH_SIZE,
  anonymousAnswerWeekSql,
  HeldAnswersOutsideTransactionError,
  releaseHeldAnswers,
  releaseHeldAnswersUnderLock,
  SUBMISSION_COLUMNS_A_RELEASE_LEAVES_UNSET,
  SUBMISSION_COLUMNS_A_RELEASE_WRITES,
} from './anonymous-answer-batches';
import { lockFormSeats } from './seat-hold';
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
    // Both tables are vacuumed as soon as a row is gone: a released held row, and a joined group
    // written again, leave no old version waiting for the table to grow.
    const options: { relname: string; reloptions: string[] }[] = await ds.query(
      `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relname IN ('form_answers_held', 'submissions')
        ORDER BY c.relname`,
      [schema]
    );
    expect(options).toEqual(
      ['form_answers_held', 'submissions'].map((relname) => ({
        relname,
        reloptions: expect.arrayContaining([
          'autovacuum_vacuum_threshold=0',
          'autovacuum_vacuum_scale_factor=0',
        ]),
      }))
    );
  });

  it('the rewrite places every column of submissions: written, or left unset on purpose', async () => {
    // The table here is the entity's (`synchronize`), which mirrors the migrations. A column added
    // to it and to neither list fails this: a joining rewrite would otherwise drop it silently.
    const columns: { column_name: string }[] = await ds.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'submissions'`,
      [schema]
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [...SUBMISSION_COLUMNS_A_RELEASE_WRITES, ...SUBMISSION_COLUMNS_A_RELEASE_LEAVES_UNSET].sort()
    );
  });

  it('holds answers below a batch, then stores the batch in one write no registry row shares', async () => {
    const formId = await makeForm();
    const first = await answer(formId, ANONYMOUS_BATCH_SIZE - 1);
    expect(first.every((reply) => JSON.stringify(reply) === '{"held":true}')).toBe(true);
    // A waiting answer is held apart: in `form_answers_held`, nowhere in `submissions`.
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

    // Nothing stored carries the instant, nor the day: every date of the row is the start of the
    // release's ISO week, a Monday at 00:00 (owner, 2026-11-22).
    const clocks: { exact: string }[] = await ds.query(
      `SELECT count(*) FILTER (WHERE "createdAt" <> date_trunc('week', "createdAt")
                                  OR extract(isodow FROM "createdAt") <> 1
                                  OR "createdAt" <> ${anonymousAnswerWeekSql()}
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

  it('counts a waiting answer against the capacity, and a full form releases its tail', async () => {
    const formId = await makeForm({ maxSubmissions: 3 });
    await answer(formId, 2);
    expect(await held(formId)).toBe(2);
    // The answer that fills the form: a full form takes no more answers, so its tail is released.
    await answer(formId, 1);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(3);
    expect(await writes(formId)).toBe(1);
    await expect(answer(formId, 1)).rejects.toMatchObject({ response: { code: 'FORM_FULL' } });
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

  it('a joining group is written again in the SAME insert as the new answers, in its order', async () => {
    const formId = await makeForm();
    await answer(formId, ANONYMOUS_BATCH_SIZE + 2);
    const before: { q: string }[] = await ds.query(
      `SELECT answers->>'q1' AS q FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    await ds.query(`UPDATE forms SET "closedAt" = now() - interval '1 minute' WHERE id = $1`, [
      formId,
    ]);
    // A known order instead of the random one: the 2 new answers FIRST, then the joined group. Kept
    // in place, the old rows would come first in the table whatever order was asked.
    await ds.transaction(async (m) => {
      await lockFormSeats(m, formId);
      await releaseHeldAnswersUnderLock(m, formId, 'closed', (rows) => [...rows]);
    });
    const byPlace: { q: string }[] = await ds.query(
      `SELECT answers->>'q1' AS q FROM submissions WHERE "formId" = $1 ORDER BY ctid`,
      [formId]
    );
    const old = new Set(before.map((row) => row.q));
    expect(byPlace.map((row) => old.has(row.q))).toEqual([
      false,
      false,
      ...Array(ANONYMOUS_BATCH_SIZE).fill(true),
    ]);
    expect(await writes(formId)).toBe(1);
    // Every row is new: none keeps an id an older version of it carried.
    const ids: { id: string }[] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [
      formId,
    ]);
    expect(ids).toHaveLength(ANONYMOUS_BATCH_SIZE + 2);
  });

  it('a short tail is released once per form; a later one waits for a batch or the retirement', async () => {
    const formId = await makeForm();
    await answer(formId, 2);
    await service.setClosed(formId, true, OWNER, false);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(2);

    await service.setClosed(formId, false, OWNER, false);
    await answer(formId, 1);
    await service.setClosed(formId, true, OWNER, false);
    expect(await held(formId)).toBe(1);
    expect(await service.heldAnswers(formId)).toEqual({ held: 1, batchSize: ANONYMOUS_BATCH_SIZE });
    // Not due for the sweep either.
    await sweep.releaseOnce();
    expect(await held(formId)).toBe(1);

    // Retirement releases everything, joining the latest group in one write.
    await service.delete(formId, OWNER, false);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(3);
    expect(await writes(formId)).toBe(1);
  });

  it('a delete racing a release moves each answer exactly once, in one write', async () => {
    const formId = await makeForm();
    await answer(formId, ANONYMOUS_BATCH_SIZE + 2);
    await Promise.all([
      service.delete(formId, OWNER, false),
      releaseHeldAnswers(ds.manager, formId),
      releaseHeldAnswers(ds.manager, formId),
    ]);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE + 2);
    expect(
      await n(`SELECT count(DISTINCT answers->>'q1') AS n FROM submissions WHERE "formId" = $1`, [
        formId,
      ])
    ).toBe(ANONYMOUS_BATCH_SIZE + 2);
    expect(await writes(formId)).toBe(1);
  });

  /** A closed form with a full group stored and 2 answers waiting: a release joins that group. */
  async function formWithATailToJoin(): Promise<{ formId: string; id: string; q: string }> {
    const formId = await makeForm();
    await answer(formId, ANONYMOUS_BATCH_SIZE + 2);
    await ds.query(`UPDATE forms SET "closedAt" = now() - interval '1 minute' WHERE id = $1`, [
      formId,
    ]);
    const [row]: { id: string; q: string }[] = await ds.query(
      `SELECT id, answers->>'q1' AS q FROM submissions WHERE "formId" = $1 LIMIT 1`,
      [formId]
    );
    return { formId, ...row };
  }
  const copies = (formId: string, q: string) =>
    n(`SELECT count(*) AS n FROM submissions WHERE "formId" = $1 AND answers->>'q1' = $2`, [
      formId,
      q,
    ]);
  /** The manager's delete, as what it told: true deleted, false not found. */
  const deleteAs = (id: string) =>
    service.deleteSubmission(id, OWNER, false).then(
      () => true,
      (e: unknown) => {
        if (e instanceof NotFoundException) return false;
        throw e;
      }
    );

  it('an answer delete racing a tail join: the deleted content never comes back, the manager is told the truth', async () => {
    // Each order alone first. The delete before the release: gone, and the release does not bring it back.
    const before = await formWithATailToJoin();
    expect(await deleteAs(before.id)).toBe(true);
    await releaseHeldAnswers(ds.manager, before.formId);
    expect(await copies(before.formId, before.q)).toBe(0);
    expect(await stored(before.formId)).toBe(ANONYMOUS_BATCH_SIZE + 1);
    // The release before the delete: the answer lives under a new id, and the old id is not found.
    const after = await formWithATailToJoin();
    await releaseHeldAnswers(ds.manager, after.formId);
    expect(await deleteAs(after.id)).toBe(false);
    expect(await copies(after.formId, after.q)).toBe(1);

    // Then both at once, a few times: whichever takes the form's lock first, what the manager was
    // told is what the table holds.
    for (let round = 0; round < 5; round++) {
      const race = await formWithATailToJoin();
      const [deleted] = await Promise.all([
        deleteAs(race.id),
        releaseHeldAnswers(ds.manager, race.formId),
      ]);
      expect(await copies(race.formId, race.q)).toBe(deleted ? 0 : 1);
      expect(await held(race.formId)).toBe(0);
      expect(await stored(race.formId)).toBe(ANONYMOUS_BATCH_SIZE + 2 - (deleted ? 1 : 0));
      expect(await writes(race.formId)).toBe(1);
    }
  });

  it('a paid answer of a named form is never deleted, and the manager is told so (409)', async () => {
    // Against PostgreSQL, not a mock of the driver: a DELETE ... RETURNING answers [rows, rowCount],
    // and reading that pair as the rows once told the manager a refused delete was done.
    const formId = await makeForm({ anonymous: false });
    const [{ id }]: { id: string }[] = await ds.query(
      `INSERT INTO submissions ("formId", "userId", answers, "totalPaid", "paymentStatus")
       VALUES ($1, $2, '{"q1":"paye"}'::jsonb, 500, 'paid') RETURNING id`,
      [formId, member(++next)]
    );
    await expect(service.deleteSubmission(id, OWNER, false)).rejects.toMatchObject({
      response: { code: 'FORM_ANSWER_PAID' },
    });
    expect(await n(`SELECT count(*) AS n FROM submissions WHERE id = $1`, [id])).toBe(1);
  });

  it('refuses to release outside a transaction, where the form lock would not hold', async () => {
    const formId = await makeForm();
    await answer(formId, 1);
    await expect(releaseHeldAnswersUnderLock(ds.manager, formId, 'retired')).rejects.toBeInstanceOf(
      HeldAnswersOutsideTransactionError
    );
    expect(await held(formId)).toBe(1);
    await service.delete(formId, OWNER, false);
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

  it('the sweep releases a full batch still waiting, and accuses nothing it cannot know', async () => {
    const formId = await makeForm();
    // As a crash between the submit's commit and its release would leave it.
    for (let i = 0; i < ANONYMOUS_BATCH_SIZE; i++) {
      await ds.query(
        `INSERT INTO form_answers_held ("formId", answers) VALUES ($1, '{"q1":"x"}'::jsonb)`,
        [formId]
      );
    }
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');
    warn.mockClear();
    await sweep.releaseOnce();
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(ANONYMOUS_BATCH_SIZE);
    // Found, said with its size and reason - and accused of nothing: the sweep cannot tell a failed
    // release from one a submit was about to run, and a failed one was accused where it failed.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`${ANONYMOUS_BATCH_SIZE} answer(s) found waiting (full-batch)`)
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('retiring a form whose answers wait archives it and releases them, never losing one', async () => {
    const formId = await makeForm();
    await answer(formId, 1);
    const result = await ds.transaction((m) => retireForms(m, { formId }));
    expect(result).toEqual({ archived: 1, deleted: 0 });
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(1);
  });

  it('a tail joins every answer released in the latest WEEK, whatever its day, in one write', async () => {
    const formId = await makeForm();
    await answer(formId, 2 * ANONYMOUS_BATCH_SIZE + 2);
    expect(await stored(formId)).toBe(2 * ANONYMOUS_BATCH_SIZE);
    // The two batches as the day precision stored them: on two days of one week.
    await ds.query(
      `UPDATE submissions SET "createdAt" = date_trunc('week', "createdAt") + interval '2 days'
        WHERE id IN (SELECT id FROM submissions WHERE "formId" = $1 ORDER BY id LIMIT $2)`,
      [formId, ANONYMOUS_BATCH_SIZE]
    );
    await ds.query(
      `UPDATE submissions SET "createdAt" = date_trunc('week', "createdAt") + interval '3 days'
        WHERE "formId" = $1 AND "createdAt" = date_trunc('week', "createdAt")`,
      [formId]
    );

    await service.setClosed(formId, true, OWNER, false);
    expect(await held(formId)).toBe(0);
    expect(await stored(formId)).toBe(2 * ANONYMOUS_BATCH_SIZE + 2);
    // Both days joined the tail: one write, and one date, the week's Monday.
    expect(await writes(formId)).toBe(1);
    const dates: { at: string; monday: boolean }[] = await ds.query(
      `SELECT DISTINCT "createdAt"::text AS at,
              "createdAt" = date_trunc('week', "createdAt") AS monday
         FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(dates).toHaveLength(1);
    expect(dates[0].monday).toBe(true);
  });

  it('migration 181 cuts every anonymous answer to its week in ONE write, and is idempotent', async () => {
    const anonymousForm = await makeForm();
    const namedForm = await makeForm({ anonymous: false });
    const repo = ds.getRepository(Submission);
    // Day-precision and exact clocks, as rows stored before this file could hold them. 2026-11-16 is
    // a Monday; 2026-11-22 the Sunday ending its week; 2026-11-23 the next Monday.
    const cases: [string, string][] = [
      ['2026-11-19 00:00:00', '2026-11-16 00:00:00'],
      ['2026-11-22 23:59:59', '2026-11-16 00:00:00'],
      ['2026-11-23 09:15:00', '2026-11-23 00:00:00'],
      ['2027-01-01 00:00:00', '2026-12-28 00:00:00'],
    ];
    const ids: string[] = [];
    for (const [at] of cases) {
      const row = await repo.save(
        repo.create({
          formId: anonymousForm,
          userId: null,
          answers: {},
          totalPaid: 0,
          paymentStatus: 'free',
        } as Partial<Submission>)
      );
      ids.push(row.id);
      await ds.query(
        `UPDATE submissions SET "createdAt" = $2, "updatedAt" = $2, "paymentRequestedAt" = $2
          WHERE id = $1`,
        [row.id, at]
      );
    }
    const named = await repo.save(
      repo.create({
        formId: namedForm,
        userId: member(9999),
        answers: {},
        totalPaid: 0,
        paymentStatus: 'free',
      } as Partial<Submission>)
    );
    await ds.query(`UPDATE submissions SET "createdAt" = '2026-11-19 14:03:07' WHERE id = $1`, [
      named.id,
    ]);

    const migration = readFileSync(
      join(__dirname, '../migrations/181_anonymous_answers_keep_the_week.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query('RESET lock_timeout');

    const after: { id: string; c: string; u: string; p: string; x: string }[] = await ds.query(
      `SELECT id, "createdAt"::text AS c, "updatedAt"::text AS u, "paymentRequestedAt"::text AS p,
              xmin::text AS x
         FROM submissions WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    const byId = new Map(after.map((row) => [row.id, row]));
    cases.forEach(([, week], i) => {
      const row = byId.get(ids[i])!;
      expect([row.c, row.u, row.p]).toEqual([week, week, week]);
    });
    // ONE statement: every rewritten row carries the same write.
    expect(new Set(after.map((row) => row.x)).size).toBe(1);
    // A named form's answer keeps its instant.
    expect(
      (
        await ds.query(`SELECT "createdAt"::text AS c FROM submissions WHERE id = $1`, [named.id])
      )[0].c
    ).toBe('2026-11-19 14:03:07');

    // A second run writes nothing: no row gets a new version.
    await ds.query(migration);
    await ds.query('RESET lock_timeout');
    const again: { x: string }[] = await ds.query(
      `SELECT DISTINCT xmin::text AS x FROM submissions WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    expect(again).toEqual([{ x: after[0].x }]);
  });

  it('after every path above, no stored anonymous answer shares a write with the registry', async () => {
    expect(await sharedWithRegistry()).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM form_answers_held`, [])).toBe(
      1 // the second-answer form, still open
    );
  });
});
