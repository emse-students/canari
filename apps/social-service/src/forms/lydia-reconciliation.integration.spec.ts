/**
 * THE LYDIA RECONCILIATION SWEEP against a REAL PostgreSQL: its selection SQL, and the sweep racing
 * the payer's return on one payment. The unit spec fakes the query builder and every write, so it
 * cannot show that the rows the SQL picks are the right ones, nor that a sweep and a return settling
 * the SAME payment at once record it ONCE - only a database serialises two transactions.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-reconciliation.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. core-service is faked (axios for
 * the verified read and the forms' own read, an `HttpService` for the boutique's).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import { of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormSeatHold } from './entities/form-seat-hold.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { AssociationProduct } from '../associations/entities/association-product.entity';
import { Association } from '../associations/entities/association.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { UserTagService } from '../users/user-tag.service';
import { deriveCotisationTag } from '../associations/cotisation-tag.util';
import { ProductsService } from '../associations/products.service';
import { LydiaReconciliationService } from './lydia-reconciliation.service';
import { LYDIA_REFUSALS_FINAL, type LydiaRefusalsFinal } from '../common/core-payment-error';
import { takeLogged } from '../common/testing/integration-log-guard.it-fixture';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000c1';
const PRODUCT = '00000000-0000-4000-8000-0000000000c2';
const VENDOR_WITH_KEY = 'vendor-with-key';
const VENDOR_WITHOUT_KEY = 'vendor-without-key';
/** A Lydia `request_uuid`: 32 hex digits, no dash. */
const uuid = (n: number) => n.toString(16).padStart(32, 'a');

maybe('the Lydia reconciliation sweep, against PostgreSQL', () => {
  const schema = `lydia_reconcile_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let forms: FormsService;
  let products: ProductsService;
  let sweep: LydiaReconciliationService;
  /** A sweep whose allowlist (or whose products service) a test replaces, its own instance. */
  let sweepWith: (
    refusals: LydiaRefusalsFinal,
    withProducts?: ProductsService
  ) => LydiaReconciliationService;
  /** What Lydia's `request/state` answers, to the sweep (verified) and to the returns (unverified). */
  let lydia = { state: 'paid', raw: '1', verification: 'verified' };
  /** Core or Lydia unreachable: the verified read throws, as axios does on a 503. */
  let lydiaDown = false;
  /** Lydia REFUSES the read with this code (core's typed 400), or null. */
  let lydiaRefuses: string | null = null;
  /** Core answers its 503 PAYMENT_SERVICE_NOT_READY to the read (payments switched off). */
  let coreNotReady = false;
  /** Lydia REFUSES the cancel (core's typed 400). */
  let cancelRefused = false;
  /** An axios-shaped error carrying core's answer. */
  const coreAnswered = (status: number, data: unknown) =>
    Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
  let verifiedReads = 0;
  /** The tick's ONE hold cutoff, from the database clock, as the scheduler reads it. */
  const cutoffNow = () => forms.pendingHoldCutoff();

  const savedSwitch = process.env.LYDIA_RECONCILE_ENABLED;

  beforeAll(async () => {
    // The switch as dev renders it: these tests are about what the sweep does when it runs.
    process.env.LYDIA_RECONCILE_ENABLED = 'true';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = { extra: { options: `-c search_path=${schema},public` } };
    const entities = [
      Form,
      Submission,
      FormSeatHold,
      FormReminder,
      OpeningReminder,
      FormRespondent,
      PurchaseRecord,
    ];
    const built = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...entities, AssociationProduct, Association, UserTag],
      synchronize: true,
      ...options,
    });
    await built.initialize();
    await built.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...entities, AssociationProduct, ProductCheckout, Association, UserTag],
      synchronize: false,
      ...options,
    });
    await ds.initialize();
    // The attempt table from its migration, as production has it.
    await ds.query(
      readFileSync(join(__dirname, '../migrations/101_product_checkouts.sql'), 'utf8')
    );
    // The opening's frozen tier (112), on the same connection as its RESET: the migration's
    // `SET lock_timeout` must not stay on a pool connection.
    await ds.query(
      `${readFileSync(join(__dirname, '../migrations/112_product_checkouts_held_tier.sql'), 'utf8')}
RESET lock_timeout;`
    );
    // `associations` is the entity's own table (built above): the sweep's key test reads its Lydia
    // columns, and the tier settlement reads its slug and cotisation mode.
    // The one column of `spaces` the association's derived `isBdeAssociation` reads.
    await ds.query(
      `CREATE TABLE spaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "bdeAssociationId" uuid)`
    );
    // The bridge's table (lydia-account-bridge.ts): the key test reads every Business held.
    await ds.query(
      `${readFileSync(join(__dirname, '../migrations/167_lydia_account_bridge.sql'), 'utf8')}
RESET lock_timeout;`
    );
    await ds.query(
      `INSERT INTO associations (id, name, slug, "createdBy", "lydiaAccountId", "lydiaBusinessKeyCiphertext")
       VALUES ($1, 'BDE', 'bde', 'it', $2, 'sealed'), ('00000000-0000-4000-8000-0000000000c9', 'Other', 'other', 'it', $3, NULL)`,
      [ASSO, VENDOR_WITH_KEY, VENDOR_WITHOUT_KEY]
    );

    const purchaseRecordService = new PurchaseRecordService(ds.getRepository(PurchaseRecord));
    const associationsService: any = {
      getPaymentAccountId: async () => VENDOR_WITH_KEY,
      getActivePaymentProvider: async () => 'lydia',
    };
    forms = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(OpeningReminder),
      { get: () => 'https://canari.example' } as any,
      associationsService,
      { grantCotisant: jest.fn() } as any,
      purchaseRecordService,
      {
        build: async () => ({
          cursus: [{ promo: null, formation: null }],
          cotisationTiers: [],
          answers: {},
        }),
      } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    // The boutique's return reads through Nest's HttpService: the same answer, unverified.
    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      refusalsFinal: LYDIA_REFUSALS_FINAL,
      checkoutRepo: ds.getRepository(ProductCheckout),
      purchaseRecordService,
      userTagService: new UserTagService(ds.getRepository(UserTag)),
      httpService: {
        post: (url: string) => {
          if (!url.endsWith('payments/cancel-request')) {
            return of({ data: { ok: true, state: lydia.state, raw: lydia.raw } });
          }
          return cancelRefused
            ? throwError(() =>
                coreAnswered(400, { code: 'PAYMENT_PROVIDER_REFUSED', providerCode: '3' })
              )
            : of({ data: { ok: true, outcome: 'cancelled' } });
        },
      },
    }) as unknown as ProductsService;
    sweepWith = (refusals, withProducts = products) => {
      class WithRefusals extends LydiaReconciliationService {
        protected override readonly refusalsFinal = refusals;
      }
      return new WithRefusals(
        ds.getRepository(Submission),
        ds.getRepository(ProductCheckout),
        forms,
        withProducts
      );
    };
    sweep = new LydiaReconciliationService(
      ds.getRepository(Submission),
      ds.getRepository(ProductCheckout),
      forms,
      products
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      if (!url.endsWith('payments/request-state')) throw new Error(`unexpected call to ${url}`);
      if (body.expectedAmountCents !== undefined) {
        verifiedReads += 1;
        if (lydiaDown) throw coreAnswered(503, { message: 'Service Unavailable' });
        if (coreNotReady) throw coreAnswered(503, { code: 'PAYMENT_SERVICE_NOT_READY' });
        if (lydiaRefuses) {
          throw coreAnswered(400, { code: 'PAYMENT_PROVIDER_REFUSED', providerCode: lydiaRefuses });
        }
        return { data: { ok: true, ...lydia } };
      }
      return { data: { ok: true, state: lydia.state, raw: lydia.raw } };
    });
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    if (savedSwitch === undefined) delete process.env.LYDIA_RECONCILE_ENABLED;
    else process.env.LYDIA_RECONCILE_ENABLED = savedSwitch;
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    lydia = { state: 'paid', raw: '1', verification: 'verified' };
    lydiaDown = false;
    lydiaRefuses = null;
    coreNotReady = false;
    cancelRefused = false;
    verifiedReads = 0;
    sweep.takeCounts();
  });

  async function paidForm(): Promise<string> {
    const form = await ds.getRepository(Form).save(
      ds.getRepository(Form).create({
        ownerId: 'owner',
        title: 'Gala',
        basePrice: 1500,
        currency: 'eur',
        requiresPayment: true,
        associationId: ASSO,
        allowMultipleSubmissions: true,
        maxSubmissions: null,
        items: [],
      })
    );
    return form.id;
  }

  /** An online answer waiting on request `n`, issued `minutesAgo` minutes ago. */
  async function pendingAnswer(formId: string, n: number, minutesAgo: number): Promise<string> {
    const row = await ds.getRepository(Submission).save(
      ds.getRepository(Submission).create({
        formId,
        userId: `user-${n}`,
        answers: {},
        totalPaid: 1500,
        paymentStatus: 'pending',
        stripeSessionId: uuid(n),
        paymentRequestId: String(7000 + n),
        // The Business the request was issued to: what the sweep reads it with.
        lydiaVendorToken: VENDOR_WITH_KEY,
      })
    );
    await ds.query(
      `UPDATE submissions SET "paymentRequestedAt" = now() - make_interval(mins => $2) WHERE id = $1`,
      [row.id, minutesAgo]
    );
    return row.id;
  }

  it('reads only the online answers whose request has ENDED, and a second run reads nothing', async () => {
    const formId = await paidForm();
    const ended = await pendingAnswer(formId, 1, 31);
    const live = await pendingAnswer(formId, 2, 10);
    // A historic `cs_...` id core would refuse: never sent.
    const foreignId = await pendingAnswer(formId, 3, 40);
    await ds.query(`UPDATE submissions SET "stripeSessionId" = 'cs_test_x' WHERE id = $1`, [
      foreignId,
    ]);

    await sweep.sweepFormPayments(await cutoffNow());
    const status = async (id: string) =>
      (await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]))[0]
        .paymentStatus;
    expect(verifiedReads).toBe(1);
    expect(await status(ended)).toBe('paid');
    expect(await status(live)).toBe('pending');
    expect(await status(foreignId)).toBe('pending');

    // Idempotent from the row: the settled one left `pending`, so the next tick selects nothing.
    await sweep.sweepFormPayments(await cutoffNow());
    expect(verifiedReads).toBe(1);
    expect(sweep.takeCounts().forms).toMatchObject({ examined: 1, settled: 1, errors: 0 });
  });

  it('records ONE payment when the sweep and seven payer returns settle it at once', async () => {
    const formId = await paidForm();
    const id = await pendingAnswer(formId, 10, 31);
    const row = await ds.getRepository(Submission).findOneByOrFail({ id });

    await Promise.all([
      sweep.reconcileSubmission(row),
      ...Array.from({ length: 7 }, () => forms.confirmPayment(id)),
    ]);

    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
    expect(after.paymentStatus).toBe('paid');
    const records = await ds.query(
      `SELECT "amountCents" FROM purchase_records WHERE "formId" = $1`,
      [formId]
    );
    expect(records).toEqual([{ amountCents: 1500 }]);
  });

  it('settles nothing on an answer that does not verify, the expiry still runs after it, and the next tick asks nothing', async () => {
    lydia = { state: 'paid', raw: '1', verification: 'mismatch' };
    const formId = await paidForm();
    const id = await pendingAnswer(formId, 20, 31);
    const cutoff = await cutoffNow();
    await sweep.sweepFormPayments(cutoff);
    await forms.expireStalePendingPayments(cutoff);
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
    expect(after.paymentStatus).toBe('expired');
    expect(
      await ds.query(`SELECT 1 FROM purchase_records WHERE "formId" = $1`, [formId])
    ).toHaveLength(0);
    // ASKED ONCE: the expiry took the row the read could not settle out of the selection.
    expect(verifiedReads).toBe(1);
    await sweep.sweepFormPayments(await cutoffNow());
    expect(verifiedReads).toBe(1);

    takeLogged(
      'error',
      /^\[RECONCILE\] submission [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa14\): Lydia's answer \(paid, code 1\) does NOT verify over 1500 cents with the Business key - another amount, another key, or not Lydia; nothing settled$/
    );
  });

  // With a clock each, the expiry's later now() took in a row the read's earlier SELECT had not:
  // expired UNREAD. One cutoff for both, and that row is read in the next tick instead.
  it('never expires an answer the read of the same tick did not select', async () => {
    const formId = await paidForm();
    const cutoff = await cutoffNow();
    const id = await pendingAnswer(formId, 40, 0);
    // Its hold ends just AFTER the tick's cutoff - what a clock read later would already include.
    await ds.query(
      `UPDATE submissions SET "paymentRequestedAt" = $2::timestamptz + interval '1 millisecond' WHERE id = $1`,
      [id, cutoff]
    );
    await sweep.sweepFormPayments(cutoff);
    await forms.expireStalePendingPayments(new Date(cutoff));
    const status = async () =>
      (await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]))[0]
        .paymentStatus;
    expect(verifiedReads).toBe(0);
    expect(await status()).toBe('pending');

    const next = new Date(cutoff.getTime() + 5 * 60_000);
    await sweep.sweepFormPayments(next);
    await forms.expireStalePendingPayments(next);
    expect(verifiedReads).toBe(1);
    expect(await status()).toBe('paid');
  });

  it('releases an answer whose request Lydia says was declined, as the return does', async () => {
    lydia = { state: 'declined', raw: '5', verification: 'verified' };
    const formId = await paidForm();
    const id = await pendingAnswer(formId, 30, 31);
    await sweep.sweepFormPayments(await cutoffNow());
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
    expect(after.paymentStatus).toBe('cancelled');
  });

  describe('boutique attempts', () => {
    let buyers = 0;
    const attempt = (overrides: Partial<ProductCheckout> = {}) =>
      ds.getRepository(ProductCheckout).save(
        ds.getRepository(ProductCheckout).create({
          productId: PRODUCT,
          // `x`, not a digit: `buyer-1` padded with zeros IS `buyer-10` padded with zeros.
          userId: `buyer-${++buyers}`.padEnd(64, 'x'),
          associationId: ASSO,
          paymentAssociationId: ASSO,
          vendorToken: VENDOR_WITH_KEY,
          amountCents: 1000,
          currency: 'eur',
          productName: 'Sweat',
          requestUuid: uuid(1000 + buyers),
          requestId: String(8000 + buyers),
          status: 'open',
          // Ended: past `expiresAt` + the 5-minute margin.
          expiresAt: new Date(Date.now() - 6 * 60_000),
          settledAt: null,
          purchaseRecordId: null,
          ...overrides,
        })
      );
    const statusOf = async (id: string) =>
      (await ds.query(`SELECT status FROM product_checkouts WHERE id = $1`, [id]))[0].status;

    it('reads only ended open attempts of a Business holding a key, and counts the others', async () => {
      const due = await attempt();
      const live = await attempt({ expiresAt: new Date(Date.now() + 10 * 60_000) });
      const inMargin = await attempt({ expiresAt: new Date(Date.now() - 60_000) });
      const noKey = await attempt({ vendorToken: VENDOR_WITHOUT_KEY });

      await expect(sweep.openWithoutKey()).resolves.toBe(1);
      await sweep.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);
      expect(await statusOf(due.id)).toBe('paid');
      for (const row of [live, inMargin, noKey]) expect(await statusOf(row.id)).toBe('open');

      await sweep.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);

      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    it('records ONE purchase when the sweep and seven payer returns settle one attempt at once', async () => {
      const row = await attempt();
      await Promise.all([
        sweep.reconcileCheckout(row),
        ...Array.from({ length: 7 }, () =>
          products.confirmCheckout(ASSO, PRODUCT, row.id, row.userId)
        ),
      ]);
      expect(await statusOf(row.id)).toBe('paid');
      const records = await ds.query(`SELECT id FROM purchase_records WHERE "userId" = $1`, [
        row.userId,
      ]);
      expect(records).toHaveLength(1);

      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    it('closes a verified expired attempt', async () => {
      lydia = { state: 'cancelled-or-expired', raw: '6', verification: 'verified' };
      const closed = await attempt();
      await sweep.reconcileCheckout(closed);
      expect(await statusOf(closed.id)).toBe('expired');
    });

    it('leaves an attempt open while core or Lydia gives no answer, and settles it at the next tick', async () => {
      const row = await attempt();
      lydiaDown = true;
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      lydiaDown = false;
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('paid');
      expect(verifiedReads).toBe(2);

      takeLogged(
        'warn',
        '[RECONCILE] boutique: 1 call(s) got no answer this tick (core or Lydia unreachable, a 5xx, a timeout, an unknown verdict) - left open, read again next tick'
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    // Control: the sweep that closed its attempt in a catch expired this one - Lydia said PAID and
    // no purchase was recorded, by anything, ever.
    it('never closes a verified PAID attempt whose settlement write failed: the next tick records it', async () => {
      const row = await attempt();
      const apply = jest
        .spyOn(products, 'applyRequestState')
        .mockRejectedValueOnce(new Error('deadlock detected'));
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      apply.mockRestore();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('paid');
      expect(
        await ds.query(`SELECT 1 FROM purchase_records WHERE "userId" = $1`, [row.userId])
      ).toHaveLength(1);

      takeLogged(
        'error',
        /^\[RECONCILE\] boutique: 1 settlement write\(s\) FAILED this tick after a verified read \(first: deadlock detected\) - Lydia answered PAID for 1, NOT recorded yet: [0-9a-f-]{36} - left open, settled again next tick CheckoutSettlementFailed: deadlock detected$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    // Closed only on a refusal on the allowlist - EMPTY for real until a code is measured final on
    // an issued request, so a test-only code goes through the same mechanism.
    it('closes an attempt whose read Lydia refused with a code known final, once', async () => {
      lydiaRefuses = 'test-only-final';
      const withFinal = sweepWith({ read: new Set(['test-only-final']), cancel: new Set() });
      const row = await attempt();
      await withFinal.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('expired');
      await withFinal.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);

      takeLogged(
        'error',
        /^\[RECONCILE\] checkout [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaa3f1\): the read was REFUSED by Lydia \(error test-only-final\) - nothing settled$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8} is past its expire_time and still unproven \(its reconciliation read: refused for good \(error test-only-final\)\) - closed as expired so its buyer may retry; a payment taken before it expired is still recorded by its confirm callback$/
      );
    });

    // Error 2 was measured on a uuid Lydia never issued; on an issued one it is unmeasured, and a
    // PAID request whose callback was lost, closed on it, would be recorded by nothing.
    it('leaves open, and settles later, an attempt whose read Lydia refused with error 2', async () => {
      lydiaRefuses = '2';
      const row = await attempt();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      lydiaRefuses = null;
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('paid');

      takeLogged(
        'error',
        /^\[RECONCILE\] boutique: 1 attempt\(s\) left open on an answer that is not final - [0-9a-f-]{36} \(read refused, error 2, not known final\) - read again next tick; said again when this list changes \(0 before\)$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    // Any OTHER refusal can be a state of Lydia (error 5, "temporarily blocked"): closing it lost
    // a PAID request whose callback was lost - nothing reads a closed attempt again.
    it('leaves open, and settles later, an attempt whose read was refused with a code not known final', async () => {
      lydiaRefuses = '5';
      const row = await attempt();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      lydiaRefuses = null;
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('paid');

      takeLogged(
        'error',
        /^\[RECONCILE\] boutique: 1 attempt\(s\) left open on an answer that is not final - [0-9a-f-]{36} \(read refused, error 5, not known final\) - read again next tick; said again when this list changes \(0 before\)$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    it('leaves open an attempt read while core answers it is not ready (payments switched off)', async () => {
      coreNotReady = true;
      const row = await attempt();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      coreNotReady = false;
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('paid');

      takeLogged(
        'error',
        /^\[RECONCILE\] boutique: 1 attempt\(s\) left open on an answer that is not final - [0-9a-f-]{36} \(read: core answered HTTP 503 about itself\) - read again next tick; said again when this list changes \(0 before\)$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    // The cancel's allowlist is EMPTY for real; a code put on it through the same mechanism closes.
    it('closes an attempt whose CANCEL Lydia refused with a code on the allowlist', async () => {
      lydia = { state: 'open', raw: '0', verification: 'verified' };
      cancelRefused = true;
      const cancelFinal: LydiaRefusalsFinal = { read: new Set(), cancel: new Set(['3']) };
      const withFinal = sweepWith(
        cancelFinal,
        Object.assign(Object.create(ProductsService.prototype) as object, products, {
          refusalsFinal: cancelFinal,
        }) as ProductsService
      );
      const row = await attempt();
      await withFinal.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('expired');

      takeLogged(
        'warn',
        /^\[RECONCILE\] checkout [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaa3f5\): still OPEN at Lydia past the expire_time Canari sent it - cancelling it there, then closing it$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8} is past its expire_time and still unproven \(its reconciliation read: still open at Lydia past its end; its cancel at Lydia was refused for good \(error 3\)\) - closed as expired so its buyer may retry; a payment taken before it expired is still recorded by its confirm callback$/
      );
    });

    it('leaves open an attempt whose CANCEL Lydia refused with a code not known final, accused once per tick', async () => {
      lydia = { state: 'open', raw: '0', verification: 'verified' };
      cancelRefused = true;
      const error = jest.spyOn(Logger.prototype, 'error');
      error.mockClear();
      const row = await attempt();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('open');
      expect(
        error.mock.calls.filter(([line]) => String(line).includes('still unproven'))
      ).toHaveLength(0);
      expect(
        error.mock.calls.filter(([line]) =>
          String(line).includes('left open on an answer that is not final')
        )
      ).toHaveLength(1);
      // Lydia then says it expired: the next tick closes it from that verified answer.
      cancelRefused = false;
      lydia = { state: 'cancelled-or-expired', raw: '6', verification: 'verified' };
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('expired');

      takeLogged(
        'warn',
        /^\[RECONCILE\] checkout [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaa3f6\): still OPEN at Lydia past the expire_time Canari sent it - cancelling it there, then closing it$/
      );
      takeLogged(
        'error',
        /^\[RECONCILE\] boutique: 1 attempt\(s\) left open on an answer that is not final - [0-9a-f-]{36} \(cancel refused, error 3, not known final\) - read again next tick; said again when this list changes \(0 before\)$/
      );
    });

    it('cancels at Lydia, then closes, an attempt Lydia verifiably says is still open past its end', async () => {
      lydia = { state: 'open', raw: '0', verification: 'verified' };
      const row = await attempt();
      await sweep.sweepProductCheckouts();
      expect(await statusOf(row.id)).toBe('cancelled');
      await sweep.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);

      takeLogged(
        'warn',
        /^\[RECONCILE\] checkout [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaa3f7\): still OPEN at Lydia past the expire_time Canari sent it - cancelling it there, then closing it$/
      );
    });

    it('closes an attempt its one read could not verify, never reads it again, and its callback still records the payment', async () => {
      lydia = { state: 'paid', raw: '1', verification: 'unsigned' };
      const unproven = await attempt();
      await sweep.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);
      expect(await statusOf(unproven.id)).toBe('expired');
      expect(
        await ds.query(`SELECT 1 FROM purchase_records WHERE "userId" = $1`, [unproven.userId])
      ).toHaveLength(0);

      // ASKED ONCE: the second tick selects nothing.
      await sweep.sweepProductCheckouts();
      expect(verifiedReads).toBe(1);
      expect(sweep.takeCounts().products).toMatchObject({ examined: 1, skippedUnverified: 1 });

      // Lydia's VERIFIED confirm callback asks even of the closed attempt: the money is recorded.
      await expect(
        products.handlePurchaseCompleted(
          PRODUCT,
          unproven.id,
          unproven.requestId as string,
          VENDOR_WITH_KEY
        )
      ).resolves.toEqual({ outcome: 'paid' });
      expect(await statusOf(unproven.id)).toBe('paid');
      expect(
        await ds.query(`SELECT 1 FROM purchase_records WHERE "userId" = $1`, [unproven.userId])
      ).toHaveLength(1);

      takeLogged(
        'warn',
        /^\[RECONCILE\] checkout [0-9a-f-]{36} \(request aaaaaaaaaaaaaaaaaaaaaaaaaaaaa3f8\): Lydia's answer \(paid, code 1\) is unsigned, not verified - nothing settled$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8} is past its expire_time and still unproven \(its reconciliation read: unsigned\) - closed as expired so its buyer may retry; a payment taken before it expired is still recorded by its confirm callback$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8} was expired and the provider says PAID - recorded; check the buyer's other attempts of product 00000000 for a charge to refund$/
      );
      takeLogged(
        'error',
        /^\[SHOP\] checkout [0-9a-f]{6,8}: product [0-9a-f]{6,8} no longer exists - payment recorded paid_not_granted, nothing delivered; a refund is owed$/
      );
    });

    // LAST of the describe: its checkout takes a number of the shared counter, and the cases above
    // name their request ids by it.
    it('a tier the buyer no longer rises to when the sweep settles it is recorded paid_not_granted, and no tag is swapped', async () => {
      // The association sells two tiers; the buyer opened a checkout of the CHEAP one while holding
      // nothing (so it froze nothing), then took the DEARER one by another road before the sweep
      // settled the cheap payment: the money was taken for a tier that is no longer a rise.
      try {
        await ds.query(`UPDATE associations SET "cotisationMode" = 'lifetime' WHERE id = $1`, [
          ASSO,
        ]);
        const tier = (name: string, variantKey: string, amountCents: number) =>
          ds.getRepository(AssociationProduct).save(
            ds.getRepository(AssociationProduct).create({
              associationId: ASSO,
              name,
              type: 'membership',
              variantKey,
              amountCents,
              grantedTagName: deriveCotisationTag('bde', 'lifetime', new Date(), variantKey)
                .tagName,
            })
          );
        const cheap = await tier('Cheap', 'cheap', 500);
        await tier('Dear', 'dear', 1500);
        const row = await attempt({ productId: cheap.id, amountCents: 500, productName: 'Cheap' });
        await ds.getRepository(UserTag).save(
          ds.getRepository(UserTag).create({
            userId: row.userId,
            tagName: deriveCotisationTag('bde', 'lifetime', new Date(), 'dear').tagName,
            issuingAssocId: ASSO,
            grantedBy: 'cash-desk',
          })
        );

        await sweep.sweepProductCheckouts();

        expect(await statusOf(row.id)).toBe('paid');
        const [record] = await ds.query(`SELECT status FROM purchase_records WHERE "userId" = $1`, [
          row.userId,
        ]);
        expect(record.status).toBe('paid_not_granted');
        const tags = (await ds.query(`SELECT "tagName" FROM user_tags WHERE "userId" = $1`, [
          row.userId,
        ])) as { tagName: string }[];
        expect(tags.map((t) => t.tagName)).toEqual(['cotisant:bde-dear']);
        takeLogged(
          'error',
          /^\[SHOP\] checkout [0-9a-f]{6,8}: paid tier is held-changed at settlement \(product=[0-9a-f]{6,8} user=buyer-\d+x* held=\[dear\] opened-over=none\) - payment recorded, tier NOT granted; a refund is owed$/
        );
      } finally {
        // The shared estate of the other cases: no tier, no tag, no cotisation mode left behind.
        await ds.query(`UPDATE associations SET "cotisationMode" = NULL WHERE id = $1`, [ASSO]);
        await ds.query(`DELETE FROM association_products WHERE "associationId" = $1`, [ASSO]);
        await ds.query(`DELETE FROM user_tags WHERE "issuingAssocId" = $1`, [ASSO]);
      }
    });
  });
});
