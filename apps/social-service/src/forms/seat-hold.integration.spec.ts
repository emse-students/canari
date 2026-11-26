/**
 * A CAPPED FORM'S SEAT HOLD ("Reserver ma place"), against a REAL PostgreSQL (migration 186, owner
 * 2026-11-17).
 *
 * `FormsService` runs for real - the hold, its second press, its release, the submit that spends it,
 * the sweep - and so does the waiting list's promotion. What only a database shows: migration 186 as
 * written, a hold counted against everybody but its holder under the form's seat lock, two presses
 * for the last seat holding ONE, an expired hold freeing its seat with no sweep (the count reads its
 * age), and the sweep promoting the first in line into the place a lapsed hold freed.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
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
import { FormsService } from './forms.service';
import { FormWaitlistNoticeService } from './waitlist-notice.service';
import { SEAT_HOLD_SECONDS } from './seat-hold';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a1';
const OWNER = 'o'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);
const DAVE = 'd'.repeat(64);
const ERIN = 'e'.repeat(64);

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

maybe('a capped form seat hold, against PostgreSQL (migration 186)', () => {
  const schema = `seat_hold_it_${Math.random().toString(36).slice(2, 10)}`;
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
    // Migration 186, twice (CD runs it again): the table is built from the migration, not the entities.
    const migration = readFileSync(
      join(__dirname, '../migrations/186_form_seat_holds.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
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

  const rankOf = async (formId: string, userId: string) =>
    (await service.hasSubmission(formId, userId)).waitlist?.rank ?? null;

  const send = (formId: string, userId: string, over: Record<string, unknown> = {}) =>
    service.submit(formId, { userId, answers: ANSWERS, joinWaitlist: true, ...over } as any);

  /** The hold's age on the DATABASE clock, the one every count reads. */
  const age = (formId: string, userId: string, seconds: number) =>
    ds.query(
      `UPDATE form_seat_holds SET "heldAt" = clock_timestamp() - make_interval(secs => $3)
        WHERE "formId" = $1 AND "userId" = $2`,
      [formId, userId, seconds]
    );

  const holds = async (formId: string) =>
    (await ds.query(`SELECT "userId" FROM form_seat_holds WHERE "formId" = $1`, [formId])) as {
      userId: string;
    }[];

  it('migration 186 creates the table, runs twice, and a form takes its holds with it', async () => {
    const columns = await ds.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'form_seat_holds' ORDER BY column_name`,
      [schema]
    );
    expect(columns).toEqual([
      { column_name: 'formId', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'heldAt', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'userId', data_type: 'character varying', is_nullable: 'NO' },
    ]);
    const formId = await makeForm({ maxSubmissions: 2 });
    await service.holdSeat(formId, ALICE);
    await ds.query(`DELETE FROM forms WHERE id = $1`, [formId]);
    expect(await holds(formId)).toEqual([]);
  });

  it('holds a seat for ten minutes against everybody else, and a second press is the same hold', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    const first = await service.holdSeat(formId, ALICE);
    expect(first.secondsLeft).toBeGreaterThan(SEAT_HOLD_SECONDS - 30);
    expect(first.secondsLeft).toBeLessThanOrEqual(SEAT_HOLD_SECONDS);
    // 100 s in, a second press answers the SAME hold: its clock is not restarted.
    await age(formId, ALICE, 100);
    const again = await service.holdSeat(formId, ALICE);
    expect(again.secondsLeft).toBeLessThan(SEAT_HOLD_SECONDS - 90);
    expect(await holds(formId)).toHaveLength(1);
    // Everybody else finds the form full, to a submit and to a hold; the holder does not.
    expect(await refusal(send(formId, BOB))).toEqual({ status: 400, code: 'FORM_FULL' });
    expect(await refusal(service.holdSeat(formId, BOB))).toEqual({
      status: 400,
      code: 'FORM_FULL',
    });
    expect((await service.hasSubmission(formId, BOB)).formFull).toBe(true);
    const mine = await service.hasSubmission(formId, ALICE);
    expect(mine.formFull).toBe(false);
    expect(mine.seatHold?.secondsLeft).toBeLessThan(SEAT_HOLD_SECONDS - 90);
    expect((await service.hasSubmission(formId, BOB)).seatHold).toBeNull();
  });

  it('turns the hold into the answer: the submit spends it, and the seat stays taken', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    await service.holdSeat(formId, ALICE);
    await send(formId, ALICE);
    expect(await holds(formId)).toEqual([]);
    expect(await refusal(send(formId, BOB))).toEqual({ status: 400, code: 'FORM_FULL' });
    // A person who answered cannot hold another seat of a one-answer form.
    expect((await refusal(service.holdSeat(formId, ALICE))).code).toBe('ALREADY_ANSWERED');
  });

  it('frees the seat of an expired hold with no sweep, and the sweep deletes the dead row', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    await service.holdSeat(formId, ALICE);
    await age(formId, ALICE, SEAT_HOLD_SECONDS + 5);
    // No job ran: the count reads the age.
    expect((await service.hasSubmission(formId, BOB)).formFull).toBe(false);
    await send(formId, BOB);
    // The late holder finds the seat gone, and the form full.
    expect(await refusal(send(formId, ALICE))).toEqual({ status: 400, code: 'FORM_FULL' });
    expect(await service.expireLapsedSeatHolds()).toBe(1);
    expect(await holds(formId)).toEqual([]);
    expect(await service.expireLapsedSeatHolds()).toBe(0);
  });

  it('a lapsed hold restarts on a new press when a seat is free', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    await service.holdSeat(formId, ALICE);
    await age(formId, ALICE, SEAT_HOLD_SECONDS + 5);
    const renewed = await service.holdSeat(formId, ALICE);
    expect(renewed.secondsLeft).toBeGreaterThan(SEAT_HOLD_SECONDS - 30);
  });

  it('gives the seat back on request, idempotently', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    await service.holdSeat(formId, ALICE);
    await service.releaseSeatHold(formId, ALICE);
    await service.releaseSeatHold(formId, ALICE);
    expect(await holds(formId)).toEqual([]);
    await send(formId, BOB);
  });

  it('two people pressing for the last seat: exactly one holds it', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: false });
    const outcomes = await Promise.allSettled([
      service.holdSeat(formId, ALICE),
      service.holdSeat(formId, BOB),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await holds(formId)).toHaveLength(1);
  });

  it('holds count against the capacity for a promotion, and the sweep promotes the first in line when one lapses', async () => {
    const formId = await makeForm({ maxSubmissions: 1, waitlistEnabled: true });
    await service.holdSeat(formId, ALICE);
    // Full by the hold: Bob joins the list.
    const bob = (await send(formId, BOB)) as { id?: string; submissionId?: string };
    expect(await rankOf(formId, BOB)).toBe(1);
    await age(formId, ALICE, SEAT_HOLD_SECONDS + 5);
    expect(bob).toBeDefined();
    expect(await service.expireLapsedSeatHolds()).toBe(1);
    // The place the hold freed went to the first in line, in the sweep's own transaction.
    const [row] = await ds.query(
      `SELECT "paymentStatus" FROM submissions WHERE "formId" = $1 AND "userId" = $2`,
      [formId, BOB]
    );
    expect(row.paymentStatus).toBe('free');
  });

  it('refuses a hold on a form that holds none: uncapped, or anonymous', async () => {
    const uncapped = await makeForm({ maxSubmissions: null } as Partial<Form>);
    expect(await refusal(service.holdSeat(uncapped, ALICE))).toEqual({
      status: 400,
      code: 'SEAT_HOLD_NOT_AVAILABLE',
    });
    const anonymous = await makeForm({ maxSubmissions: 2, anonymous: true } as Partial<Form>);
    expect(await refusal(service.holdSeat(anonymous, ALICE))).toEqual({
      status: 400,
      code: 'SEAT_HOLD_NOT_AVAILABLE',
    });
  });

  it('the erasure statement deletes the account holds', async () => {
    const formId = await makeForm({ maxSubmissions: 3 });
    await service.holdSeat(formId, ALICE);
    await service.holdSeat(formId, BOB);
    const statement = ERASURE_ROW_STATEMENTS.find((s) => s.label === 'form_seat_holds');
    expect(statement).toBeDefined();
    await ds.query(statement!.sql, erasureParams(statement!, ALICE));
    expect((await holds(formId)).map((h) => h.userId)).toEqual([BOB]);
  });
});
