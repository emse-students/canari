/**
 * A LIMITED FORM'S WAITING LIST, against a REAL PostgreSQL (migration 183, owner decision of
 * 2026-11-23).
 *
 * `FormsService` runs for real - `submit`, the deletion, the expiry jobs, the leave and the promotion
 * by hand - and so does the one notice (`FormWaitlistNoticeService`, its bell row and push recorded).
 * core-service is the `axios.post` mock. What only a database shows: migration 183 as written (and
 * the draft fingerprints it re-bases), the promotion of the first in line on each freeing event under
 * the form's seat lock and IN THAT EVENT'S TRANSACTION (a failed promotion rolls the freeing back),
 * two freeings promoting two people, a submit queued behind a freeing never jumping the line, a
 * promoted paid answer owing its payment with its own hold and its own notice, a promoted answer
 * keeping its place when its payment cannot be issued, a late payment taking its payer off the line,
 * the list frozen when no payment path is left, the account erasure deleting a waiting answer, and
 * the notice claimed once, in the transaction that writes its bell row.
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
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { ERASURE_ROW_STATEMENTS, erasureParams } from '../internal/account-erasure';
import {
  FormsService,
  WAITLIST_ANSWER_NOT_WAITING,
  WAITLIST_NO_PAYMENT_PATH,
} from './forms.service';
import {
  FormWaitlistNoticeService,
  FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE,
  FORM_WAITLIST_PROMOTED_TYPE,
} from './waitlist-notice.service';
import { lockFormSeats, PENDING_PAYMENT_HOLD_SECONDS } from './seat-hold';
import { promoteFromWaitlist } from './waitlist';
import { FORM_FINGERPRINT_SQL } from './form-draft-revision';
import { ACTIVITY_DUMP_SQL, settledFlag, untilWaiting } from '../common/lock-wait.it-fixture';
import { takeLogged } from '../common/testing/integration-log-guard.it-fixture';

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
/** The fingerprint's rule when migration 183 was written: the stale-open stamps still hashed. */
const FINGERPRINT_BEFORE_185 = `md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)`;

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
  /** The pushes the notice sent (its bell rows are read from `post_notifications`, `bellRows`). */
  const pushes: { userId: string; key: string }[] = [];
  let issued = 0;
  /** Whether the association can collect online now (`collectsNow`), switched by a case. */
  let collects = true;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Form,
        Submission,
        FormReminder,
        OpeningReminder,
        FormRespondent,
        PurchaseRecord,
        PostNotification,
      ],
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
      `CREATE TABLE users (id text PRIMARY KEY, "firstName" text, "lastName" text, campus text, posts text[] NOT NULL DEFAULT '{}')`
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
         SELECT f.id, 1, '{}'::jsonb, ${FINGERPRINT_BEFORE_185} FROM forms f WHERE f.id = $1`,
      [DRAFTED]
    );
    const migration = readFileSync(
      join(__dirname, '../migrations/183_form_waiting_list.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    // ...then migration 185, which takes the two stale-open stamps out of the fingerprint.
    await ds.query(
      readFileSync(join(__dirname, '../migrations/185_form_fingerprint_stale_stamps.sql'), 'utf8')
    );
    await ds.query('RESET lock_timeout');

    const push = {
      notifyContent: async (userId: string, content: { key: string }) => {
        pushes.push({ userId, key: content.key });
      },
    } as any;
    // The one bell-row writer, real: the notice writes its row through it, on the claim's
    // transaction. No post is read, and its push is never used (`skipPush`).
    notice = new FormWaitlistNoticeService(
      ds.getRepository(Submission),
      push,
      new PostNotificationsService(ds.getRepository(PostNotification), {} as any, push, {} as any)
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
        collectsNow: async () => collects,
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

  beforeEach(async () => {
    pushes.length = 0;
    collects = true;
    await ds.query(`DELETE FROM post_notifications`);
  });

  /** The bell rows the notice wrote, oldest first. */
  const bellRows = async () =>
    (await ds.query(
      `SELECT "recipientId", type, "postId", "actorName" FROM post_notifications ORDER BY "createdAt"`
    )) as { recipientId: string; type: string; postId: string; actorName: string }[];

  /** Makes every promotion fail in the database, for the time of `body`: the write is refused. */
  async function withPromotionRefused(body: () => Promise<void>): Promise<void> {
    await ds.query(
      `CREATE OR REPLACE FUNCTION waitlist_it_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'promotion refused by the spec'; END $$`
    );
    await ds.query(
      `CREATE TRIGGER waitlist_it_refuse BEFORE UPDATE ON submissions FOR EACH ROW
         WHEN (OLD."paymentStatus" = 'waiting' AND NEW."paymentStatus" <> 'waiting')
         EXECUTE FUNCTION waitlist_it_refuse()`
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await body();
    } finally {
      await ds.query(`DROP TRIGGER waitlist_it_refuse ON submissions`);
      error.mockRestore();
    }
  }

  /** Past the online hold on the DATABASE clock, the one every write of the column uses. */
  const pastHold = (id: string) =>
    ds.query(
      `UPDATE submissions
          SET "paymentRequestedAt" = now() - make_interval(secs => ${PENDING_PAYMENT_HOLD_SECONDS + 60})
        WHERE id = $1`,
      [id]
    );

  /** A paid online form, limited to one. */
  const paidOnlineForm = (over: Partial<Form> = {}) =>
    makeForm({
      requiresPayment: true,
      basePrice: 1500,
      allowOnlinePayment: true,
      ...over,
    } as Partial<Form>);

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
    expect(await bellRows()).toEqual([
      expect.objectContaining({
        recipientId: BOB,
        type: FORM_WAITLIST_PROMOTED_TYPE,
        postId: formId,
        actorName: 'BDE',
      }),
    ]);
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted' }]);
    expect(await rankOf(formId, CAROL)).toBe(1);
    // Nothing owed to the retry: the notice was claimed once, with its bell row.
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
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    expect(alice.checkoutUrl).toBeDefined();
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    const due = await status(bob.submissionId);
    expect(due.paymentStatus).toBe('payment_due');
    expect(due.paymentRequestedAt).not.toBeNull();
    // Told that the place is HELD for the payment: its own bell row and push.
    await noticesLand();
    expect(await bellRows()).toEqual([
      expect.objectContaining({ recipientId: BOB, type: FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE }),
    ]);
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted_payment_due' }]);
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

  it('a claimed row expired by the sweep promotes the next in line, and the switch then answers FORM_FULL', async () => {
    const formId = await paidOnlineForm({
      allowCashPayment: true,
      cashPaymentExpiryDays: 3,
    } as Partial<Form>);
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    expect(alice.checkoutUrl).toBeDefined();
    const bob: any = await send(formId, BOB);
    await send(formId, CAROL);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    // A switch to cash claimed Alice's row (`claimCashSwitch`), and its hold ran out under it: the
    // sweep expires the row, clears the claim with it, and hands the place to the first in line.
    await ds.query(`UPDATE submissions SET "cashSwitchClaimId" = gen_random_uuid() WHERE id = $1`, [
      alice.submissionId,
    ]);
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    const [expired] = await ds.query(
      `SELECT "paymentStatus", "cashSwitchClaimId" FROM submissions WHERE id = $1`,
      [alice.submissionId]
    );
    expect(expired).toEqual({ paymentStatus: 'expired', cashSwitchClaimId: null });
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    // The switch, pressed now: its request is cancelled at Lydia, and the waiting list goes first -
    // Bob holds the only place, so the released answer is refused FORM_FULL, never seated over him.
    (axios.post as jest.Mock).mockImplementationOnce(async () => ({
      data: { outcome: 'cancelled' },
    }));
    expect(
      await refusal(
        service.switchToCash({ kind: 'member', submissionId: alice.submissionId, userId: ALICE })
      )
    ).toEqual({ status: 400, code: 'FORM_FULL' });
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    expect(await rankOf(formId, CAROL)).toBe(1);
    // The list is open: Alice joins it by the ordinary send, behind those already waiting.
    expect(await send(formId, ALICE)).toMatchObject({ waiting: true, waitlistRank: 2 });
  });

  it('a switch refused after it promoted: the promotion is committed once, in its own transaction, and told once', async () => {
    const formId = await paidOnlineForm({
      allowCashPayment: true,
      cashPaymentExpiryDays: 3,
    } as Partial<Form>);
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    // The place is free AND someone waits: the state a freeing whose promotion is still owed leaves
    // (written directly - every path that frees a place promotes in its own transaction).
    const bob = await ds.getRepository(Submission).save(
      ds.getRepository(Submission).create({
        formId,
        userId: BOB,
        answers: ANSWERS,
        totalPaid: 1500,
        paymentMethod: null,
        paymentStatus: 'waiting',
        waitlistOrder: '1',
      } as Partial<Submission>)
    );
    // Alice's switch re-takes a seat: the list goes first, Bob takes the place, and the switch is
    // refused FORM_FULL - which rolls its own promotion back, so it is promoted again on its own.
    const again = jest.spyOn(service, 'promoteWaitlist');
    (axios.post as jest.Mock).mockImplementationOnce(async () => ({
      data: { outcome: 'cancelled' },
    }));
    try {
      expect(
        await refusal(
          service.switchToCash({ kind: 'member', submissionId: alice.submissionId, userId: ALICE })
        )
      ).toEqual({ status: 400, code: 'FORM_FULL' });
      expect(again).toHaveBeenCalledTimes(1);
      expect(again).toHaveBeenCalledWith(formId, 'cash-switch');
    } finally {
      again.mockRestore();
    }
    await noticesLand();
    const promoted = await status(bob.id);
    expect(promoted.paymentStatus).toBe('payment_due');
    expect(promoted.promotionNotifiedAt).not.toBeNull();
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    // Told ONCE: the rolled-back promotion said nothing, the committed one said it.
    expect(await bellRows()).toEqual([
      expect.objectContaining({ recipientId: BOB, type: FORM_WAITLIST_PROMOTED_PAYMENT_DUE_TYPE }),
    ]);
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted_payment_due' }]);
    expect(await notice.tellPending()).toBe(0);
  });

  it('a failed promotion rolls back the freeing it follows: a delete, a cancel, an expiry', async () => {
    const formId = await paidOnlineForm({ maxSubmissions: 2 } as Partial<Form>);
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB, { payerEmail: 'b@example.org' });
    const carol: any = await send(formId, CAROL);
    expect(carol).toMatchObject({ waiting: true });
    // Bob's request is settled as never issued, so a manager may delete his answer outright.
    await ds.query(
      `UPDATE submissions SET "paymentStatus" = 'payment_due', "paymentRequestId" = NULL,
              "stripeSessionId" = NULL WHERE id = $1`,
      [bob.submissionId]
    );
    await withPromotionRefused(async () => {
      // A delete whose promotion fails keeps the answer: the place is never free with Carol waiting.
      await expect(service.deleteSubmission(bob.submissionId, OWNER, false)).rejects.toThrow(
        'promotion refused by the spec'
      );
      expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
      // A cancel too (`moveLockedSubmission`).
      await expect(service.cancelSubmission(bob.submissionId, BOB, false)).rejects.toThrow(
        'promotion refused by the spec'
      );
      expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
      // An expiry is left for the next run, its form's rows untouched.
      await pastHold(alice.submissionId);
      expect(await service.expireStalePendingPayments(await service.pendingHoldCutoff())).toBe(0);
      expect((await status(alice.submissionId)).paymentStatus).toBe('pending');
    });
    expect((await status(carol.submissionId)).paymentStatus).toBe('waiting');
    // The next run, with the promotion working, expires and promotes in one step.
    expect(await service.expireStalePendingPayments(await service.pendingHoldCutoff())).toBe(1);
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    expect((await status(carol.submissionId)).paymentStatus).toBe('payment_due');
  });

  it('a bell row that cannot be written rolls its claim back: the notice is owed, never lost', async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    await ds.query(
      `CREATE OR REPLACE FUNCTION waitlist_it_bell_down() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'bell store down'; END $$`
    );
    await ds.query(
      `CREATE TRIGGER waitlist_it_bell_down BEFORE INSERT ON post_notifications
         FOR EACH ROW EXECUTE FUNCTION waitlist_it_bell_down()`
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await service.deleteSubmission(alice.submissionId, OWNER, false);
      await noticesLand();
    } finally {
      await ds.query(`DROP TRIGGER waitlist_it_bell_down ON post_notifications`);
      error.mockRestore();
    }
    // Promoted, but the claim went with the failed bell row: owed, and no push was sent.
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    expect((await status(bob.submissionId)).promotionNotifiedAt).toBeNull();
    expect(pushes).toEqual([]);
    expect(await notice.tellPending()).toBe(1);
    await noticesLand();
    expect((await status(bob.submissionId)).promotionNotifiedAt).not.toBeNull();
    expect((await bellRows()).map((r) => r.recipientId)).toEqual([BOB]);
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted' }]);
    // The durable retry found the owed notice, and says so.
    takeLogged(
      'warn',
      /^\[WAITLIST\] 1 promotion notice\(s\) owed after their promotion committed - telling now$/
    );
  });

  it('a promoted answer whose payment request is refused before it exists keeps its place', async () => {
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    const promoted = await status(bob.submissionId);
    expect(promoted.paymentStatus).toBe('payment_due');
    // Core refuses the request with a typed refusal: nothing exists at Lydia (its ERROR line silenced).
    jest.spyOn(Logger.prototype, 'error').mockImplementationOnce(() => undefined);
    jest.spyOn(axios, 'post').mockRejectedValueOnce({
      response: { status: 400, data: { code: 'CHECKOUT_REQUEST_INVALID' } },
    });
    await expect(
      service.resumePayment(bob.submissionId, BOB, { payerEmail: 'b@example.org' })
    ).rejects.toBeDefined();
    // Back to owing its payment, holding the place; Carol still waits. Its hold is counted from the
    // PROMOTION again, not from the resume that failed: retrying never keeps the place longer.
    const restored = await status(bob.submissionId);
    expect(restored.paymentStatus).toBe('payment_due');
    expect(restored.paymentRequestedAt).toEqual(promoted.paymentRequestedAt);
    expect((await status(carol.submissionId)).paymentStatus).toBe('waiting');
    expect((await service.hasSubmission(formId, BOB)).resumable).toMatchObject({
      submissionId: bob.submissionId,
    });
  });

  it('a request whose issue has an unknown outcome keeps the seat until its hold lapses', async () => {
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB);
    // The call was sent and failed: Lydia may hold a request this row does not name.
    jest.spyOn(axios, 'post').mockRejectedValueOnce({ response: { status: 502 } });
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    jest.spyOn(Logger.prototype, 'error').mockImplementationOnce(() => undefined);
    await expect(
      service.resumePayment(bob.submissionId, BOB, { payerEmail: 'b@example.org' })
    ).rejects.toBeDefined();
    const carol: any = await send(formId, CAROL);
    // Still pending, holding the seat: nobody is promoted into a place that request may claim.
    expect((await status(bob.submissionId)).paymentStatus).toBe('pending');
    expect(carol).toMatchObject({ waiting: true, waitlistRank: 1 });
    // And never offered for a resume, now or once its hold has lapsed.
    expect((await service.hasSubmission(formId, BOB)).resumable).toBeNull();
    await pastHold(bob.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(bob.submissionId)).paymentStatus).toBe('expired');
    expect((await status(carol.submissionId)).paymentStatus).toBe('payment_due');
    expect((await service.hasSubmission(formId, BOB)).resumable).toBeNull();
    takeLogged(
      'warn',
      /^\[Forms\] submission [0-9a-f-]{36} kept pending: the issuing call failed after it was sent - its outcome at Lydia is unknown, the seat is held until the hold lapses, no resume is offered$/
    );
  });

  it('a late payment over capacity keeps its payer in line, and their turn converts it to paid', async () => {
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB);
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    // Alice, her answer expired, joins the line behind the place Bob now holds.
    const again: any = await send(formId, ALICE);
    expect(again).toMatchObject({ waiting: true, waitlistRank: 1 });
    // Her first payment lands late: over capacity (Bob holds the place). It gave no seat, so she
    // KEEPS her place in line - the refund is owed only if she is never promoted.
    await service.markPaid(alice.submissionId);
    expect((await status(alice.submissionId)).paymentStatus).toBe('paid_over_capacity');
    expect((await status(again.submissionId)).paymentStatus).toBe('waiting');
    // Her return pages say so: her place in line is kept, nothing more charged - not "ask a refund".
    expect(await service.getSubmissionById(alice.submissionId)).toMatchObject({
      paymentStatus: 'paid_over_capacity',
      waitlisted: true,
    });
    // Bob does not pay: his place is hers. Her PAID answer becomes the registration - no second
    // charge, no payment owed - and her waiting answer is gone.
    const before = issued;
    await pastHold(bob.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    await noticesLand();
    expect((await status(alice.submissionId)).paymentStatus).toBe('paid');
    expect((await status(alice.submissionId)).promotedAt).not.toBeNull();
    expect((await service.getSubmissionById(alice.submissionId)).waitlisted).toBeUndefined();
    expect(await status(again.submissionId)).toBeUndefined();
    expect(issued).toBe(before);
    expect(pushes).toEqual([
      { userId: BOB, key: 'form_waitlist_promoted_payment_due' },
      { userId: ALICE, key: 'form_waitlist_promoted' },
    ]);
    // What her payment buys ran once the seat was given: nothing more is owed on a retry.
    const [{ granted }] = await ds.query(
      `SELECT "cotisationGrantedAt" IS NOT NULL AS granted FROM submissions WHERE id = $1`,
      [alice.submissionId]
    );
    expect(granted).toBe(true);
    expect(await service.fulfilConvertedPromotions()).toBe(0);
    // One registration, the form full: the next answer waits.
    expect(await send(formId, CAROL)).toMatchObject({ waiting: true, waitlistRank: 1 });
    // The late payment is said as what it is for a payer in line: a refund owed only if never promoted.
    takeLogged(
      'warn',
      /^\[Forms\] Payment on submission [0-9a-f-]{36} landed OVER CAPACITY \(form [0-9a-f-]{36}, 1500 cents\): the payer is on the waiting list - their place is kept, and a refund is owed only if they are never promoted$/
    );
  });

  it("the durable retry runs what a converted promotion buys with the answer's OWN payment method", async () => {
    const formId = await makeForm({
      requiresPayment: true,
      basePrice: 1500,
      allowCashPayment: true,
      allowOnlinePayment: false,
      cashPaymentExpiryDays: 3,
    } as Partial<Form>);
    // A cash promotee a manager validated by hand, whose grant a stopped process left owed.
    const row = await ds.getRepository(Submission).save(
      ds.getRepository(Submission).create({
        formId,
        userId: DAVE,
        answers: ANSWERS,
        totalPaid: 1500,
        paymentMethod: 'cash',
        paymentStatus: 'paid',
      } as Partial<Submission>)
    );
    await ds.query(`UPDATE submissions SET "promotedAt" = now() WHERE id = $1`, [row.id]);
    const fulfil = jest.spyOn(service as any, 'fulfilPayment');
    try {
      expect(await service.fulfilConvertedPromotions()).toBe(1);
      expect(fulfil).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id }),
        true,
        expect.objectContaining({ paymentMethod: 'cash' })
      );
    } finally {
      fulfil.mockRestore();
      // Not left for the later retries of this file: the row was written by hand, told by nobody.
      await ds.query(`DELETE FROM submissions WHERE id = $1`, [row.id]);
    }
    takeLogged(
      'warn',
      /^\[WAITLIST\] 1 converted promotion\(s\) still owe what their payment buys - running it now$/
    );
  });

  it('a conversion committed by another promoter (a refund) is fulfilled by its after-commit step, never by the retry', async () => {
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    await service.markPaid(alice.submissionId);
    const bob: any = await send(formId, BOB);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    // A late payment of Bob's old answer landed over capacity: its purchase recorded, no cotisation.
    // An INSERT ... RETURNING answers the rows themselves through TypeORM.
    const [{ id: paidId }] = (await ds.query(
      `INSERT INTO submissions ("formId", "userId", answers, "totalPaid", "paymentStatus", "purchaseRecordedAt")
       VALUES ($1, $2, '{}'::jsonb, 1500, 'paid_over_capacity', now()) RETURNING id`,
      [formId, BOB]
    )) as Array<{ id: string }>;
    pushes.length = 0;
    // What `RefundsService.withdraw` does in the refund's transaction, then its `afterCommit`.
    const promoted = await ds.transaction('READ COMMITTED', async (m) => {
      await lockFormSeats(m, formId);
      await m.query(`UPDATE submissions SET "paymentStatus" = 'refunded' WHERE id = $1`, [
        alice.submissionId,
      ]);
      return promoteFromWaitlist(m, formId, 'refund', new Logger('it'), async () => true);
    });
    expect(promoted).toEqual([{ submissionId: paidId, userId: BOB, formId, status: 'paid' }]);
    await notice.afterCommit(promoted);
    const [{ granted }] = await ds.query(
      `SELECT "cotisationGrantedAt" IS NOT NULL AS granted FROM submissions WHERE id = $1`,
      [paidId]
    );
    expect(granted).toBe(true);
    expect(await status(bob.submissionId)).toBeUndefined();
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted' }]);
    // The durable retry finds nothing: the ordinary path never reaches it.
    expect(await service.fulfilConvertedPromotions()).toBe(0);
    expect(await notice.tellPending()).toBe(0);
  });

  it('a list whose first in line can no longer pay is FROZEN: nobody promoted, the form full', async () => {
    const formId = await paidOnlineForm();
    await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB);
    // Online switched off: Bob would owe an online payment nobody can take.
    await ds.getRepository(Form).update(formId, {
      allowOnlinePayment: false,
      allowCashPayment: true,
      maxSubmissions: 2,
    });
    expect(await service.promoteWaitlist(formId, 'form-edit')).toEqual([]);
    expect((await status(bob.submissionId)).paymentStatus).toBe('waiting');
    // The free place is Bob's, not a newcomer's: the form reads full while he waits.
    expect((await service.hasSubmission(formId, DAVE)).formFull).toBe(true);
    // Nor can a manager register him into a payment that cannot be made.
    expect(await refusal(service.promoteByHand(formId, bob.submissionId, OWNER, false))).toEqual({
      status: 409,
      code: WAITLIST_NO_PAYMENT_PATH,
    });
    // Online back on: the next capacity event promotes him.
    await ds.getRepository(Form).update(formId, { allowOnlinePayment: true });
    expect((await service.promoteWaitlist(formId, 'form-edit')).length).toBe(1);
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    takeLogged(
      'warn',
      /^\[WAITLIST\] form-edit: form [0-9a-f]{8} list FROZEN at [0-9a-f]{8}: it would be payment_due, and the form can take no online payment now - nobody behind it is promoted past it until that payment mode is payable again or a manager removes it$/
    );
    takeLogged(
      'warn',
      /^\[WAITLIST\] by-hand promotion of [0-9a-f]{8} refused: it would be payment_due, and form [0-9a-f]{8} can take no such payment now$/
    );
  });

  it('a save of the form that reopens the payment mode lifts a frozen list, in its own transaction', async () => {
    const formId = await paidOnlineForm({ maxSubmissions: 2 } as Partial<Form>);
    await send(formId, ALICE, { payerEmail: 'a@example.org' });
    await send(formId, CAROL, { payerEmail: 'c@example.org' });
    const bob: any = await send(formId, BOB);
    expect(bob).toMatchObject({ waiting: true, waitlistRank: 1 });
    // Online off, and Carol's place freed: Bob is first, owing a payment nobody can take.
    await ds.getRepository(Form).update(formId, {
      allowOnlinePayment: false,
      allowCashPayment: true,
    });
    await ds.query(`UPDATE submissions SET "paymentStatus" = 'cancelled' WHERE "userId" = $1`, [
      CAROL,
    ]);
    expect(await service.promoteWaitlist(formId, 'form-edit')).toEqual([]);
    expect((await status(bob.submissionId)).paymentStatus).toBe('waiting');
    // The manager saves the form with online back on - its capacity untouched. The save promotes.
    const stored = await ds.getRepository(Form).findOneByOrFail({ id: formId });
    await service.update(
      formId,
      {
        title: stored.title,
        items: ITEMS,
        maxSubmissions: 2,
        waitlistEnabled: true,
        associationId: ASSO,
        requiresPayment: true,
        basePrice: 1500,
        allowOnlinePayment: true,
        allowCashPayment: true,
      } as any,
      OWNER,
      false
    );
    await noticesLand();
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    expect(pushes).toEqual([{ userId: BOB, key: 'form_waitlist_promoted_payment_due' }]);
    takeLogged(
      'warn',
      /^\[WAITLIST\] form-edit: form [0-9a-f]{8} list FROZEN at [0-9a-f]{8}: it would be payment_due, and the form can take no online payment now - nobody behind it is promoted past it until that payment mode is payable again or a manager removes it$/
    );
  });

  it('an association that cannot collect online freezes the list instead of handing the place on', async () => {
    const formId = await paidOnlineForm();
    const alice: any = await send(formId, ALICE, { payerEmail: 'a@example.org' });
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    // The association's account stops collecting; Alice's hold lapses.
    collects = false;
    await pastHold(alice.submissionId);
    await service.expireStalePendingPayments(await service.pendingHoldCutoff());
    // Bob would owe a payment nobody can take: he is not promoted, and nobody behind him either.
    expect((await status(alice.submissionId)).paymentStatus).toBe('expired');
    expect((await status(bob.submissionId)).paymentStatus).toBe('waiting');
    expect((await status(carol.submissionId)).paymentStatus).toBe('waiting');
    expect(await refusal(service.promoteByHand(formId, bob.submissionId, OWNER, false))).toEqual({
      status: 409,
      code: WAITLIST_NO_PAYMENT_PATH,
    });
    // The account collects again: the manager's next save promotes him.
    collects = true;
    const stored = await ds.getRepository(Form).findOneByOrFail({ id: formId });
    await service.update(
      formId,
      {
        title: stored.title,
        items: ITEMS,
        maxSubmissions: 1,
        waitlistEnabled: true,
        associationId: ASSO,
        requiresPayment: true,
        basePrice: 1500,
        allowOnlinePayment: true,
      } as any,
      OWNER,
      false
    );
    expect((await status(bob.submissionId)).paymentStatus).toBe('payment_due');
    expect((await status(carol.submissionId)).paymentStatus).toBe('waiting');
    takeLogged(
      'warn',
      /^\[WAITLIST\] online-expiry: form [0-9a-f]{8} list FROZEN at [0-9a-f]{8}: it would be payment_due, and the form can take no online payment now - nobody behind it is promoted past it until that payment mode is payable again or a manager removes it$/
    );
    takeLogged(
      'warn',
      /^\[WAITLIST\] by-hand promotion of [0-9a-f]{8} refused: it would be payment_due, and form [0-9a-f]{8} can take no such payment now$/
    );
  });

  it("the account erasure deletes the account's waiting answer, so nobody is promoted into it", async () => {
    const formId = await makeForm();
    const alice: any = await send(formId, ALICE);
    const bob: any = await send(formId, BOB);
    const carol: any = await send(formId, CAROL);
    const statements = ERASURE_ROW_STATEMENTS.filter((st) =>
      ['submissions_waiting_forms_locked', 'submissions_waiting', 'submissions'].includes(st.label)
    );
    expect(statements.map((st) => st.label)).toEqual([
      'submissions_waiting_forms_locked',
      'submissions_waiting',
      'submissions',
    ]);
    await ds.transaction(async (m) => {
      for (const st of statements) await m.query(st.sql, erasureParams(st, BOB));
    });
    expect(await status(bob.submissionId)).toBeUndefined();
    await service.deleteSubmission(alice.submissionId, OWNER, false);
    expect((await status(carol.submissionId)).paymentStatus).toBe('free');
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
    const stored = await ds.getRepository(Form).findOneByOrFail({ id: formId });
    // The edit raising the capacity promotes in its own save's transaction (`update`).
    await service.update(
      formId,
      {
        title: stored.title,
        items: ITEMS,
        maxSubmissions: 3,
        waitlistEnabled: true,
        associationId: ASSO,
      } as any,
      OWNER,
      false
    );
    await noticesLand();
    expect(pushes.map((p) => p.userId).sort()).toEqual([BOB, CAROL].sort());
    expect((await status(bob.submissionId)).paymentStatus).toBe('free');
    expect((await status(carol.submissionId)).paymentStatus).toBe('free');
    expect((await status(dave.submissionId)).paymentStatus).toBe('waiting');
  });
});
