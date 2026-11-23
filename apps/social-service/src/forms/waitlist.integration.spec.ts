/**
 * A LIMITED FORM'S WAITING LIST, against a REAL PostgreSQL (migration 183, owner decision of
 * 2026-11-23).
 *
 * `FormsService` runs for real - `submit`, the deletion, the expiry jobs, the leave and the promotion
 * by hand - and so does the one notice (`FormWaitlistNoticeService`, its bell row and push recorded).
 * core-service is the `axios.post` mock. What only a database shows: migration 183 as written (and
 * the draft fingerprints it re-bases), the promotion of the first in line on each freeing event under
 * the form's seat lock, two freeings promoting two people, a submit queued behind a freeing never
 * jumping the line, a promoted paid answer owing its payment with its own hold, the notice claimed
 * once.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- waitlist.integration
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
import { FormsService, WAITLIST_ANSWER_NOT_WAITING } from './forms.service';
import { FormWaitlistNoticeService, FORM_WAITLIST_PROMOTED_TYPE } from './waitlist-notice.service';
import { lockFormSeats, PENDING_PAYMENT_HOLD_SECONDS } from './seat-hold';
import { FORM_FINGERPRINT_SQL } from './form-draft-revision';
import { promoteFromWaitlist } from './waitlist';
import { ACTIVITY_DUMP_SQL, settledFlag, untilWaiting } from '../common/lock-wait.it-fixture';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a1';
const OWNER = 'o'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);
const DAVE = 'd'.repeat(64);
const ERIN = 'e'.repeat(64);

/** A form with a draft open BEFORE migration 183, whose fingerprint the migration re-bases. */
const DRAFTED = '00000000-0000-4000-8000-0000000000d1';
/** The service's own draft fingerprint: the migration must re-base onto exactly this. */
const FINGERPRINT = FORM_FINGERPRINT_SQL;

const ITEMS = [{ id: 'q-name', label: 'Nom', type: 'short_text', required: true }];
const ANSWERS = { 'q-name': 'x' };

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

maybe('the waiting list of a limited form, against PostgreSQL (migration 183)', () => {
  const schema = `waitlist_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let notice: FormWaitlistNoticeService;
  /** The bell rows the notice wrote, and the pushes it sent. */
  const rowsWritten: { recipientId: string; type: string; postId: string; actorName: string }[] =
    [];
  const pushes: { userId: string; key: string }[] = [];
  let issued = 0;

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
    await ds.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, name text, "logoUrl" text,
         "logoMediaId" text, archived boolean NOT NULL DEFAULT false)`
    );
    await ds.query(`INSERT INTO associations (id, name, "logoUrl") VALUES ($1, 'BDE', 'logo')`, [
      ASSO,
    ]);
    await ds.query(
      `CREATE TABLE users (id text PRIMARY KEY, "firstName" text, "lastName" text, campus text)`
    );
    await ds.query(
      `INSERT INTO users (id, "firstName", "lastName") VALUES
         ($1, 'Alice', 'A'), ($2, 'Bob', 'B'), ($3, 'Carol', 'C'), ($4, 'Dave', 'D'), ($5, 'Erin', 'E')`,
      [ALICE, BOB, CAROL, DAVE, ERIN]
    );
    // The drafts whose fingerprint migration 183 re-bases (migration 146 creates the table).
    await ds.query(readFileSync(join(__dirname, '../migrations/146_form_drafts.sql'), 'utf8'));
    // Migration 183 from tables WITHOUT its columns, twice, over a draft opened before it.
    await ds.query(`ALTER TABLE forms DROP COLUMN "waitlistEnabled"`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "waitlistOrder"`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "promotedAt"`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "promotionNotifiedAt"`);
    await ds.query(`INSERT INTO forms (id, "ownerId", title) VALUES ($1, $2, 'Brouillon')`, [
      DRAFTED,
      OWNER,
    ]);
    await ds.query(
      `INSERT INTO form_drafts ("formId", revision, document, "baseFingerprint")
         SELECT f.id, 1, '{}'::jsonb, ${FINGERPRINT} FROM forms f WHERE f.id = $1`,
      [DRAFTED]
    );
    const migration = readFileSync(
      join(__dirname, '../migrations/183_form_waiting_list.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    await ds.query('RESET lock_timeout');

    notice = new FormWaitlistNoticeService(
      ds.getRepository(Submission),
      {
        createNotification: async (row: any) => {
          rowsWritten.push(row);
        },
      } as any,
      {
        notifyContent: async (userId: string, content: { key: string }) => {
          pushes.push({ userId, key: content.key });
        },
      } as any
    );
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
        mayAct: async (userId: string) => userId === OWNER,
        noteLydiaRequestIssued: async () => undefined,
        collectsNow: async () => true,
        namesByIds: async () => new Map(),
      } as any,
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
      {} as any,
      { enabled: () => false } as any,
      {} as any,
      undefined, // UsageActivity: nothing counted here
      notice
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

  beforeEach(() => {
    rowsWritten.length = 0;
    pushes.length = 0;
  });

  /** A published, limited form; free unless told otherwise, its list on unless told otherwise. */
  async function makeForm(over: Partial<Form> = {}): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: OWNER,
        title: 'Soiree SG',
        basePrice: 0,
        currency: 'eur',
        requiresPayment: false,
        associationId: ASSO,
        maxSubmissions: 1,
        waitlistEnabled: true,
        items: ITEMS,
        ...over,
      } as Partial<Form>)
    );
    return form.id;
  }

  const send = (formId: string, userId: string, over: Record<string, unknown> = {}) =>
    service.submit(formId, { userId, answers: ANSWERS, joinWaitlist: true, ...over } as any);

  const status = async (id: string) =>
    (
      await ds.query(
        `SELECT "paymentStatus", "waitlistOrder", "promotedAt", "promotionNotifiedAt",
                "paymentRequestedAt", "cashExpiresAt", "cashReminderDueAt"
           FROM submissions WHERE id = $1`,
        [id]
      )
    )[0] as {
      paymentStatus: string;
      waitlistOrder: string | null;
      promotedAt: Date | null;
      promotionNotifiedAt: Date | null;
      paymentRequestedAt: Date | null;
      cashExpiresAt: Date | null;
      cashReminderDueAt: Date | null;
    };

  const rankOf = async (formId: string, userId: string) =>
    (await service.hasSubmission(formId, userId)).waitlist?.rank ?? null;

  /** Lets the notice the service sent after its commit (never awaited by the caller) land. */
  const noticesLand = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  it('migration 183 adds its columns, re-bases an open draft on the new fingerprint, and runs twice', async () => {
    const columns = await ds.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'forms' AND column_name = 'waitlistEnabled')
            OR (table_name = 'submissions'
                AND column_name IN ('waitlistOrder', 'promotedAt', 'promotionNotifiedAt')))
        ORDER BY table_name, column_name`,
      [schema]
    );
    expect(columns).toEqual([
      {
        table_name: 'forms',
        column_name: 'waitlistEnabled',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        table_name: 'submissions',
        column_name: 'promotedAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'submissions',
        column_name: 'promotionNotifiedAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'submissions',
        column_name: 'waitlistOrder',
        data_type: 'bigint',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    // The draft opened before the column is still based on its form: the new fingerprint.
    const [{ same }] = await ds.query(
      `SELECT d."baseFingerprint" = ${FINGERPRINT} AS same
         FROM form_drafts d JOIN forms f ON f.id = d."formId" WHERE d."formId" = $1`,
      [DRAFTED]
    );
    expect(same).toBe(true);
  });

  it('with the list off, a full form refuses as before, even to a client asking to wait', async () => {
    const formId = await makeForm({ waitlistEnabled: false });
    await send(formId, ALICE);
    expect(await refusal(send(formId, BOB))).toEqual({ status: 400, code: 'FORM_FULL' });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(n).toBe(1);
  });

  it('with the list on, a client that does not ask to wait is refused as before', async () => {
    const formId = await makeForm();
    await send(formId, ALICE);
    expect(await refusal(send(formId, BOB, { joinWaitlist: undefined }))).toEqual({
      status: 400,
      code: 'FORM_FULL',
    });
  });

  it('puts answers past the capacity in line, in arrival order, holding no seat', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    expect(alice.waiting).toBeUndefined();
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    expect(carol).toMatchObject({ waiting: true, waitlistRank: 2 });
    expect((await status(bob.submissionId)).paymentStatus).toBe('waiting');
    expect(await rankOf(formId, CAROL)).toBe(2);
    // Still one registration: the form stays full, and a waiting answer is an answer (no second).
    expect((await service.hasSubmission(formId, DAVE)).formFull).toBe(true);
    expect(await refusal(send(formId, BOB))).toMatchObject({ status: 409 });
  });

  it('a manager removal promotes the first in line, tells them once, and moves the rest up', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    await send(formId, CAROL);
    await service.deleteSubmission(alice.submissionId, OWNER, false);
    await noticesLand();
    const promoted = await status(bob.submissionId);
    expect(promoted.paymentStatus).toBe('free');
    expect(promoted.promotedAt).not.toBeNull();
    expect(promoted.promotionNotifiedAt).not.toBeNull();
    expect(rowsWritten).toEqual([
      expect.objectContaining({
        recipientId: BOB,
        type: FORM_WAITLIST_PROMOTED_TYPE,
        postId: formId,
        actorName: 'BDE',
      }),
    ]);
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted' }]);
    expect(await rankOf(formId, CAROL)).toBe(1);
    // The sweep finds nothing owed: the notice was claimed once.
    expect(await notice.tellPending()).toBe(0);
  });

  it('two freeings at once promote two people, the first two in line', async () => {
    const formId = await makeForm({ maxSubmissions: 2 });
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    const dave: any = await send(formId, DAVE);
    const erin: any = await send(formId, ERIN);
    await Promise.all([
      service.deleteSubmission(alice.submissionId, OWNER, false),
      service.deleteSubmission(bob.submissionId, OWNER, false),
    ]);
    expect((await status(carol.submissionId)).paymentStatus).toBe('free');
    expect((await status(dave.submissionId)).paymentStatus).toBe('free');
    expect((await status(erin.submissionId)).paymentStatus).toBe('waiting');
    expect(await rankOf(formId, ERIN)).toBe(1);
  });

  it('a submit queued behind a freeing never jumps the line', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    // A freeing holds the seat lock: the place is free, its promotion not yet run.
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction('READ COMMITTED');
    await lockFormSeats(holder.manager, formId);
    await holder.query(`DELETE FROM submissions WHERE id = $1`, [alice.submissionId]);
    const dave = send(formId, DAVE);
    const daveSettled = settledFlag(dave);
    await untilWaiting({
      waiting: async () =>
        Number(
          (
            await admin.query(
              `SELECT count(*) AS n FROM pg_stat_activity
                WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [await holder.query('SELECT pg_backend_pid() AS pid').then((r) => r[0].pid)]
            )
          ).rows[0].n
        ),
      settled: daveSettled,
      what: 'the submit behind the freeing',
      dump: async () => (await admin.query(ACTIVITY_DUMP_SQL)).rows,
    });
    await holder.commitTransaction();
    await holder.release();
    const daveOutcome: any = await dave;
    // The submit promoted the head of the line before counting: Bob holds the place, Dave waits.
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    expect(daveOutcome).toMatchObject({ waiting: true, waitlistRank: 1 });
  });

  it('a cash answer that expires promotes the next, who owes cash with its hold and reminder', async () => {
    const formId = await makeForm({
      requiresPayment: true,
      basePrice: 1500,
      allowCashPayment: true,
      allowOnlinePayment: false,
      cashPaymentExpiryDays: 3,
    } as Partial<Form>);
    const alice: any = await send(formId, ALICE, { paymentMethod: 'cash' });
    const bob: any = await send(formId, BOB, { paymentMethod: 'cash' });
    expect(bob).toMatchObject({ waiting: true });
    await ds.query(
      `UPDATE submissions SET "cashExpiresAt" = now() - interval '1 minute' WHERE id = $1`,
      [alice.submissionId]
    );
    await service.expireStalecashPayments();
    const promoted = await status(bob.submissionId);
    expect(promoted.paymentStatus).toBe('pending_cash');
    expect(promoted.cashExpiresAt).not.toBeNull();
    expect(promoted.cashReminderDueAt).not.toBeNull();
  });

  it('an online answer past its hold promotes the next, who owes the payment within their own hold', async () => {
    const formId = await makeForm({
      requiresPayment: true,
      basePrice: 1500,
      allowOnlinePayment: true,
    } as Partial<Form>);
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    expect(alice.checkoutUrl).toBeDefined();
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    // Past the hold on the DATABASE clock, the one every write of the column uses.
    const pastHold = (id: string) =>
      ds.query(
        `UPDATE submissions
            SET "paymentRequestedAt" = now() - make_interval(secs => ${PENDING_PAYMENT_HOLD_SECONDS + 60})
          WHERE id = $1`,
        [id]
      );
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    const due = await status(bob.submissionId);
    expect(due.paymentStatus).toBe('payment_due');
    expect(due.paymentRequestedAt).not.toBeNull();
    // Bob is offered the payment of THAT answer, and still holds the place: the form stays full.
    const check = await service.hasSubmission(formId, BOB);
    expect(check.resumable).toMatchObject({ submissionId: bob.submissionId });
    expect((await service.hasSubmission(formId, DAVE)).formFull).toBe(true);
    // Unpaid past its own hold, the place goes to the next in line.
    await pastHold(bob.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(bob.submissionId)).paymentStatus).toBe('expired');
    expect((await status(carol.submissionId)).paymentStatus).toBe('payment_due'); // Carol withdraws the place she owes: Dave, behind her, takes it.
    const dave: any = await send(formId, DAVE);
    expect(dave).toMatchObject({ waiting: true, waitlistRank: 1 });
    expect(await service.cancelSubmission(carol.submissionId, CAROL, false)).toEqual({ ok: true });
    expect((await status(carol.submissionId)).paymentStatus).toBe('cancelled');
    expect((await status(dave.submissionId)).paymentStatus).toBe('payment_due');
  });

  it('a place freed with no promotion run (a failure, a stopped process) is taken by the sweep', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    await ds.query(`DELETE FROM submissions WHERE id = $1`, [alice.submissionId]);
    expect((await status(bob.submissionId)).paymentStatus).toBe('waiting');
    expect(await service.promoteEveryWaitlist()).toBeGreaterThanOrEqual(1);
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    // Its notice is owed to the sweep of notices when the promotion's own did not run.
    await ds.query(`UPDATE submissions SET "promotionNotifiedAt" = NULL WHERE id = $1`, [
      bob.submissionId,
    ]);
    rowsWritten.length = 0;
    expect(await notice.tellPending()).toBeGreaterThanOrEqual(1);
    expect(rowsWritten.map((r) => r.recipientId)).toContain(BOB);
  });

  it('a bell row that cannot be written releases the notice for the next sweep, never loses it', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    const failing = new FormWaitlistNoticeService(
      ds.getRepository(Submission),
      {
        createNotification: async () => {
          throw new Error('bell store down');
        },
      } as any,
      { notifyContent: async () => undefined } as any
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await ds.query(`DELETE FROM submissions WHERE id = $1`, [alice.submissionId]);
    await ds.transaction('READ COMMITTED', async (m) => {
      await lockFormSeats(m, formId);
      await promoteFromWaitlist(m, formId, 'sweep', new Logger('it'));
    });
    await failing.tell([bob.submissionId]);
    expect((await status(bob.submissionId)).promotionNotifiedAt).toBeNull();
    await notice.tell([bob.submissionId]);
    expect((await status(bob.submissionId)).promotionNotifiedAt).not.toBeNull();
    expect(rowsWritten.map((r) => r.recipientId)).toEqual([BOB]);
  });

  it('a member leaves the list; a promoted answer and another member are refused, typed', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    expect(await refusal(service.leaveWaitlist(bob.submissionId, CAROL))).toMatchObject({
      status: 404,
    });
    expect(await service.leaveWaitlist(bob.submissionId, BOB)).toEqual({ ok: true });
    expect(await status(bob.submissionId)).toBeUndefined();
    expect(await rankOf(formId, CAROL)).toBe(1);
    await service.deleteSubmission(alice.submissionId, OWNER, false);
    expect(await refusal(service.leaveWaitlist(carol.submissionId, CAROL))).toEqual({
      status: 409,
      code: WAITLIST_ANSWER_NOT_WAITING,
    });
  });

  it('a manager promotes by hand above the capacity; nobody else may', async () => {
    const formId = await makeForm();
    await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    expect(
      await refusal(service.promoteByHand(formId, bob.submissionId, CAROL, false))
    ).toMatchObject({ status: 403 });
    expect(await service.promoteByHand(formId, bob.submissionId, OWNER, false)).toEqual({
      ok: true,
      status: 'free',
    });
    await noticesLand();
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted' }]);
    expect(await refusal(service.promoteByHand(formId, bob.submissionId, OWNER, false))).toEqual({
      status: 409,
      code: WAITLIST_ANSWER_NOT_WAITING,
    });
  });

  it('a capacity raised promotes as many as it frees', async () => {
    const formId = await makeForm();
    await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    const dave: any = await send(formId, DAVE);
    await ds.getRepository(Form).update(formId, { maxSubmissions: 3 });
    expect((await service.promoteWaitlist(formId, 'form-edit')).length).toBe(2);
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    expect((await status(carol.submissionId)).paymentStatus).toBe('free');
    expect((await status(dave.submissionId)).paymentStatus).toBe('waiting');
  });
});
