/**
 * LYDIA READINESS AGAINST A REAL POSTGRESQL (lot 2, migration 118).
 *
 * What a mocked manager cannot prove: that the `UPDATE ... RETURNING` decides the transition (N
 * replayed `BUSINESS_VALIDATED` give ONE notice), that a revert withholds exactly the on-sale
 * products of the holder and its approved delegates and the release puts back exactly those, that a
 * revert committed while a purchase is being prepared refuses it under the lock with the typed code
 * and issues NO request/do, and that migration 118 runs twice. And what only CONCURRENCY proves
 * (`Promise.all` on separate connections): N simultaneous VALIDATED give one transition and one
 * notice, two enrolment claims give one winner and one typed 409, a VALIDATED racing a revert never
 * leaves a withheld product on sale while its holder is not ready, and two simultaneous Responsable
 * steps give one row, one typed conflict and ONE `business/addcashier`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-readiness.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ProductCheckout } from './entities/product-checkout.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordClosing } from '../users/entities/purchase-record-closing.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { SECRET_BOX_ENV } from '../common/secret-box';
import { AssociationsService, LYDIA_RESPONSABLE_IN_FLIGHT } from './associations.service';
import { LYDIA_ENROLMENT_IN_FLIGHT } from './lydia-readiness';
import { LYDIA_CASHIER_CLAIM_LOST } from './lydia-cashier-claim';
import { LYDIA_PAYMENTS_PAUSED_TYPE } from './lydia-payments-notifier.service';
import { ProductsService } from './products.service';

/**
 * Whether the buyer may SEE the association (`preparePurchase`) is the campus predicate, proven
 * against PostgreSQL in `shop-partnership-visibility.integration.spec.ts`; it is not what this file
 * is about, so every buyer sees the association.
 */
jest.mock('../spaces/viewer-visibility', () => ({
  associationVisibleTo: () => Promise.resolve(true),
}));

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const HOLDER = '00000000-0000-4000-8000-0000000001a1';
const CLUB = '00000000-0000-4000-8000-0000000001a2';
const PENDING_CLUB = '00000000-0000-4000-8000-0000000001a3';
const ENROLLING = '00000000-0000-4000-8000-0000000001a4';
const PHONE = '+33612345678';
const VENDOR = 'vendor-token-of-the-holder';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('Lydia readiness: one writer, the UPDATE decides (PostgreSQL)', () => {
  const schema = `lydia_ready_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let products: ProductsService;
  const tell = jest.fn(async () => 1);
  let savedSecret: string | undefined;
  const requests: unknown[] = [];

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    uuidExtension: 'pgcrypto' as const,
    installExtensions: false,
    extra: { options: `-c search_path=${schema},public`, application_name: schema },
  });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    const entities = [
      PurchaseRecord,
      AssociationProduct,
      UserTag,
      Association,
      AssociationAudience,
      Space,
      PostNotification,
    ];
    const others = new DataSource(options(true, entities));
    await others.initialize();
    await others.destroy();
    ds = new DataSource(options(false, [ProductCheckout, PurchaseRecordClosing, ...entities]));
    await ds.initialize();
    await ds.query(migration('101_product_checkouts.sql'));
    await admin.query(migration('112_product_checkouts_held_tier.sql'));
    await admin.query(migration('113_purchase_record_closings.sql'));
    // TWICE: CD may replay it, and every statement is IF NOT EXISTS.
    await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
    await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
    await admin.query(migration('119_lydia_cashiers_lot3.sql'));
    await admin.query('RESET lock_timeout');
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, "firstName" text, "lastName" text,
         "displayName" text, admin boolean NOT NULL DEFAULT false)`
    );
    await admin.query(
      `INSERT INTO users (id, "firstName", admin) VALUES ('global-admin', 'Admin', true),
         ('member-1', 'Ada', false), ('member-2', 'Bob', false)`
    );
    savedSecret = process.env[SECRET_BOX_ENV];
    process.env[SECRET_BOX_ENV] = 'throwaway-encryption-secret-0123456789abcdef';

    const assoRepo = ds.getRepository(Association);
    for (const [id, extra] of [
      [HOLDER, { lydiaAccountId: VENDOR }],
      [CLUB, { paymentParentAssociationId: HOLDER, paymentDelegationStatus: 'approved' }],
      [PENDING_CLUB, { paymentParentAssociationId: HOLDER, paymentDelegationStatus: 'pending' }],
      [ENROLLING, {}],
    ] as const) {
      await assoRepo.save(
        assoRepo.create({
          id,
          name: `Asso ${id.slice(-2)}`,
          slug: `asso-${id.slice(-2)}`,
          createdBy: 'it',
          ...extra,
        } as Partial<Association>)
      );
    }

    associations = Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
      redis: { deleteByPattern: async () => 0 },
      lydiaNotifier: { enabled: () => true, tell },
      listFlagHolders: async () => ['manager-1'],
      isMember: async () => true,
    }) as unknown as AssociationsService;
    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: ds.getRepository(ProductCheckout),
      productRepo: ds.getRepository(AssociationProduct),
      assoRepo,
      associationsService: associations,
      purchaseRecordService: new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      userTagService: new UserTagService(ds.getRepository(UserTag)),
      config: { get: () => undefined },
      httpService: {
        post: (...args: unknown[]) => {
          requests.push(args);
          throw new Error('no request/do may be issued in this file');
        },
      },
      pricingFacts: { profileFor: () => Promise.resolve({ promo: null, formation: null }) },
      activePaymentProvider: () => Promise.resolve('lydia'),
    }) as unknown as ProductsService;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (savedSecret === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = savedSecret;
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const product = (associationId: string, name: string, over: Partial<AssociationProduct> = {}) =>
    ds.getRepository(AssociationProduct).save(
      ds.getRepository(AssociationProduct).create({
        associationId,
        name,
        type: 'item',
        amountCents: 1500,
        currency: 'eur',
        isActive: true,
        ...over,
      } as Partial<AssociationProduct>)
    );
  const stateOf = async (id: string) =>
    (
      await ds.query(
        `SELECT "lydiaOnboardingComplete" AS ready, "lydiaReadinessCause" AS cause FROM associations WHERE id = $1`,
        [id]
      )
    )[0] as { ready: boolean; cause: string | null };
  const flags = async (id: string) =>
    (
      await ds.query(
        `SELECT "isActive", "activationWithheld" FROM association_products WHERE id = $1`,
        [id]
      )
    )[0] as { isActive: boolean; activationWithheld: boolean };

  it('migration 118 ran twice and made what it says', async () => {
    const [cols] = await ds.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'associations'
          AND column_name IN ('lydiaReadinessCause', 'lydiaReadinessAt', 'lydiaEnrolmentStartedAt',
                              'lydiaResponsableStartedAt', 'lydiaEnrolmentVendorToken')`,
      [schema]
    );
    expect(cols.n).toBe(5);
    await ds.query(
      `INSERT INTO lydia_cashiers ("associationId", "vendorToken", "userId", "phoneEnd", "addedByUserId")
       VALUES ($1, $2, 'u1', '78', 'u0')`,
      [HOLDER, VENDOR]
    );
    // One live Responsable per association, enforced by the index, not by the code alone.
    await expect(
      ds.query(
        `INSERT INTO lydia_cashiers ("associationId", "vendorToken", "userId", "phoneEnd", "addedByUserId")
         VALUES ($1, $2, 'u2', '11', 'u0')`,
        [HOLDER, VENDOR]
      )
    ).rejects.toThrow(/lydia_cashiers_one_responsable/);
    await ds.query(`DELETE FROM lydia_cashiers`);
  });

  it('N replayed VALIDATED: ONE transition, ONE notice, a release on every call', async () => {
    const withheld = await product(HOLDER, 'withheld', {
      isActive: false,
      activationWithheld: true,
    });
    tell.mockClear();
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(
        (await products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' })).kind
      );
    }
    expect(outcomes).toEqual(['transitioned', 'replay', 'replay', 'replay', 'replay']);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(await stateOf(HOLDER)).toEqual({ ready: true, cause: 'webhook-validated' });
    expect(await flags(withheld.id)).toEqual({ isActive: true, activationWithheld: false });
  });

  it('a revert withholds the on-sale products of the holder and its APPROVED delegates only; the release puts back exactly those', async () => {
    await products.markLydiaReady(VENDOR, 'admin', { path: 'admin' });
    const own = await product(HOLDER, 'own');
    const delegate = await product(CLUB, 'delegate');
    const pending = await product(PENDING_CLUB, 'pending-club');
    const offSale = await product(HOLDER, 'taken off sale', { isActive: false });
    tell.mockClear();

    await associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', {
      path: 'shop',
      id: 'checkout-it',
    });
    expect(await stateOf(HOLDER)).toEqual({ ready: false, cause: 'request-refused' });
    expect(await flags(own.id)).toEqual({ isActive: false, activationWithheld: true });
    expect(await flags(delegate.id)).toEqual({ isActive: false, activationWithheld: true });
    expect(await flags(pending.id)).toEqual({ isActive: true, activationWithheld: false });
    expect(await flags(offSale.id)).toEqual({ isActive: false, activationWithheld: false });
    expect(tell).toHaveBeenCalledWith(expect.anything(), 'paused', ['manager-1']);
    // The report a person sees: one bell row per global admin, committed with the revert.
    expect(
      await ds.query(
        `SELECT "recipientId", type, "postId" FROM post_notifications WHERE type = $1`,
        [LYDIA_PAYMENTS_PAUSED_TYPE]
      )
    ).toEqual([{ recipientId: 'global-admin', type: LYDIA_PAYMENTS_PAUSED_TYPE, postId: HOLDER }]);

    // A second refusal of the same Business is a replay: nothing more, no second notice.
    await associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', {
      path: 'form',
    });
    expect(tell).toHaveBeenCalledTimes(1);

    // An unsigned VALIDATED does not clear Lydia's own refusal: nothing released.
    await expect(
      products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' })
    ).resolves.toMatchObject({ kind: 'held-by-lydia' });
    expect(await stateOf(HOLDER)).toEqual({ ready: false, cause: 'request-refused' });
    expect(await flags(own.id)).toEqual({ isActive: false, activationWithheld: true });

    await products.markLydiaReady(VENDOR, 'admin', { path: 'admin' });
    expect(await flags(own.id)).toEqual({ isActive: true, activationWithheld: false });
    expect(await flags(delegate.id)).toEqual({ isActive: true, activationWithheld: false });
    expect(await flags(offSale.id)).toEqual({ isActive: false, activationWithheld: false });
  });

  it('a revert committed while the purchase is prepared: the typed 409 under the lock, and NO request/do', async () => {
    await products.markLydiaReady(VENDOR, 'admin', { path: 'admin' });
    const item = await product(HOLDER, 'raced');
    const prepare = (products as any).preparePurchase.bind(products);
    const spy = jest
      .spyOn(products as any, 'preparePurchase')
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prepared = await prepare(...args);
        // Lydia's error 2701 on ANOTHER payer's request commits here, between the two reads.
        await associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-blocked', {
          path: 'shop',
          id: 'another-payer',
        });
        return prepared;
      });
    const refusal = await products
      .createCheckoutSession(HOLDER, item.id, 'buyer-it')
      .catch((e: unknown) => e);
    spy.mockRestore();
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      code: 'PAYMENTS_BLOCKED',
    });
    expect(requests).toHaveLength(0);
    expect(
      await ds.query(`SELECT id FROM product_checkouts WHERE "productId" = $1`, [item.id])
    ).toEqual([]);
  });

  describe('under concurrency (Promise.all, one connection each)', () => {
    const reset = async (ready: boolean, cause: string | null) => {
      await ds.query(
        `UPDATE associations SET "lydiaOnboardingComplete" = $2, "lydiaReadinessCause" = $3,
                "lydiaReadinessAt" = NULL, "lydiaEnrolmentStartedAt" = NULL,
                "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL,
                "lydiaEnrolmentVendorToken" = NULL
          WHERE id = $1`,
        [HOLDER, ready, cause]
      );
      await ds.query(`DELETE FROM association_products`);
      await ds.query(`DELETE FROM post_notifications`);
      await ds.query(`DELETE FROM lydia_cashiers`);
    };

    it('N simultaneous VALIDATED: ONE transition and ONE notice', async () => {
      await reset(false, null);
      tell.mockClear();
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' })
        )
      );
      expect(outcomes.filter((o) => o.kind === 'transitioned')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'replay')).toHaveLength(7);
      expect(tell).toHaveBeenCalledTimes(1);
      expect(await stateOf(HOLDER)).toEqual({ ready: true, cause: 'webhook-validated' });
    });

    it('two simultaneous enrolment claims: one wins, the other is the typed 409', async () => {
      await ds.query(
        `UPDATE associations SET "lydiaEnrolmentStartedAt" = NULL, "lydiaAccountId" = NULL WHERE id = $1`,
        [ENROLLING]
      );
      const settled = await Promise.allSettled([
        associations.claimLydiaEnrolment(ENROLLING),
        associations.claimLydiaEnrolment(ENROLLING),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(lost.reason).toBeInstanceOf(ConflictException);
      expect((lost.reason as ConflictException).getResponse()).toMatchObject({
        code: LYDIA_ENROLMENT_IN_FLIGHT,
      });
    });

    it('a VALIDATED racing a revert: consistent, and nothing withheld goes back on sale while not ready', async () => {
      for (let round = 0; round < 10; round++) {
        await reset(false, null);
        const withheld = await product(HOLDER, `withheld-${round}`, {
          isActive: false,
          activationWithheld: true,
        });
        const onSale = await product(CLUB, `delegate-withheld-${round}`, {
          isActive: false,
          activationWithheld: true,
        });
        await Promise.all([
          products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' }),
          associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', {
            path: 'shop',
            id: `race-${round}`,
          }),
        ]);
        // Either order ends NOT ready (an unsigned VALIDATED never undoes a refusal), and nothing
        // that was withheld is on sale: a release that ran after the revert released nothing.
        expect(await stateOf(HOLDER)).toEqual({ ready: false, cause: 'request-refused' });
        expect((await flags(withheld.id)).isActive).toBe(false);
        expect((await flags(onSale.id)).isActive).toBe(false);
      }
    });

    it('a release that runs AFTER a revert undid the ready re-reads under its lock and releases nothing', async () => {
      await reset(true, 'webhook-validated');
      const item = await product(HOLDER, 'late-release', {
        isActive: false,
        activationWithheld: true,
      });
      // The VALIDATED committed ready; Lydia's error 5 reverts before its release runs.
      await associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', {
        path: 'shop',
      });
      await expect(products.releaseWithheldForAssociationAndDelegates(HOLDER)).resolves.toBe(0);
      expect(await flags(item.id)).toEqual({ isActive: false, activationWithheld: true });
    });

    it('two simultaneous Responsable steps: ONE row, ONE typed conflict, ONE addcashier', async () => {
      await reset(true, 'admin');
      let addcashier = 0;
      // What core-service does: claim, then (only when claimed) business/addcashier, then record.
      const step = async (userId: string) => {
        const pre = await associations.claimLydiaResponsable(HOLDER, userId, PHONE);
        if (!pre.claimed) throw new Error('not claimed');
        addcashier += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return associations.recordLydiaResponsable(HOLDER, {
          vendorToken: VENDOR,
          userId,
          phone: PHONE,
          addedByUserId: 'treasurer',
          confirmed: true,
          claimToken: pre.claimToken,
        });
      };
      const settled = await Promise.allSettled([step('member-1'), step('member-2')]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(lost.reason).toBeInstanceOf(HttpException);
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_RESPONSABLE_IN_FLIGHT,
      });
      expect(addcashier).toBe(1);
      expect(
        await ds.query(`SELECT count(*)::int AS n FROM lydia_cashiers WHERE "removedAt" IS NULL`)
      ).toEqual([{ n: 1 }]);
    });

    it('an UNCONFIRMED Responsable locks its number and the one-Responsable rule; the same number confirms it', async () => {
      await reset(true, 'admin');
      // What core-service does: the claim, then the record carrying its token.
      const record = async (userId: string, phone: string, confirmed: boolean) => {
        const pre = await associations.claimLydiaResponsable(HOLDER, userId, phone);
        expect(pre.claimed).toBe(true);
        const recorded = await associations.recordLydiaResponsable(HOLDER, {
          vendorToken: VENDOR,
          userId,
          phone,
          addedByUserId: 'treasurer',
          confirmed,
          claimToken: pre.claimToken,
        });
        return recorded.view;
      };
      await expect(record('member-1', PHONE, false)).resolves.toMatchObject({ confirmed: false });
      expect(
        await ds.query(
          `SELECT "confirmedAt" IS NULL AS unconfirmed, "lydiaResponsableStartedAt" IS NULL AS released
             FROM lydia_cashiers c JOIN associations a ON a.id = c."associationId"
            WHERE c."removedAt" IS NULL`
        )
      ).toEqual([{ unconfirmed: true, released: true }]);
      // The claim reads the unconfirmed row like a confirmed one: another number, another person.
      await expect(
        associations.claimLydiaResponsable(HOLDER, 'member-1', '+33600000099')
      ).resolves.toMatchObject({ phoneMatches: false, claimed: false });
      await expect(
        associations.claimLydiaResponsable(HOLDER, 'member-2', PHONE)
      ).resolves.toMatchObject({ currentUserId: 'member-1', claimed: false });
      // The same number is claimed, re-added, and the record confirms the SAME row.
      await expect(record('member-1', PHONE, true)).resolves.toMatchObject({ confirmed: true });
      expect(
        await ds.query(
          `SELECT count(*)::int AS n, bool_and("confirmedAt" IS NOT NULL) AS confirmed
             FROM lydia_cashiers WHERE "removedAt" IS NULL`
        )
      ).toEqual([{ n: 1, confirmed: true }]);
    });

    it('a VALIDATED is retried (503) ONLY for the pending token of an unlinked enrolment', async () => {
      await ds.query(
        `UPDATE associations SET "lydiaEnrolmentStartedAt" = NULL, "lydiaAccountId" = NULL,
                "lydiaEnrolmentVendorToken" = NULL WHERE id = $1`,
        [ENROLLING]
      );
      const validated = (token: string) =>
        associations.setLydiaReadiness(token, true, 'webhook-validated', { path: 'webhook' });
      // No enrolment: nothing is pending, the token is recorded nowhere.
      await expect(
        associations.recordLydiaEnrolmentVendorToken(ENROLLING, 'pending-token')
      ).resolves.toBe(false);
      await associations.claimLydiaEnrolment(ENROLLING);
      await expect(
        associations.recordLydiaEnrolmentVendorToken(ENROLLING, 'pending-token')
      ).resolves.toBe(true);
      await expect(validated('pending-token')).resolves.toEqual({
        kind: 'no-holder-enrolment-in-flight',
      });
      // Any other unknown token is a 200 while that enrolment is in flight.
      await expect(validated('a-stranger-token')).resolves.toEqual({ kind: 'no-holder' });
      // A typed refusal clears the marker AND the pending token.
      await associations.releaseLydiaEnrolment(ENROLLING, 'refused');
      await expect(validated('pending-token')).resolves.toEqual({ kind: 'no-holder' });
      expect(
        await ds.query(`SELECT "lydiaEnrolmentVendorToken" AS t FROM associations WHERE id = $1`, [
          ENROLLING,
        ])
      ).toEqual([{ t: null }]);
    });

    it('two simultaneous records of two people under one claim: ONE row, the other the typed CLAIM_LOST', async () => {
      await reset(true, 'admin');
      const { claimToken } = await associations.claimLydiaResponsable(HOLDER, 'member-1', PHONE);
      const record = (userId: string) =>
        associations.recordLydiaResponsable(HOLDER, {
          vendorToken: VENDOR,
          userId,
          phone: PHONE,
          addedByUserId: 'treasurer',
          confirmed: true,
          claimToken,
        });
      const settled = await Promise.allSettled([record('member-1'), record('member-2')]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_CASHIER_CLAIM_LOST,
      });
      expect(
        await ds.query(`SELECT count(*)::int AS n FROM lydia_cashiers WHERE "removedAt" IS NULL`)
      ).toEqual([{ n: 1 }]);
    });
  });
});
