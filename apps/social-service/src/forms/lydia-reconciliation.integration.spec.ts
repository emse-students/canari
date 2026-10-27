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
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { AssociationProduct } from '../associations/entities/association-product.entity';
import { ProductsService } from '../associations/products.service';
import { LydiaReconciliationService } from './lydia-reconciliation.service';

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
  /** What Lydia's `request/state` answers, to the sweep (verified) and to the returns (unverified). */
  let lydia = { state: 'paid', raw: '1', verification: 'verified' };
  let verifiedReads = 0;

  const savedSwitch = process.env.LYDIA_RECONCILE_ENABLED;

  beforeAll(async () => {
    // The switch as dev renders it: these tests are about what the sweep does when it runs.
    process.env.LYDIA_RECONCILE_ENABLED = 'true';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = { extra: { options: `-c search_path=${schema},public` } };
    const entities = [Form, Submission, FormReminder, FormRespondent, PurchaseRecord];
    const built = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...entities, AssociationProduct],
      synchronize: true,
      ...options,
    });
    await built.initialize();
    await built.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...entities, AssociationProduct, ProductCheckout],
      synchronize: false,
      ...options,
    });
    await ds.initialize();
    // The attempt table from its migration, as production has it.
    await ds.query(
      readFileSync(join(__dirname, '../migrations/101_product_checkouts.sql'), 'utf8')
    );
    // The two columns of `associations` the sweep's key test reads, and nothing else of it.
    await ds.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, "lydiaAccountId" varchar(255),
         "lydiaBusinessKeyCiphertext" text)`
    );
    await ds.query(
      `INSERT INTO associations VALUES ($1, $2, 'sealed'), ('00000000-0000-4000-8000-0000000000c9', $3, NULL)`,
      [ASSO, VENDOR_WITH_KEY, VENDOR_WITHOUT_KEY]
    );

    const purchaseRecordService = new PurchaseRecordService(ds.getRepository(PurchaseRecord));
    const associationsService: any = {
      getPaymentAccountId: async () => VENDOR_WITH_KEY,
      getLydiaPayeeAccountId: async () => VENDOR_WITH_KEY,
      getActivePaymentProvider: async () => 'lydia',
    };
    forms = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(FormReminder),
      { get: () => 'https://canari.example' } as any,
      associationsService,
      { grantCotisant: jest.fn() } as any,
      purchaseRecordService,
      { build: async () => ({ answers: {} }) } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      { enabled: () => false } as any
    );
    // The boutique's return reads through Nest's HttpService: the same answer, unverified.
    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: ds.getRepository(ProductCheckout),
      purchaseRecordService,
      httpService: { post: () => of({ data: { ok: true, state: lydia.state, raw: lydia.raw } }) },
    }) as unknown as ProductsService;
    sweep = new LydiaReconciliationService(
      ds.getRepository(Submission),
      ds.getRepository(Form),
      ds.getRepository(ProductCheckout),
      forms,
      products,
      associationsService
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      if (!url.endsWith('payments/request-state')) throw new Error(`unexpected call to ${url}`);
      if (body.expectedAmountCents !== undefined) {
        verifiedReads += 1;
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
    // A Stripe-era id core would refuse: never sent.
    const stripe = await pendingAnswer(formId, 3, 40);
    await ds.query(`UPDATE submissions SET "stripeSessionId" = 'cs_test_x' WHERE id = $1`, [
      stripe,
    ]);

    await sweep.sweepFormPayments();
    const status = async (id: string) =>
      (await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]))[0]
        .paymentStatus;
    expect(verifiedReads).toBe(1);
    expect(await status(ended)).toBe('paid');
    expect(await status(live)).toBe('pending');
    expect(await status(stripe)).toBe('pending');

    // Idempotent from the row: the settled one left `pending`, so the next tick selects nothing.
    await sweep.sweepFormPayments();
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
    await sweep.sweepFormPayments();
    await forms.expireStalePendingPayments();
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
    expect(after.paymentStatus).toBe('expired');
    expect(
      await ds.query(`SELECT 1 FROM purchase_records WHERE "formId" = $1`, [formId])
    ).toHaveLength(0);
    // ASKED ONCE: the expiry took the row the read could not settle out of the selection.
    expect(verifiedReads).toBe(1);
    await sweep.sweepFormPayments();
    expect(verifiedReads).toBe(1);
  });

  it('releases an answer whose request Lydia says was declined, as the return does', async () => {
    lydia = { state: 'declined', raw: '5', verification: 'verified' };
    const formId = await paidForm();
    const id = await pendingAnswer(formId, 30, 31);
    await sweep.sweepFormPayments();
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [id]);
    expect(after.paymentStatus).toBe('cancelled');
  });

  describe('boutique attempts', () => {
    let buyers = 0;
    const attempt = (overrides: Partial<ProductCheckout> = {}) =>
      ds.getRepository(ProductCheckout).save(
        ds.getRepository(ProductCheckout).create({
          productId: PRODUCT,
          userId: `buyer-${++buyers}`.padEnd(64, '0'),
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
    });

    it('closes a verified expired attempt', async () => {
      lydia = { state: 'cancelled-or-expired', raw: '6', verification: 'verified' };
      const closed = await attempt();
      await sweep.reconcileCheckout(closed);
      expect(await statusOf(closed.id)).toBe('expired');
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
    });
  });
});
