/**
 * A GUEST WHO PAYS (WP-P1 and WP-P2, `public-paid-forms-chantier.md`), against a REAL PostgreSQL.
 *
 * The unit spec (`forms.service.seat-hold.spec.ts`) runs the service on an in-memory store whose
 * "lock" is a JavaScript mutex. What a guest's payment adds is SQL: a purchase record with no buyer
 * (migration 103 drops a NOT NULL), a receipt found by its hash (migration 104), and guests racing for the last seat of a paid public form, or
 * Lydia's callback and the payer's return racing to record one payment - only a database
 * serialises those transactions. So `FormsService` runs here on a real connection, with only
 * core-service faked (axios: the checkout and the request-state read).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- guest-payment.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import {
  DataSource,
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
} from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';
import { GUEST_RECEIPT_NOT_FOUND, hashGuestReceipt } from './guest-receipt';
import { GUEST_PENDING_CEILING, GUEST_PENDING_LIMIT, guestVisitorKey } from './guest-visitor';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/**
 * Widens the window between a submit's capacity count and its INSERT while `slowInserts` is on, so
 * a race the form lock must close is a race on every run, not on the runs where the scheduler
 * happens to interleave (measured: without it, the control below passed two runs in three). With
 * the lock, the inserts queue behind it and each simply takes longer; without it, every racer has
 * counted the seat free before the first insert lands.
 */
let slowInserts = false;
@EventSubscriber()
class SlowSubmissionInsert implements EntitySubscriberInterface<Submission> {
  listenTo() {
    return Submission;
  }
  async beforeInsert(_event: InsertEvent<Submission>): Promise<void> {
    if (slowInserts) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const ASSO = '00000000-0000-4000-8000-0000000000a7';
/** A Lydia `request_uuid`: 32 hex digits, no dash. */
const UUID = '0123456789abcdef0123456789abcdef';

/** A fresh visitor address per call, so a test meets the per-visitor ceiling only where it means to. */
let visitors = 0;
const freshVisitor = () => `198.51.100.${++visitors}`;

maybe('a guest who pays, against PostgreSQL (migrations 103, 104 and 105)', () => {
  const schema = `guest_payment_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let issued = 0;
  /** What Lydia's `request/state` answers, and how many times it was asked. */
  let lydia = { state: 'paid', raw: '1' };
  let stateReads = 0;
  /** The return URL of the last request issued - where the guest's receipt travels. */
  let lastSuccessUrl = '';
  const savedSecret = process.env.INTERNAL_SECRET;

  beforeAll(async () => {
    // The visitor key is an HMAC under the internal secret (`guest-visitor.ts`).
    process.env.INTERNAL_SECRET = 'internal-secret-for-it';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, FormRespondent, PurchaseRecord],
      subscribers: [SlowSubmissionInsert],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The column as production has it BEFORE 103 (`synchronize` builds it from the entity, which is
    // already nullable), then the migration file itself, twice: it must be idempotent.
    await ds.query(`ALTER TABLE purchase_records ALTER COLUMN "userId" SET NOT NULL`);
    const migration = readFileSync(
      join(__dirname, '../migrations/103_purchase_records_guest_buyer.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    // Migration 104 from a table WITHOUT its column, twice: `synchronize` built both from the entity.
    await ds.query(`DROP INDEX submissions_guest_receipt_hash_uniq`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "guestReceiptHash"`);
    const receiptMigration = readFileSync(
      join(__dirname, '../migrations/104_submissions_guest_receipt.sql'),
      'utf8'
    );
    await ds.query(receiptMigration);
    await ds.query(receiptMigration);
    // Migration 105 the same way.
    await ds.query(`DROP INDEX submissions_guest_visitor_idx`);
    await ds.query(`ALTER TABLE submissions DROP COLUMN "guestVisitorKey"`);
    const visitorMigration = readFileSync(
      join(__dirname, '../migrations/105_submissions_guest_visitor.sql'),
      'utf8'
    );
    await ds.query(visitorMigration);
    await ds.query(visitorMigration);

    const associationsService: any = {
      assertPaymentsReady: async () => undefined,
      getPaymentAccountId: async () => 'vendor',
      getLydiaPayeeAccountId: async () => 'vendor',
      getActivePaymentProvider: async () => 'lydia',
      mayAct: async () => false,
    };
    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(FormReminder),
      { get: () => 'https://canari.example' } as any,
      associationsService,
      { grantCotisant: jest.fn() } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      { build: async () => ({ answers: {} }) } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      if (url.endsWith('payments/request-state')) {
        stateReads += 1;
        return { data: { ok: true, ...lydia } };
      }
      issued += 1;
      lastSuccessUrl = body.successUrl;
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${issued}`,
          id: issued === 1 ? UUID : `${String(issued).padStart(32, '0')}`,
          requestId: String(9000 + issued),
        },
      };
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = savedSecret;
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function publicPaidForm(maxSubmissions: number | null): Promise<string> {
    const form = await ds.getRepository(Form).save(
      ds.getRepository(Form).create({
        ownerId: 'owner',
        title: 'Soiree',
        basePrice: 1200,
        currency: 'eur',
        requiresPayment: true,
        associationId: ASSO,
        isPublic: true,
        allowMultipleSubmissions: true,
        maxSubmissions,
        items: [],
      })
    );
    return form.id;
  }

  it('drops the NOT NULL of purchase_records."userId"', async () => {
    const [column] = await ds.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'purchase_records' AND column_name = 'userId'`,
      [schema]
    );
    expect(column.is_nullable).toBe('YES');
  });

  // Control (2026-10-22): `lockFormSeats` removed from `submit` -> eight guests took the seat.
  it('lets eight guests racing for the last seat take it ONCE', async () => {
    const formId = await publicPaidForm(1);
    slowInserts = true;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.submit(
          formId,
          { answers: {}, payerEmail: 'g@example.org' } as any,
          'guest',
          freshVisitor()
        )
      )
    ).finally(() => (slowInserts = false));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await ds.query(
      `SELECT "userId", "paymentStatus" FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(rows).toEqual([{ userId: null, paymentStatus: 'pending' }]);
  });

  it('records a guest payment ONCE, with no buyer, however many confirmations race', async () => {
    const formId = await publicPaidForm(null);
    issued = 0;
    const { checkoutUrl } = (await service.submit(
      formId,
      { answers: {}, payerEmail: 'g@example.org' } as any,
      'guest',
      freshVisitor()
    )) as { checkoutUrl: string };
    expect(checkoutUrl).toBe('https://lydia.example/pay/1');
    const [{ id }] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [formId]);

    // The payer's return (`confirmPayment`, by the uuid) and Lydia's callback (by the numeric id)
    // for ONE payment, eight times over, at once.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? service.confirmPayment(id) : service.markPaid(id, '9001')
      )
    );

    const [row] = await ds.query(
      `SELECT "paymentStatus", "userId" FROM submissions WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ paymentStatus: 'paid', userId: null });
    const records = await ds.query(
      `SELECT "userId", "amountCents", source FROM purchase_records WHERE "formId" = $1`,
      [formId]
    );
    expect(records).toEqual([{ userId: null, amountCents: 1200, source: 'form' }]);
  });

  /**
   * THE GUEST RETURN PAGE'S PROOF (WP-P2) - A SECURITY SURFACE, so each attack the review named is
   * a test here, on the real lookup, with its mutation control recorded beside it.
   */
  describe('the receipt a guest returns with', () => {
    /** One guest answer issued at Lydia; answers its receipt (read off the return URL) and its id. */
    async function guestAnswer(): Promise<{ formId: string; id: string; receipt: string }> {
      lydia = { state: 'paid', raw: '1' };
      const formId = await publicPaidForm(null);
      await service.submit(
        formId,
        { answers: {}, payerEmail: 'g@example.org' } as any,
        'guest',
        freshVisitor()
      );
      const url = new globalThis.URL(lastSuccessUrl);
      expect(url.pathname).toBe(`/f/${formId}/receipt`);
      const receipt = url.searchParams.get('receipt')!;
      const [{ id }] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [formId]);
      return { formId, id, receipt };
    }

    async function refusal(receipt: unknown): Promise<unknown> {
      return service.confirmGuestReceipt(receipt).then(
        () => 'ANSWERED',
        (err: { getStatus?: () => number; message: string }) => ({
          status: err.getStatus?.(),
          message: err.message,
        })
      );
    }

    it('stores the receipt only as its hash, and the real receipt reads the answer', async () => {
      const { id, receipt } = await guestAnswer();
      const [row] = await ds.query(`SELECT "guestReceiptHash" FROM submissions WHERE id = $1`, [
        id,
      ]);
      expect(row.guestReceiptHash).toBe(hashGuestReceipt(receipt));
      expect(row.guestReceiptHash).not.toContain(receipt);
      lydia = { state: 'open', raw: '0' };
      const view = await service.confirmGuestReceipt(receipt);
      expect(view.paymentStatus).toBe('pending');
      expect(view.reference).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    });

    // ATTACK 1 - a guessed or enumerated id gives nothing, and reads like an answer that does not
    // exist. Control (2026-10-22): the lookup also matching the submission id (`where: [{ hash },
    // { id: token }]`) -> the id reached the row and this test failed. (A lookup on the RAW receipt
    // does not fail it - a leaked 64-character hash is refused by the receipt's shape first - but
    // fails the three tests below, the real receipt no longer reading anything.)
    it('answers a submission id, a leaked hash, a guess and a malformed string with the SAME 404', async () => {
      const { id, receipt } = await guestAnswer();
      const reads = stateReads;
      const nonexistent = await refusal('A'.repeat(43));
      expect(nonexistent).toEqual({ status: 404, message: GUEST_RECEIPT_NOT_FOUND });
      for (const guess of [
        id,
        id.replace(/-/g, ''),
        hashGuestReceipt(receipt),
        hashGuestReceipt(receipt).slice(0, 43),
        receipt.slice(0, 42),
        `${receipt}=`,
        '',
        null,
      ]) {
        expect(await refusal(guess)).toEqual(nonexistent);
      }
      // Nothing was asked of the provider for any of them.
      expect(stateReads).toBe(reads);
    });

    // ATTACK 2 - a receipt replayed after settlement does nothing more. Control (2026-10-22):
    // `lydiaRequestToRead` without its CONFIRMABLE status check -> every replay asked Lydia again.
    it('a receipt replayed after the payment settled reads, and does nothing else', async () => {
      const { formId, receipt } = await guestAnswer();
      expect((await service.confirmGuestReceipt(receipt)).paymentStatus).toBe('paid');
      const reads = stateReads;
      const views = await Promise.all(
        Array.from({ length: 6 }, () => service.confirmGuestReceipt(receipt))
      );
      expect(views.map((v) => v.paymentStatus)).toEqual(Array(6).fill('paid'));
      expect(stateReads).toBe(reads);
      const records = await ds.query(`SELECT id FROM purchase_records WHERE "formId" = $1`, [
        formId,
      ]);
      expect(records).toHaveLength(1);
    });

    // ATTACK 3 - a forged return never marks a row paid: whatever the URL says, only Lydia's answer
    // does. Control (2026-10-22): `settleFromProvider` recording on `state !== 'paid'` -> the open
    // request was recorded paid and this test failed.
    it('leaves the answer pending while Lydia has not been paid, however often the guest returns', async () => {
      const { formId, receipt } = await guestAnswer();
      lydia = { state: 'open', raw: '0' };
      for (let i = 0; i < 3; i++) {
        expect((await service.confirmGuestReceipt(receipt)).paymentStatus).toBe('pending');
      }
      const [row] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE "formId" = $1`, [
        formId,
      ]);
      expect(row.paymentStatus).toBe('pending');
      expect(
        await ds.query(`SELECT id FROM purchase_records WHERE "formId" = $1`, [formId])
      ).toEqual([]);
      // Lydia then says paid: the same receipt now confirms it.
      lydia = { state: 'paid', raw: '1' };
      expect((await service.confirmGuestReceipt(receipt)).paymentStatus).toBe('paid');
    });

    it('settles a guest answer from the verified callback alone, with no return at all', async () => {
      const { id } = await guestAnswer();
      expect(await service.confirmPaymentFromCallback(id, { vendorToken: 'vendor' })).toEqual({
        outcome: 'paid',
      });
      const [row] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
      expect(row.paymentStatus).toBe('paid');
    });
  });

  /**
   * THE PER-VISITOR CEILING (WP-P3, PP5): counted from the ROWS, under the form's seat lock - so
   * the proof is concurrent submits on a real database, not a mutex in memory.
   */
  describe('the answers one visitor may leave waiting', () => {
    const submitAs = (formId: string, address: string) =>
      service.submit(formId, { answers: {}, payerEmail: 'g@example.org' } as any, 'guest', address);

    // Controls (2026-10-22): the ceiling check removed from `submit`, or `lockFormSeats` removed
    // (each racer counts before any insert lands) -> more than three rows waiting, this test failed.
    it(`leaves exactly ${GUEST_PENDING_CEILING} answers waiting when one visitor sends eight at once`, async () => {
      const formId = await publicPaidForm(null);
      const address = freshVisitor();
      slowInserts = true;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => submitAs(formId, address))
      ).finally(() => (slowInserts = false));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(GUEST_PENDING_CEILING);
      for (const refused of results.filter((r) => r.status === 'rejected')) {
        const err = (refused as PromiseRejectedResult).reason;
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: GUEST_PENDING_LIMIT });
      }
      const rows = await ds.query(
        `SELECT "guestVisitorKey" FROM submissions WHERE "formId" = $1 AND "paymentStatus" = 'pending'`,
        [formId]
      );
      expect(rows).toHaveLength(GUEST_PENDING_CEILING);
      // The key, never the address.
      for (const row of rows) {
        expect(row.guestVisitorKey).toBe(guestVisitorKey(formId, address));
        expect(row.guestVisitorKey).not.toContain(address);
      }
      // Another visitor, and the same visitor on another form, are other counts.
      await expect(submitAs(formId, freshVisitor())).resolves.toHaveProperty('checkoutUrl');
      await expect(submitAs(await publicPaidForm(null), address)).resolves.toHaveProperty(
        'checkoutUrl'
      );
    });

    it('frees a place as soon as a waiting answer is paid or past its hold - no job needed', async () => {
      const formId = await publicPaidForm(null);
      const address = freshVisitor();
      for (let i = 0; i < GUEST_PENDING_CEILING; i++) await submitAs(formId, address);
      await expect(submitAs(formId, address)).rejects.toMatchObject({ status: 429 });

      const [first, second] = await ds.query(
        `SELECT id FROM submissions WHERE "formId" = $1 ORDER BY "createdAt"`,
        [formId]
      );
      lydia = { state: 'paid', raw: '1' };
      await service.confirmPayment(first.id);
      await expect(submitAs(formId, address)).resolves.toHaveProperty('checkoutUrl');

      await ds.query(
        `UPDATE submissions SET "paymentRequestedAt" = now() - interval '1 hour' WHERE id = $1`,
        [second.id]
      );
      await expect(submitAs(formId, address)).resolves.toHaveProperty('checkoutUrl');
      await expect(submitAs(formId, address)).rejects.toMatchObject({ status: 429 });
    });

    // Control (2026-10-22): the `paymentStatus NOT IN` clause removed -> the waiting rows lost their
    // key too, and this test failed.
    it('forgets the visitor of an answer once it stops waiting, and only then', async () => {
      const formId = await publicPaidForm(null);
      const address = freshVisitor();
      await submitAs(formId, address);
      await submitAs(formId, address);
      const [paid] = await ds.query(
        `SELECT id FROM submissions WHERE "formId" = $1 ORDER BY "createdAt" LIMIT 1`,
        [formId]
      );
      lydia = { state: 'paid', raw: '1' };
      await service.confirmPayment(paid.id);

      expect(await service.forgetSettledGuestVisitors()).toBeGreaterThanOrEqual(1);
      const rows = await ds.query(
        `SELECT "paymentStatus", "guestVisitorKey" FROM submissions WHERE "formId" = $1 ORDER BY "createdAt"`,
        [formId]
      );
      expect(rows).toEqual([
        { paymentStatus: 'paid', guestVisitorKey: null },
        { paymentStatus: 'pending', guestVisitorKey: guestVisitorKey(formId, address) },
      ]);
      // A second run finds nothing left to forget.
      expect(await service.forgetSettledGuestVisitors()).toBe(0);
    });
  });
});
