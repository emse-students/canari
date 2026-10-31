/**
 * LYDIA READINESS AGAINST A REAL POSTGRESQL (lot 2, migration 118).
 *
 * What a mocked manager cannot prove: that the `UPDATE ... RETURNING` decides the transition (N
 * replayed `BUSINESS_VALIDATED` give ONE notice), that a revert withholds exactly the on-sale
 * products of the holder and its approved delegates and the release puts back exactly those, that a
 * revert committed while a purchase is being prepared refuses it under the lock with the typed code
 * and issues NO request/do, and that migration 118 runs twice.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-readiness.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
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
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const HOLDER = '00000000-0000-4000-8000-0000000001a1';
const CLUB = '00000000-0000-4000-8000-0000000001a2';
const PENDING_CLUB = '00000000-0000-4000-8000-0000000001a3';
const VENDOR = 'vendor-token-of-the-holder';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('Lydia readiness: one writer, the UPDATE decides (PostgreSQL)', () => {
  const schema = `lydia_ready_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let products: ProductsService;
  const tell = jest.fn(async () => 1);
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
    await admin.query('RESET lock_timeout');
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, "firstName" text, "lastName" text)`
    );

    const assoRepo = ds.getRepository(Association);
    for (const [id, extra] of [
      [HOLDER, { lydiaAccountId: VENDOR }],
      [CLUB, { paymentParentAssociationId: HOLDER, paymentDelegationStatus: 'approved' }],
      [PENDING_CLUB, { paymentParentAssociationId: HOLDER, paymentDelegationStatus: 'pending' }],
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
          AND column_name IN ('lydiaReadinessCause', 'lydiaReadinessAt', 'lydiaEnrolmentStartedAt')`,
      [schema]
    );
    expect(cols.n).toBe(3);
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

    // A second refusal of the same Business is a replay: nothing more, no second notice.
    await associations.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', {
      path: 'form',
    });
    expect(tell).toHaveBeenCalledTimes(1);

    await products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' });
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
});
