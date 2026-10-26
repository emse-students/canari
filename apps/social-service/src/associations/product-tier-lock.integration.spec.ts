/**
 * THE BUYER'S TIER LOCK, AGAINST A REAL POSTGRESQL.
 *
 * A checkout opening and a settlement both rank a cotisation tier against the tiers the buyer
 * holds, then write: an attempt row, or a grant plus the sibling XOR. The unit spec runs on one
 * JavaScript thread, where nothing interleaves; only a database shows that the transaction-scoped
 * advisory lock (`ProductsService.lockBuyerTiers`) makes the second comer WAIT for the first one's
 * commit and then read it.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- product-tier-lock.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { ProductCheckout } from './entities/product-checkout.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a2';
const TIER_A = '00000000-0000-4000-8000-0000000000c1';
const TIER_B = '00000000-0000-4000-8000-0000000000c2';
const TAG_A = 'cotisant:cercle-it-a';
const TAG_B = 'cotisant:cercle-it-b';

maybe("a buyer's cotisation tiers are ranked and written under one lock (PostgreSQL)", () => {
  const schema = `tier_lock_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ProductsService;
  let tags: UserTagService;
  let buyerSeq = 0;
  const error = jest.spyOn(Logger.prototype, 'error');

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    uuidExtension: 'pgcrypto' as const,
    installExtensions: false,
    extra: { options: `-c search_path=${schema},public` },
  });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    error.mockImplementation(() => undefined);
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
    ds = new DataSource(options(false, [ProductCheckout, ...entities]));
    await ds.initialize();
    await ds.query(
      readFileSync(join(__dirname, '../migrations/101_product_checkouts.sql'), 'utf8')
    );

    await ds.getRepository(Association).save(
      ds.getRepository(Association).create({
        id: ASSO,
        name: 'Cercle IT',
        slug: 'cercle-it',
        createdBy: 'it',
        cotisationEnabled: true,
        cotisationMode: 'lifetime',
      } as Partial<Association>)
    );
    // Two tiers at the SAME price: whichever settles second is not a rise over the first, so a
    // correct serialisation grants exactly one of them, whatever the order.
    for (const [id, variantKey] of [
      [TIER_A, 'a'],
      [TIER_B, 'b'],
    ] as const) {
      await ds.getRepository(AssociationProduct).save(
        ds.getRepository(AssociationProduct).create({
          id,
          associationId: ASSO,
          name: `Tier ${variantKey}`,
          type: 'membership',
          variantKey,
          amountCents: 1500,
          currency: 'eur',
          isActive: true,
          grantedTagName: `cotisant:cercle-it-${variantKey}`,
        })
      );
    }

    tags = new UserTagService(ds.getRepository(UserTag));
    service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: ds.getRepository(ProductCheckout),
      productRepo: ds.getRepository(AssociationProduct),
      assoRepo: ds.getRepository(Association),
      purchaseRecordService: new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      userTagService: tags,
      config: { get: () => undefined },
      httpService: {
        post: () => of({ data: { ok: true, url: 'https://pay.test/1', id: 'f'.repeat(32) } }),
      },
      // Payments are routed and ready: what is under test is the rank, not the routing.
      resolvePaymentTargetFor: () =>
        Promise.resolve({
          ready: true,
          delegated: false,
          connectAccountId: 'vendor-test',
          targetAssociationId: ASSO,
          provider: 'lydia',
        }),
    }) as unknown as ProductsService;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => error.mockClear());

  /** A fresh buyer per test, so no test reads another's tags. */
  const newBuyer = () => `buyer-${++buyerSeq}`.padEnd(64, '0');

  const openAttempt = (userId: string, productId: string) =>
    ds.getRepository(ProductCheckout).save(
      ds.getRepository(ProductCheckout).create({
        productId,
        userId,
        associationId: ASSO,
        paymentAssociationId: ASSO,
        vendorToken: 'vendor-test',
        amountCents: 1500,
        currency: 'eur',
        productName: 'Tier',
        requestUuid: null,
        requestId: `${productId.slice(-2)}${userId.slice(6, 8)}`,
        status: 'open',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        settledAt: null,
        purchaseRecordId: null,
      })
    );

  const settle = (checkoutId: string) =>
    (service as any).settlePaidCheckout(checkoutId) as Promise<void>;

  const heldTags = async (userId: string) =>
    (
      (await ds.query(`SELECT "tagName" FROM user_tags WHERE "userId" = $1 ORDER BY 1`, [
        userId,
      ])) as { tagName: string }[]
    ).map((r) => r.tagName);

  const refundsLogged = () =>
    error.mock.calls.filter(([m]) => String(m).includes('a refund is owed')).length;

  /**
   * Takes the buyer's tier lock on the test's own connection, grants `tag` inside that transaction,
   * starts `work`, waits until PostgreSQL shows `work` BLOCKED on the advisory lock, then commits.
   * The wait is a read of `pg_locks`, never a clock: it proves `work` reached the lock before the
   * grant was visible, so whatever it then decides, it read AFTER the lock.
   */
  async function underHeldLock<T>(userId: string, tag: string, work: () => Promise<T>) {
    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `tier:${ASSO}:${userId}`,
    ]);
    await admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [userId, tag, ASSO]
    );
    const pending = work().then(
      (value) => ({ value, error: null as unknown }),
      (e: unknown) => ({ value: null as T | null, error: e })
    );
    let waiting = 0;
    for (let i = 0; i < 10_000 && waiting === 0; i++) {
      const [row] = (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
        )
      ).rows as { n: number }[];
      waiting = row.n;
    }
    expect(waiting).toBe(1);
    await admin.query('COMMIT');
    return pending;
  }

  it('two CONCURRENT settlements of sibling tiers grant exactly ONE, and record both payments', async () => {
    const buyer = newBuyer();
    const a = await openAttempt(buyer, TIER_A);
    const b = await openAttempt(buyer, TIER_B);
    const grant = jest.spyOn(tags, 'grantOrRenew');

    await Promise.all([settle(a.id), settle(b.id)]);

    expect(grant.mock.calls.filter(([d]) => d.userId === buyer)).toHaveLength(1);
    grant.mockRestore();
    const held = await heldTags(buyer);
    expect(held).toHaveLength(1);
    expect([TAG_A, TAG_B]).toContain(held[0]);
    const records = await ds.query(`SELECT "productId" FROM purchase_records WHERE "userId" = $1`, [
      buyer,
    ]);
    expect(records).toHaveLength(2);
    expect(refundsLogged()).toBe(1);
  });

  it('a settlement waits for the lock, then re-reads: a tier granted meanwhile makes it not a rise', async () => {
    const buyer = newBuyer();
    const a = await openAttempt(buyer, TIER_A);

    const { error: failed } = await underHeldLock(buyer, TAG_B, () => settle(a.id));

    expect(failed).toBeNull();
    expect(await heldTags(buyer)).toEqual([TAG_B]);
    const [row] = await ds.query(`SELECT status FROM product_checkouts WHERE id = $1`, [a.id]);
    expect(row.status).toBe('paid');
    expect(refundsLogged()).toBe(1);
  });

  it('a checkout opening waits for the lock, then re-reads: it refuses a tier that is no longer a rise', async () => {
    const buyer = newBuyer();

    const { error: refused } = await underHeldLock(buyer, TAG_B, () =>
      service.createCheckoutSession(ASSO, TIER_A, buyer)
    );

    expect(refused).toBeInstanceOf(ConflictException);
    expect(((refused as ConflictException).getResponse() as { code: string }).code).toBe(
      'TIER_NOT_A_RISE'
    );
    const rows = await ds.query(`SELECT id FROM product_checkouts WHERE "userId" = $1`, [buyer]);
    expect(rows).toHaveLength(0);
  });
});
