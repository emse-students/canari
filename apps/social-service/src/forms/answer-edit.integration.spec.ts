/**
 * A RESPONDENT CHANGES THEIR OWN ANSWER, against a REAL PostgreSQL (migration 166, owner 2026-11-13).
 *
 * `FormsService.editAnswer` runs for real - the form lock, the row lock, the submit's checks - over
 * rows the real `submit`, `markPaid` and `validateCashPayment` wrote. core-service is the
 * `axios.post` mock (a request is issued, then Lydia is never asked again). What only a database
 * shows: migration 166 as written, the row updated in place (never a second one), the locked price
 * question refused on a paid and on a cash answer, the seat kept on a full form, and an edit queued
 * behind a cash validation holding the row - neither losing the other's write.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- answer-edit.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpException, Logger } from '@nestjs/common';
import axios from 'axios';
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
  FORM_ANSWER_EDIT_OFF,
  FORM_ANSWER_LOCKED,
  FORM_ANSWER_NOT_EDITABLE,
  FORM_ANSWER_NOT_FOUND,
} from './answer-edit';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000e1';
const OWNER = 'o'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

/** A text question, a FREE choice, a choice whose second option costs 12 EUR, a conditional text. */
const ITEMS = [
  { id: 'q-name', label: 'Nom d equipe', type: 'short_text', required: true },
  {
    id: 'q-size',
    label: 'Taille',
    type: 'single_choice',
    required: false,
    options: [
      { id: 's-m', label: 'M', priceModifier: 0 },
      { id: 's-l', label: 'L', priceModifier: 0 },
    ],
  },
  {
    id: 'q-meal',
    label: 'Repas',
    type: 'single_choice',
    required: true,
    options: [
      { id: 'm-none', label: 'Sans', priceModifier: 0 },
      { id: 'm-yes', label: 'Avec', priceModifier: 1200 },
    ],
  },
  {
    id: 'q-why',
    label: 'Pourquoi L',
    type: 'long_text',
    required: false,
    showIf: { answer: { questionId: 'q-size', optionIds: ['s-l'] } },
  },
];

/** The typed code of a refusal, and its status. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) {
      const body = err.getResponse() as { code?: string };
      return { status: err.getStatus(), code: body?.code };
    }
    throw err;
  }
  throw new Error('expected a refusal, the call succeeded');
}

maybe('a respondent changes their own answer, against PostgreSQL (migration 166)', () => {
  const schema = `answer_edit_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let issued = 0;
  /** The file claims an edit asked for, as `[submissionId, fileIds]`. */
  const attached: [string, string[]][] = [];

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
    // Migration 166 from tables WITHOUT its columns, twice: `synchronize` built them from the entities.
    await ds.query(`ALTER TABLE forms DROP COLUMN "allowAnswerEdit"`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "editedAt"`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "priceLockedItemIds"`);
    const migration = readFileSync(
      join(__dirname, '../migrations/166_form_answer_edit.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    await ds.query('RESET lock_timeout');

    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(OpeningReminder),
      { get: () => 'https://canari.example' } as any,
      {
        assertPaymentsReady: async () => undefined,
        canTakePaymentsNow: async () => true,
        getPaymentAccountId: async () => 'vendor',
        getActivePaymentProvider: async () => 'lydia',
        // The owner manages the association's forms (MANAGE_FORMS, owner 2026-11-14).
        mayAct: async (userId: string) => userId === OWNER,
        noteLydiaRequestIssued: async () => undefined,
      } as any,
      { cotisationModeOf: async () => 'simple' } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      {
        build: async (input: { answers: Record<string, string[]> }) => ({
          promo: null,
          formation: null,
          cotisationTiers: [],
          answers: input.answers,
        }),
      } as any,
      ds.getRepository(FormRespondent),
      // FormFilesService: only the claim is read, recorded rather than performed.
      {
        attach: async (_m: unknown, sub: { id: string }, _f: string, _u: string, files: any[]) => {
          attached.push([sub.id, files.map((f) => f.fileId)]);
        },
      } as any,
      { enabled: () => false } as any,
      {} as any // FormItemImagesService
    );
    jest.spyOn(axios, 'post').mockImplementation(async () => {
      issued += 1;
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${issued}`,
          id: String(issued).padStart(32, '0'),
          requestId: String(9000 + issued),
        },
      };
    });
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

  /** A published form allowing edits, charging through the meal supplement only. */
  async function makeForm(over: Partial<Form> = {}): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: OWNER,
        title: 'Tournoi',
        basePrice: 0,
        currency: 'eur',
        requiresPayment: true,
        allowCashPayment: true,
        associationId: ASSO,
        allowAnswerEdit: true,
        items: ITEMS,
        ...over,
      } as Partial<Form>)
    );
    return form.id;
  }

  const row = async (id: string) =>
    (
      await ds.query(
        `SELECT "paymentStatus", "totalPaid", answers, "editedAt", "paymentRequestId"
           FROM submissions WHERE id = $1`,
        [id]
      )
    )[0] as {
      paymentStatus: string;
      totalPaid: number;
      answers: Record<string, unknown>;
      editedAt: Date | null;
      paymentRequestId: string | null;
    };

  const rowsOf = async (formId: string) =>
    Number(
      (await ds.query(`SELECT count(*) AS n FROM submissions WHERE "formId" = $1`, [formId]))[0].n
    );

  it('migration 166 adds its columns as declared, and is idempotent', async () => {
    const columns = await ds.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'forms' AND column_name = 'allowAnswerEdit')
            OR (table_name = 'submissions'
                AND column_name IN ('editedAt', 'priceLockedItemIds')))
        ORDER BY table_name, column_name`,
      [schema]
    );
    expect(columns).toEqual([
      {
        table_name: 'forms',
        column_name: 'allowAnswerEdit',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        table_name: 'submissions',
        column_name: 'editedAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'submissions',
        column_name: 'priceLockedItemIds',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
  });

  it('keeps a question locked on a row priced with its supplement, after the supplement is removed', async () => {
    const formId = await makeForm();
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      paymentMethod: 'cash',
      answers: { 'q-name': 'Avant', 'q-meal': 'm-yes' },
    } as any);
    // The snapshot taken when the answer was priced.
    const [{ priceLockedItemIds }] = await ds.query(
      `SELECT "priceLockedItemIds" FROM submissions WHERE id = $1`,
      [sent.submissionId]
    );
    expect(priceLockedItemIds).toEqual(['q-meal']);

    // The manager removes the supplement: today's rule no longer prices q-meal.
    const unpriced = ITEMS.map((item: any) =>
      item.id === 'q-meal'
        ? { ...item, options: item.options.map((o: any) => ({ ...o, priceModifier: 0 })) }
        : item
    );
    await ds.getRepository(Form).update(formId, { items: unpriced as any });

    const mine = await service.myEditableAnswers(formId, ALICE);
    expect(mine[0].lockedItemIds).toEqual(['q-meal']);
    await expect(
      service.editAnswer(formId, sent.submissionId, ALICE, {
        'q-name': 'Apres',
        'q-meal': 'm-none',
      })
    ).rejects.toMatchObject({ response: { code: FORM_ANSWER_LOCKED, itemId: 'q-meal' } });
    expect((await row(sent.submissionId)).answers).toEqual({
      'q-name': 'Avant',
      'q-meal': 'm-yes',
    });

    // A row from before migration 166 (no snapshot) keeps today's rule only: the stated residual.
    await ds.query(`UPDATE submissions SET "priceLockedItemIds" = NULL WHERE id = $1`, [
      sent.submissionId,
    ]);
    expect((await service.myEditableAnswers(formId, ALICE))[0].lockedItemIds).toEqual([]);
  });

  it('changes a free answer IN PLACE: one row, the date set, the single-answer guard intact', async () => {
    const formId = await makeForm({ requiresPayment: false, allowCashPayment: false });
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'Les Bleus', 'q-meal': 'm-none' },
    } as any);
    expect((await row(sent.submissionId)).editedAt).toBeNull();

    const edited = await service.editAnswer(formId, sent.submissionId, ALICE, {
      'q-name': 'Les Verts',
      'q-meal': 'm-none',
      'q-size': 's-m',
    });
    expect(edited.submissionId).toBe(sent.submissionId);
    expect(edited.editedAt).toBeInstanceOf(Date);
    const stored = await row(sent.submissionId);
    expect(stored.answers).toEqual({ 'q-name': 'Les Verts', 'q-meal': 'm-none', 'q-size': 's-m' });
    expect(stored.paymentStatus).toBe('free');
    expect(stored.editedAt).not.toBeNull();
    expect(await rowsOf(formId)).toBe(1);

    // The page still reads it as answered, and a second answer is still refused.
    expect((await service.hasSubmission(formId, ALICE)).hasSubmitted).toBe(true);
    expect(
      (
        await refusal(
          service.submit(formId, {
            userId: ALICE,
            answers: { 'q-name': 'x', 'q-meal': 'm-none' },
          } as any)
        )
      ).code
    ).toBe('ALREADY_ANSWERED');
    // The respondent's list offers it, the meal locked (its option carries a supplement).
    const mine = await service.myEditableAnswers(formId, ALICE);
    expect(mine.map((a) => a.id)).toEqual([sent.submissionId]);
    expect(mine[0].lockedItemIds).toEqual(['q-meal']);
  });

  it('refuses a locked price question after payment, and changes the rest without touching the money', async () => {
    const formId = await makeForm();
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'Equipe A', 'q-meal': 'm-yes' },
    } as any);
    await service.markPaid(sent.submissionId, String(9000 + issued));
    const paid = await row(sent.submissionId);
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.totalPaid).toBe(1200);
    const requestsBefore = issued;

    expect(
      await refusal(
        service.editAnswer(formId, sent.submissionId, ALICE, {
          'q-name': 'Equipe A',
          'q-meal': 'm-none',
        })
      )
    ).toEqual({ status: 409, code: FORM_ANSWER_LOCKED });
    // Refused whole: nothing of the payload was written.
    expect((await row(sent.submissionId)).answers).toEqual(paid.answers);

    // The locked answer repeated, or omitted: kept as paid; the text changes.
    await service.editAnswer(formId, sent.submissionId, ALICE, {
      'q-name': 'Equipe B',
      'q-meal': 'm-yes',
    });
    await service.editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'Equipe C' });
    const after = await row(sent.submissionId);
    expect(after.answers).toEqual({ 'q-name': 'Equipe C', 'q-meal': 'm-yes' });
    expect(after.paymentStatus).toBe('paid');
    expect(after.totalPaid).toBe(1200);
    expect(issued).toBe(requestsBefore); // no request issued, none cancelled
  });

  it('locks the price question of a cash answer waiting for its money too', async () => {
    const formId = await makeForm();
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      paymentMethod: 'cash',
      answers: { 'q-name': 'Cash', 'q-meal': 'm-yes' },
    } as any);
    expect((await row(sent.submissionId)).paymentStatus).toBe('pending_cash');
    expect(
      (
        await refusal(
          service.editAnswer(formId, sent.submissionId, ALICE, {
            'q-name': 'Cash',
            'q-meal': 'm-none',
          })
        )
      ).code
    ).toBe(FORM_ANSWER_LOCKED);
  });

  it('keeps the seat of a FULL form, and a refused edit leaves the row untouched', async () => {
    const formId = await makeForm({
      requiresPayment: false,
      allowCashPayment: false,
      maxSubmissions: 1,
    });
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'Seule', 'q-meal': 'm-none', 'q-size': 's-m' },
    } as any);
    expect((await service.hasSubmission(formId, BOB)).formFull).toBe(true);

    // The free choice changes on a full form: the same row holds the same seat.
    await service.editAnswer(formId, sent.submissionId, ALICE, {
      'q-name': 'Seule',
      'q-meal': 'm-none',
      'q-size': 's-l',
      'q-why': 'Plus grand',
    });
    expect((await row(sent.submissionId)).answers).toEqual({
      'q-name': 'Seule',
      'q-meal': 'm-none',
      'q-size': 's-l',
      'q-why': 'Plus grand',
    });
    expect(await rowsOf(formId)).toBe(1);

    // All or nothing: a required question emptied refuses the whole edit.
    const before = await row(sent.submissionId);
    expect(
      await refusal(
        service.editAnswer(formId, sent.submissionId, ALICE, {
          'q-meal': 'm-none',
          'q-size': 's-m',
        })
      )
    ).toEqual({ status: 400, code: 'FORM_ANSWER_MISSING' });
    expect(await row(sent.submissionId)).toEqual(before);
  });

  it('drops an answer its condition now hides, as at submit', async () => {
    const formId = await makeForm({ requiresPayment: false, allowCashPayment: false });
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'N', 'q-meal': 'm-none', 'q-size': 's-l', 'q-why': 'Grand' },
    } as any);
    await service.editAnswer(formId, sent.submissionId, ALICE, {
      'q-name': 'N',
      'q-meal': 'm-none',
      'q-size': 's-m',
      'q-why': 'Grand',
    });
    expect((await row(sent.submissionId)).answers).toEqual({
      'q-name': 'N',
      'q-meal': 'm-none',
      'q-size': 's-m',
    });
  });

  it('refuses an edit once the form is closed, and offers none', async () => {
    const formId = await makeForm({ requiresPayment: false, allowCashPayment: false });
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'N', 'q-meal': 'm-none' },
    } as any);
    await ds.query(`UPDATE forms SET "closedAt" = now() - interval '1 minute' WHERE id = $1`, [
      formId,
    ]);
    expect(
      await refusal(service.editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'M' }))
    ).toEqual({ status: 400, code: 'FORM_CLOSED' });
    expect(await service.myEditableAnswers(formId, ALICE)).toEqual([]);
  });

  it('refuses every edit on an anonymous form, and a save that asks for both', async () => {
    // Written past the save's rule, as a stored row could be: the edit refuses on its own.
    const formId = await makeForm({
      requiresPayment: false,
      allowCashPayment: false,
      anonymous: true,
    });
    await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'N', 'q-meal': 'm-none' },
    } as any);
    const [anon] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [formId]);
    expect(await refusal(service.editAnswer(formId, anon.id, ALICE, { 'q-name': 'M' }))).toEqual({
      status: 403,
      code: FORM_ANSWER_EDIT_OFF,
    });
    expect(await service.myEditableAnswers(formId, ALICE)).toEqual([]);

    const off = await makeForm({ requiresPayment: false, allowAnswerEdit: false });
    const sent: any = await service.submit(off, {
      userId: ALICE,
      answers: { 'q-name': 'N', 'q-meal': 'm-none' },
    } as any);
    expect((await refusal(service.editAnswer(off, sent.submissionId, ALICE, {}))).code).toBe(
      FORM_ANSWER_EDIT_OFF
    );

    expect(
      (
        await refusal(
          service.create({
            ownerId: OWNER,
            title: 'Sondage',
            currency: 'eur',
            items: [{ id: 'q', label: 'Q', type: 'short_text', required: false }],
            anonymous: true,
            allowAnswerEdit: true,
          } as any)
        )
      ).code
    ).toBe('FORM_ANONYMOUS_ANSWER_EDIT');
  });

  it("answers another person's answer exactly as an absent one (404)", async () => {
    const formId = await makeForm({ requiresPayment: false, allowCashPayment: false });
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'A', 'q-meal': 'm-none' },
    } as any);
    expect(
      await refusal(service.editAnswer(formId, sent.submissionId, BOB, { 'q-name': 'Pirate' }))
    ).toEqual({ status: 404, code: FORM_ANSWER_NOT_FOUND });
    expect(
      await refusal(
        service.editAnswer(formId, '00000000-0000-4000-8000-0000000000ff', BOB, { 'q-name': 'P' })
      )
    ).toEqual({ status: 404, code: FORM_ANSWER_NOT_FOUND });
    expect((await row(sent.submissionId)).answers['q-name']).toBe('A');
  });

  it('refuses an answer that is no longer one (cancelled)', async () => {
    const formId = await makeForm();
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      paymentMethod: 'cash',
      answers: { 'q-name': 'A', 'q-meal': 'm-yes' },
    } as any);
    await service.cancelCashPayment(formId, sent.submissionId, OWNER, false);
    expect(
      await refusal(service.editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'B' }))
    ).toEqual({ status: 409, code: FORM_ANSWER_NOT_EDITABLE });
  });

  it('edits each answer of a several-answers form separately', async () => {
    const formId = await makeForm({
      requiresPayment: false,
      allowCashPayment: false,
      allowMultipleSubmissions: true,
    });
    const first: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'Un', 'q-meal': 'm-none' },
    } as any);
    const second: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'Deux', 'q-meal': 'm-none' },
    } as any);
    await service.editAnswer(formId, second.submissionId, ALICE, {
      'q-name': 'Deux bis',
      'q-meal': 'm-none',
    });
    expect((await row(first.submissionId)).answers['q-name']).toBe('Un');
    expect((await row(first.submissionId)).editedAt).toBeNull();
    expect((await row(second.submissionId)).answers['q-name']).toBe('Deux bis');
    expect((await service.myEditableAnswers(formId, ALICE)).length).toBe(2);
    expect(await rowsOf(formId)).toBe(2);
  });

  it('claims only a NEW file: a kept file is not claimed again, a replaced one stays with the row', async () => {
    const items = [
      ...ITEMS.slice(0, 1),
      { id: 'q-cv', label: 'CV', type: 'file', required: false },
    ];
    const formId = await makeForm({ requiresPayment: false, allowCashPayment: false, items });
    const OLD = '11111111-1111-4111-8111-111111111111';
    const NEW = '22222222-2222-4222-8222-222222222222';
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      answers: { 'q-name': 'A', 'q-cv': OLD },
    } as any);
    attached.length = 0;
    await service.editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'B', 'q-cv': OLD });
    expect(attached).toEqual([]);
    await service.editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'B', 'q-cv': NEW });
    expect(attached).toEqual([[sent.submissionId, [NEW]]]);
    expect((await row(sent.submissionId)).answers['q-cv']).toBe(NEW);
  });

  it('an edit queued behind a cash validation holding the row: both writes land, in that order', async () => {
    const formId = await makeForm();
    const sent: any = await service.submit(formId, {
      userId: ALICE,
      paymentMethod: 'cash',
      answers: { 'q-name': 'Avant', 'q-meal': 'm-yes' },
    } as any);

    // The validator's transaction, as `moveLockedSubmission` holds it: the ROW lock.
    const validator = new Client({
      connectionString: URL,
      options: `-c search_path=${schema},public`,
    });
    await validator.connect();
    try {
      const {
        rows: [{ pid: validatorPid }],
      } = await validator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await validator.query('BEGIN');
      await validator.query(`SELECT 1 FROM submissions WHERE id = $1 FOR UPDATE`, [
        sent.submissionId,
      ]);
      let settled = false;
      const edit = service
        .editAnswer(formId, sent.submissionId, ALICE, { 'q-name': 'Apres', 'q-meal': 'm-yes' })
        .finally(() => {
          settled = true;
        });
      // The edit is WAITING on that lock - observed in PostgreSQL, not assumed from a delay. An edit
      // that settles first never waited, and the assertion below `settled` says so.
      while (!settled) {
        const {
          rows: [{ n }],
        } = await admin.query<{ n: number }>(
          // A session BLOCKED BY the validator: whatever SQL the ORM spelled, the edit is that one.
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE $1::int = ANY(pg_blocking_pids(pid))`,
          [validatorPid]
        );
        if (n > 0) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(settled).toBe(false);
      await validator.query(`UPDATE submissions SET "paymentStatus" = 'paid' WHERE id = $1`, [
        sent.submissionId,
      ]);
      await validator.query('COMMIT');
      await edit;
    } finally {
      await validator.end();
    }
    const after = await row(sent.submissionId);
    expect(after.paymentStatus).toBe('paid');
    expect(after.answers).toEqual({ 'q-name': 'Apres', 'q-meal': 'm-yes' });
  });

  it('a real cash validation and an edit at once: never a lost write, whichever wins the lock', async () => {
    for (let round = 0; round < 5; round += 1) {
      const formId = await makeForm();
      const sent: any = await service.submit(formId, {
        userId: ALICE,
        paymentMethod: 'cash',
        answers: { 'q-name': `Avant ${round}`, 'q-meal': 'm-yes' },
      } as any);
      await Promise.all([
        service.validateCashPayment(formId, sent.submissionId, OWNER, false),
        service.editAnswer(formId, sent.submissionId, ALICE, {
          'q-name': `Apres ${round}`,
          'q-meal': 'm-yes',
        }),
      ]);
      const after = await row(sent.submissionId);
      expect(after.paymentStatus).toBe('paid');
      expect(after.totalPaid).toBe(1200);
      expect(after.answers).toEqual({ 'q-name': `Apres ${round}`, 'q-meal': 'm-yes' });
    }
  });
});
