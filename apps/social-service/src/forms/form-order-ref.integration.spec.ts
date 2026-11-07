/**
 * ONE LYDIA ORDER_REF PER REQUEST (`form-order-ref.ts`), against a REAL PostgreSQL.
 *
 * A retry after a declined payment REUSES the live pending row (`FormsService.submit`), and every
 * request of that row used to carry the same order_ref `form:<submissionId>`, which Lydia refuses
 * on the second request/do (error 3, measured on dev 2026-10-21). This file drives the retry through
 * the real row lock and the real settle, with only core-service faked (axios), and checks the three
 * things the change must keep: a new order_ref per request, a callback about the OLD request settles
 * nothing on the row, and the payment of the new one is recorded once.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
 */
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000b8';
const ATTEMPT_RE = '[0-9a-f]{8}';

maybe('one Lydia order_ref per request of a form answer, against PostgreSQL', () => {
  const schema = `form_order_ref_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  /** Every request/do core was asked for: its order_ref. */
  const orderRefs: string[] = [];
  /** What Lydia's `request/state` answers, per request uuid. */
  const states = new Map<string, string>();
  const RAW: Record<string, string> = { open: '0', paid: '1', declined: '5' };
  /**
   * The form's payee NOW, as the delegation resolves it: a list's receiver may change (or vanish) while
   * a request issued to the previous one is in flight (owner review of #2967).
   */
  let payee: string | null = 'vendor';
  /** The account every request-state read and cancel was sent with. */
  const readWith: string[] = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    const associationsService: any = {
      assertPaymentsReady: async () => undefined,
      getPaymentAccountId: async () => payee,
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
      { enabled: () => false } as any,
      {} as any
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      if (url.endsWith('payments/cancel-request') || url.endsWith('payments/request-state')) {
        readWith.push(body.connectAccountId ?? body.vendorToken);
      }
      if (url.endsWith('payments/cancel-request')) {
        // Lydia's error 2: the request was already processed (here, declined by the payer).
        return { data: { ok: true, outcome: 'already-settled' } };
      }
      if (url.endsWith('payments/request-state')) {
        const state = states.get(body.sessionId) ?? 'open';
        return { data: { ok: true, state, raw: RAW[state] } };
      }
      orderRefs.push(body.idempotencyKey);
      const n = orderRefs.length;
      const uuid = String(n).padStart(32, '0');
      states.set(uuid, 'open');
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${n}`,
          id: uuid,
          requestId: String(9000 + n),
        },
      };
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function oneAnswerPaidForm(): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: 'owner',
        title: 'Gala',
        basePrice: 1200,
        currency: 'eur',
        requiresPayment: true,
        associationId: ASSO,
        allowMultipleSubmissions: false,
        maxSubmissions: 10,
        items: [],
      })
    );
    return form.id;
  }

  const submitAs = (formId: string) =>
    service.submit(formId, { userId: 'member-1', answers: {}, payerEmail: 'm@example.org' } as any);

  // Control (2026-10-27): with `submit` sending `form:${savedSubmission.id}` again, the first
  // expectation on the two order_refs fails - the retry would be refused by Lydia (error 3).
  it('issues a new order_ref for the retry of a declined payment, settles nothing on the old one, and records the new payment once', async () => {
    const formId = await oneAnswerPaidForm();
    await expect(submitAs(formId)).resolves.toHaveProperty('checkoutUrl');
    const [{ id }] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [formId]);
    const oldUuid = String(1).padStart(32, '0');

    // The payer declines on Lydia's page, then answers again: the SAME row, a NEW order_ref.
    states.set(oldUuid, 'declined');
    await expect(submitAs(formId)).resolves.toHaveProperty('checkoutUrl');
    const rows = await ds.query(
      `SELECT id, "paymentStatus", "paymentRequestId", "stripeSessionId" FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(rows).toHaveLength(1);
    const newUuid = String(2).padStart(32, '0');
    expect(rows[0]).toMatchObject({
      id,
      paymentStatus: 'pending',
      paymentRequestId: '9002',
      stripeSessionId: newUuid,
    });
    expect(orderRefs).toHaveLength(2);
    expect(orderRefs[0]).not.toBe(orderRefs[1]);
    for (const ref of orderRefs) expect(ref).toMatch(new RegExp(`^form:${id}:${ATTEMPT_RE}$`));

    // A callback about the OLD request (its order_ref names the same submission): the cancel is
    // not the row's current request, and the confirm reads the row's OWN request, still open.
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      service.cancelPendingSubmission(id, { requestId: '9001' }, 'vendor')
    ).resolves.toEqual({ ok: true, outcome: 'other-request' });
    await expect(
      service.confirmPaymentFromCallback(id, { vendorToken: 'vendor', requestId: '9001' })
    ).resolves.toEqual({ outcome: 'open' });
    // A confirm for a request the row no longer names is accused: if it was paid, a refund is owed.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('a refund is owed'));
    error.mockRestore();
    const [stillPending] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [
      id,
    ]);
    expect(stillPending.paymentStatus).toBe('pending');
    expect(await ds.query(`SELECT id FROM purchase_records WHERE "formId" = $1`, [formId])).toEqual(
      []
    );

    // The new request is paid: its callback and the payer's return, twice each, record it ONCE.
    states.set(newUuid, 'paid');
    await Promise.all([
      service.confirmPaymentFromCallback(id, { vendorToken: 'vendor', requestId: '9002' }),
      service.confirmPaymentFromCallback(id, { vendorToken: 'vendor', requestId: '9002' }),
      service.confirmPayment(id),
      service.confirmPayment(id),
    ]);
    const [paid] = await ds.query(
      `SELECT "paymentStatus", "paymentSettledBy" FROM submissions WHERE id = $1`,
      [id]
    );
    expect(paid.paymentStatus).toBe('paid');
    const records = await ds.query(
      `SELECT "amountCents" FROM purchase_records WHERE "formId" = $1`,
      [formId]
    );
    expect(records).toEqual([{ amountCents: 1200 }]);
  });

  // Owner review of #2967: a list's form request is issued on its receiver A; the delegation is then
  // revoked (no payee) or moved to B within the request's lifetime. The money is at A, so A's verified
  // callback records it, the payer's return reads with A, and a callback verified for B is refused.
  it.each([
    ['revoked', null],
    ['moved to another receiver', 'vendor-b'],
  ])(
    'records a payment issued on the receiver after the delegation was %s, read with the issuing Business',
    async (_case, payeeAfter) => {
      payee = 'vendor-a';
      const formId = await oneAnswerPaidForm();
      await expect(submitAs(formId)).resolves.toHaveProperty('checkoutUrl');
      const [{ id, paymentRequestId, stripeSessionId }] = await ds.query(
        `SELECT id, "paymentRequestId", "stripeSessionId" FROM submissions WHERE "formId" = $1`,
        [formId]
      );
      const [{ lydiaVendorToken }] = await ds.query(
        `SELECT "lydiaVendorToken" FROM submissions WHERE id = $1`,
        [id]
      );
      expect(lydiaVendorToken).toBe('vendor-a');

      payee = payeeAfter;
      states.set(stripeSessionId, 'paid');
      readWith.length = 0;
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // A callback verified for any other Business is not this row's money.
      await expect(
        service.confirmPaymentFromCallback(id, {
          vendorToken: 'vendor-b',
          requestId: paymentRequestId,
        })
      ).resolves.toEqual({ outcome: 'other-account' });
      error.mockRestore();
      await expect(
        service.confirmPaymentFromCallback(id, {
          vendorToken: 'vendor-a',
          requestId: paymentRequestId,
        })
      ).resolves.toEqual({ outcome: 'paid' });
      await service.confirmPayment(id);
      expect(new Set(readWith)).toEqual(new Set(['vendor-a']));
      const [row] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
      expect(row.paymentStatus).toBe('paid');
      expect(
        await ds.query(`SELECT "amountCents" FROM purchase_records WHERE "formId" = $1`, [formId])
      ).toEqual([{ amountCents: 1200 }]);
      payee = 'vendor';
    }
  );
});
