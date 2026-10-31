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
 *
 * It also holds the two halves decided on 2026-10-27 (migrations 112 and 113): the settlement grants
 * on the tier the OPENING froze, whatever price an admin edits in between, and a payment marked
 * `paid_not_granted` is closed ONCE by a manager, which is what takes it out of the hourly count.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { of } from 'rxjs';
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
import { buyerTierLockKey } from '../users/buyer-tier-lock';
import { ProductsService } from './products.service';

/**
 * Whether the buyer may SEE the association (`preparePurchase`) is the campus predicate, proven
 * against PostgreSQL in `shop-partnership-visibility.integration.spec.ts`. Here, as for the routing
 * stubbed below, what is under test is the rank: every buyer sees the association.
 */
jest.mock('../spaces/viewer-visibility', () => ({
  associationVisibleTo: () => Promise.resolve(true),
}));
import {
  ERASURE_ROW_STATEMENTS,
  ERASURE_TIER_ORDER,
  erasureParams,
} from '../internal/account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a2';
const TIER_A = '00000000-0000-4000-8000-0000000000c1';
const TIER_B = '00000000-0000-4000-8000-0000000000c2';
/** Retagged by its own test ('c' -> 'c2'), so no other test depends on its key. */
const TIER_C = '00000000-0000-4000-8000-0000000000c3';
/** Repriced by its own test, so no other test depends on its price. */
const TIER_D = '00000000-0000-4000-8000-0000000000c4';
const TAG_A = 'cotisant:cercle-it-a';
const TAG_B = 'cotisant:cercle-it-b';
const TAG_D = 'cotisant:cercle-it-d';
const MIGRATION_HELD_TIER = '112_product_checkouts_held_tier.sql';
const MIGRATION_CLOSINGS = '113_purchase_record_closings.sql';

const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe("a buyer's cotisation tiers are ranked and written under one lock (PostgreSQL)", () => {
  const schema = `tier_lock_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ProductsService;
  let tags: UserTagService;
  let buyerSeq = 0;
  const error = jest.spyOn(Logger.prototype, 'error');

  const options = (
    synchronize: boolean,
    entities: Function[],
    pool: Record<string, unknown> = {}
  ) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    uuidExtension: 'pgcrypto' as const,
    installExtensions: false,
    // Named after the schema, so `waitersReach` counts only THIS run's sessions.
    extra: { options: `-c search_path=${schema},public`, application_name: schema, ...pool },
  });
  const ENTITIES = (): Function[] => [
    ProductCheckout,
    PurchaseRecordClosing,
    PurchaseRecord,
    AssociationProduct,
    UserTag,
    Association,
    AssociationAudience,
    Space,
  ];

  /** The service under test on `source`, with its other services stubbed out. */
  function makeServices(source: DataSource) {
    const tagService = new UserTagService(source.getRepository(UserTag));
    const products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: source.getRepository(ProductCheckout),
      productRepo: source.getRepository(AssociationProduct),
      assoRepo: source.getRepository(Association),
      purchaseRecordService: new PurchaseRecordService(source.getRepository(PurchaseRecord)),
      userTagService: tagService,
      config: { get: () => undefined },
      httpService: {
        post: () => of({ data: { ok: true, url: 'https://pay.test/1', id: 'f'.repeat(32) } }),
      },
      // Payments are routed and ready: what is under test is the rank, not the routing.
      pricingFacts: { profileFor: () => Promise.resolve({ promo: null, formation: null }) },
      activePaymentProvider: () => Promise.resolve('lydia'),
      routeWith: () =>
        Promise.resolve({
          ready: true,
          delegated: false,
          connectAccountId: 'vendor-test',
          targetAssociationId: ASSO,
          provider: 'lydia',
        }),
    }) as unknown as ProductsService;
    return { products, tagService };
  }

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
    ds = new DataSource(options(false, [ProductCheckout, PurchaseRecordClosing, ...entities]));
    await ds.initialize();
    await ds.query(
      readFileSync(join(__dirname, '../migrations/101_product_checkouts.sql'), 'utf8')
    );
    // On the admin connection: their `SET lock_timeout` must not stay on a pool connection that
    // later waits on an advisory lock.
    await admin.query(migration(MIGRATION_HELD_TIER));
    await admin.query(migration(MIGRATION_CLOSINGS));
    await admin.query('RESET lock_timeout');
    // The buyers' display names a purchases row is answered with (`enrichPurchaseRecords`).
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, "firstName" text, "lastName" text)`
    );
    // The columns a closing reads of a form answer a held tag names (`isOwnFormAnswer`).
    await admin.query(
      `CREATE TABLE submissions (id uuid PRIMARY KEY, "formId" uuid NOT NULL, "userId" varchar(255),
         "paymentStatus" varchar NOT NULL DEFAULT 'paid', "totalPaid" int NOT NULL DEFAULT 1500)`
    );
    // The columns a closing reads of a paid form (`grantClosedTier`).
    await admin.query(
      `CREATE TABLE forms (id uuid PRIMARY KEY, "associationId" uuid, "grantsCotisation" boolean NOT NULL,
         "cotisationVariantKey" varchar(64))`
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
    for (const [id, variantKey, amountCents] of [
      [TIER_A, 'a', 1500],
      [TIER_B, 'b', 1500],
      [TIER_C, 'c', 2000],
      [TIER_D, 'd', 2000],
    ] as const) {
      await ds.getRepository(AssociationProduct).save(
        ds.getRepository(AssociationProduct).create({
          id,
          associationId: ASSO,
          name: `Tier ${variantKey}`,
          type: 'membership',
          variantKey,
          amountCents,
          currency: 'eur',
          isActive: true,
          grantedTagName: `cotisant:cercle-it-${variantKey}`,
        })
      );
    }

    ({ products: service, tagService: tags } = makeServices(ds));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => error.mockClear());

  /**
   * A fresh buyer per test, so no test reads another's tags. The sequence is zero-padded BEFORE the
   * id is padded, or `buyer-1` and `buyer-10` would pad to the same id.
   */
  const newBuyer = () => `buyer-${String(++buyerSeq).padStart(4, '0')}`.padEnd(64, '0');

  /** An attempt written directly, as opened over NO held tier (`heldTierProductId` null). */
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
        heldTierProductId: null,
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

  /** Gives `userId` a tier tag directly, as a held tier the next opening ranks against. */
  const grantRawTag = (userId: string, tag: string) =>
    ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [userId, tag, ASSO]
    );

  /** The typed `code` of a refusal, or null. */
  const codeOf = (e: unknown): string | null =>
    e instanceof ConflictException ? (e.getResponse() as { code: string }).code : null;

  /**
   * A payment of `productId` recorded `paid_not_granted`, as production makes one: opened over tier A
   * (frozen), then a manager grants tier B before the payment lands, so the buyer no longer holds the
   * tier the opening ranked against. The buyer ends holding B. Answers the purchase record id.
   */
  async function markedRecord(userId: string, productId: string): Promise<string> {
    await grantRawTag(userId, TAG_A);
    const { checkoutId } = await service.createCheckoutSession(ASSO, productId, userId);
    await tags.grantCotisant(ASSO, userId, 'manager', 'b');
    await settle(checkoutId);
    const [record] = await ds.query(
      `SELECT id, status FROM purchase_records WHERE "userId" = $1 AND "productId" = $2`,
      [userId, productId]
    );
    expect(record.status).toBe('paid_not_granted');
    return record.id as string;
  }

  /**
   * Takes the buyer's tier lock on the test's own connection, grants `tag` inside that transaction,
   * starts `work`, waits until PostgreSQL shows `work` BLOCKED on the advisory lock, then commits.
   * The wait is a read of `pg_locks`, never a clock: it proves `work` reached the lock before the
   * grant was visible, so whatever it then decides, it read AFTER the lock.
   */
  async function underHeldLock<T>(userId: string, tag: string, work: () => Promise<T>) {
    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      buyerTierLockKey(ASSO, userId),
    ]);
    await admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [userId, tag, ASSO]
    );
    const pending = work().then(
      (value) => ({ value, error: null as unknown }),
      (e: unknown) => ({ value: null as T | null, error: e })
    );
    expect(await waitersReach(1, buyerTierLockKey(ASSO, userId))).toBe(1);
    await admin.query('COMMIT');
    return pending;
  }

  /**
   * Reads `pg_locks` until `n` of THIS run's sessions (the pools' `application_name`, never the test's
   * own connection) wait on the advisory lock `key` (`null`: on any lock, a row lock included), or a
   * bounded number of reads has gone by; answers the last count. Scoped so a concurrent run on the
   * same cluster cannot be counted. A read loop, never a clock.
   */
  async function waitersReach(n: number, key: string | null): Promise<number> {
    let waiting = 0;
    for (let i = 0; i < 10_000 && waiting < n; i++) {
      // `pg_stat_activity` is snapshotted once per transaction, and `admin` reads it inside the
      // transaction holding the lock: without a fresh snapshot a pool session opened since is unseen.
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const [row] = (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_locks l
            WHERE NOT l.granted AND l.pid <> pg_backend_pid()
              AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = $1)` +
            (key === null
              ? ''
              : ` AND l.locktype = 'advisory' AND l.objsubid = 1
                  AND (l.classid::int8 << 32 | l.objid::int8) = hashtextextended($2, 0)`),
          key === null ? [schema] : [schema, key]
        )
      ).rows as { n: number }[];
      waiting = row.n;
    }
    return waiting;
  }

  /** Settles a promise into a value or an error, so a test can await it after a commit. */
  const settled = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ value, error: null as unknown }),
      (e: unknown) => ({ value: null as T | null, error: e })
    );

  it('a manual grant and a settlement for one buyer queue on the same lock, and end on ONE tier', async () => {
    const buyer = newBuyer();
    const a = await openAttempt(buyer, TIER_A);

    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      buyerTierLockKey(ASSO, buyer),
    ]);
    // The manager's grant of tier B waits for the lock ...
    const manual = settled(tags.grantCotisant(ASSO, buyer, 'manager', 'b'));
    expect(await waitersReach(1, buyerTierLockKey(ASSO, buyer))).toBe(1);
    // ... and so does the payment of tier A.
    const paid = settled(settle(a.id));
    expect(await waitersReach(2, buyerTierLockKey(ASSO, buyer))).toBe(2);
    await admin.query('COMMIT');
    const [m, p] = await Promise.all([manual, paid]);

    expect(m.error).toBeNull();
    expect(p.error).toBeNull();
    // In either order the outcome is the manager's tier: granted first, it makes A a non-rise; granted
    // second, it swaps A out by the XOR, as a manual grant is meant to.
    expect(await heldTags(buyer)).toEqual([TAG_B]);
    const [row] = await ds.query(`SELECT status FROM product_checkouts WHERE id = $1`, [a.id]);
    expect(row.status).toBe('paid');
  });

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

  it('two tabs opening two SIBLING tiers at once: one attempt opens, the other is refused', async () => {
    const buyer = newBuyer();

    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      buyerTierLockKey(ASSO, buyer),
    ]);
    // Both pass the sibling settle and the preparation before the lock - nothing is open yet.
    const first = settled(service.createCheckoutSession(ASSO, TIER_A, buyer));
    expect(await waitersReach(1, buyerTierLockKey(ASSO, buyer))).toBe(1);
    const second = settled(service.createCheckoutSession(ASSO, TIER_B, buyer));
    expect(await waitersReach(2, buyerTierLockKey(ASSO, buyer))).toBe(2);
    await admin.query('COMMIT');
    const outcomes = await Promise.all([first, second]);

    const refused = outcomes.filter((o) => o.error !== null);
    expect(refused).toHaveLength(1);
    expect(((refused[0].error as ConflictException).getResponse() as { code: string }).code).toBe(
      'CHECKOUT_IN_PROGRESS'
    );
    const open = await ds.query(
      `SELECT "productId" FROM product_checkouts WHERE "userId" = $1 AND status = 'open'`,
      [buyer]
    );
    expect(open).toHaveLength(1);
  });

  it('every locked path runs on ONE pool connection: a pool of one does not wait for a second', async () => {
    // A read on another pool connection while the tier lock's transaction holds the only one could
    // never be served: with a connection timeout it fails, without one it hangs for good.
    const single = new DataSource(
      options(false, ENTITIES(), { max: 1, connectionTimeoutMillis: 5_000 })
    );
    await single.initialize();
    try {
      const { products, tagService } = makeServices(single);
      const buyer = newBuyer();
      const { checkoutId } = await products.createCheckoutSession(ASSO, TIER_A, buyer);
      await (products as any).settlePaidCheckout(checkoutId);
      expect(await heldTags(buyer)).toEqual([TAG_A]);
      // A form's ranked grant (the same tier: refused, never a renewal paid twice), then a manual
      // one, then a revocation.
      expect(await tagService.grantCotisantIfARise(ASSO, buyer, 'form', 'a', {})).toEqual({
        refused: 'held',
      });
      const granted = await tagService.grantCotisant(ASSO, buyer, 'manager', 'b');
      await tagService.revoke(granted.id, ASSO);
      expect(await heldTags(buyer)).toEqual([]);
    } finally {
      await single.destroy();
    }
  });

  it('a retag and a settlement of the same tier never leave the OLD tag behind', async () => {
    const holder = newBuyer();
    const buyer = newBuyer();
    const oldTag = 'cotisant:cercle-it-c';
    await ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [holder, oldTag, ASSO]
    );
    const c = await openAttempt(buyer, TIER_C);

    // Hold the existing holder's tag row, so the retag stops INSIDE its transaction, at its bulk
    // UPDATE - after it saved the renamed tier and before it commits.
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM user_tags WHERE "userId" = $1 AND "tagName" = $2 FOR UPDATE`, [
      holder,
      oldTag,
    ]);
    const retag = settled(service.update(ASSO, TIER_C, { variantKey: 'c2' } as never, false));
    const retagWaits = await waitersReach(1, null);
    // The settlement must wait for the retag's commit: deriving the tag before it would write the
    // old name AFTER the rename, which the rename never sees.
    const paid = settled(settle(c.id));
    const bothWait = await waitersReach(2, null);
    // Committed BEFORE asserting: a failed wait must not leave the retag blocked on this row lock.
    await admin.query('COMMIT');
    const [r, p] = await Promise.all([retag, paid]);
    expect(retagWaits).toBe(1);
    expect(bothWait).toBe(2);

    expect(r.error).toBeNull();
    expect(p.error).toBeNull();
    expect(await heldTags(buyer)).toEqual(['cotisant:cercle-it-c2']);
    expect(await heldTags(holder)).toEqual(['cotisant:cercle-it-c2']);
  });

  it('migrations 112 and 113 run a second time cleanly, and leave one column and one unique index', async () => {
    await admin.query(migration(MIGRATION_HELD_TIER));
    await admin.query(migration(MIGRATION_CLOSINGS));
    await admin.query('RESET lock_timeout');

    const columns = await ds.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'product_checkouts' AND column_name = 'heldTierProductId'`,
      [schema]
    );
    expect(columns).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
    const indexes = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'purchase_record_closings'
          AND indexname = 'purchase_record_closings_one_per_record'`,
      [schema]
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toMatch(/UNIQUE/);
    // The checkout status CHECK is untouched: no new state.
    const [check] = await ds.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = 'product_checkouts_status' AND n.nspname = $1`,
      [schema]
    );
    expect(check.def).not.toMatch(/not_granted/);
  });

  it('an opening FREEZES the tier it ranked against on its row', async () => {
    const buyer = newBuyer();
    await grantRawTag(buyer, TAG_B);

    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_D, buyer);

    const [row] = await ds.query(
      `SELECT "heldTierProductId" FROM product_checkouts WHERE id = $1`,
      [checkoutId]
    );
    expect(row.heldTierProductId).toBe(TIER_B);
  });

  it('a price edited between opening and settlement changes nothing: the frozen rise is GRANTED', async () => {
    const buyer = newBuyer();
    await grantRawTag(buyer, TAG_B);
    // Opened as a rise (2000 over 1500) ...
    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_D, buyer);
    // ... then the association lowers the tier below the one held, before the payment lands. Ranked
    // on today's prices this would be `lower`; ranked on what the opening decided, it is the rise paid.
    await ds.query(`UPDATE association_products SET "amountCents" = 1000 WHERE id = $1`, [TIER_D]);
    try {
      await settle(checkoutId);
    } finally {
      await ds.query(`UPDATE association_products SET "amountCents" = 2000 WHERE id = $1`, [
        TIER_D,
      ]);
    }

    expect(await heldTags(buyer)).toEqual([TAG_D]);
    const records = await ds.query(
      `SELECT status FROM purchase_records WHERE "userId" = $1 AND "productId" = $2`,
      [buyer, TIER_D]
    );
    expect(records).toEqual([{ status: 'paid' }]);
    expect(refundsLogged()).toBe(0);
  });

  it('a tier obtained since the opening is still re-checked: the payment is MARKED, the tier kept', async () => {
    const buyer = newBuyer();
    await grantRawTag(buyer, TAG_A);
    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_D, buyer);
    // A manager grants tier B meanwhile; the XOR drops A, the tier the opening ranked against.
    await tags.grantCotisant(ASSO, buyer, 'manager', 'b');

    await settle(checkoutId);

    expect(await heldTags(buyer)).toEqual([TAG_B]);
    const records = await ds.query(
      `SELECT status FROM purchase_records WHERE "userId" = $1 AND "productId" = $2`,
      [buyer, TIER_D]
    );
    expect(records).toEqual([{ status: 'paid_not_granted' }]);
    expect(refundsLogged()).toBe(1);
  });

  it('a marked payment is closed ONCE: a second closing is refused with a typed code', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);

    const closed = await service.closePaidNotGranted(ASSO, record, 'manager-1', 'refunded', false);
    expect(closed).toMatchObject({ id: record, notGranted: true, closedOutcome: 'refunded' });
    expect(closed.closedAt).not.toBeNull();

    const again = await settled(
      service.closePaidNotGranted(ASSO, record, 'manager-2', 'granted', false)
    );
    expect(codeOf(again.error)).toBe('PURCHASE_ALREADY_CLOSED');
    // The first outcome stands, the mark stays as history, and the refused `granted` granted nothing.
    const rows = await ds.query(
      `SELECT outcome, "closedByUserId" FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
      [record]
    );
    expect(rows).toEqual([{ outcome: 'refunded', closedByUserId: 'manager-1' }]);
    const [status] = await ds.query(`SELECT status FROM purchase_records WHERE id = $1`, [record]);
    expect(status.status).toBe('paid_not_granted');
    expect(await heldTags(buyer)).toEqual([TAG_B]);
  });

  it('two closings of one payment at once: exactly one row, the other refused', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);

    const outcomes = await Promise.all([
      settled(service.closePaidNotGranted(ASSO, record, 'manager-1', 'refunded', false)),
      settled(service.closePaidNotGranted(ASSO, record, 'manager-2', 'refunded', false)),
    ]);

    expect(outcomes.filter((o) => o.error === null)).toHaveLength(1);
    expect(outcomes.map((o) => codeOf(o.error)).filter(Boolean)).toEqual([
      'PURCHASE_ALREADY_CLOSED',
    ]);
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
      [record]
    );
    expect(rows[0].n).toBe(1);
  });

  it('closing as GRANTED grants the tier paid for, by hand, and swaps the held tier out', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);

    const closed = await service.closePaidNotGranted(ASSO, record, 'manager-1', 'granted', false);

    expect(closed.closedOutcome).toBe('granted');
    expect(await heldTags(buyer)).toEqual([TAG_D]);
  });

  it('a payment that is not marked cannot be closed', async () => {
    const buyer = newBuyer();
    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_A, buyer);
    await settle(checkoutId);
    const [paid] = await ds.query(`SELECT id FROM purchase_records WHERE "userId" = $1`, [buyer]);

    const refused = await settled(
      service.closePaidNotGranted(ASSO, paid.id, 'm', 'refunded', false)
    );

    expect(codeOf(refused.error)).toBe('PURCHASE_NOT_CLOSABLE');
  });

  /**
   * A paid form's record marked `paid_not_granted`, written directly (a form has no checkout row),
   * for a form granting tier `variantKey`. Answers the record id.
   */
  async function markedFormRecord(userId: string, variantKey: string | null): Promise<string> {
    const formId = `00000000-0000-4000-8000-${String(++buyerSeq).padStart(12, '0')}`;
    await ds.query(
      `INSERT INTO forms (id, "associationId", "grantsCotisation", "cotisationVariantKey")
       VALUES ($1, $2, true, $3)`,
      [formId, ASSO, variantKey]
    );
    const record = await ds.getRepository(PurchaseRecord).save(
      ds.getRepository(PurchaseRecord).create({
        userId,
        source: 'form',
        formId,
        productId: null,
        amountCents: 1500,
        paymentMethod: 'online',
        status: 'paid_not_granted',
        stripePaymentIntentId: null,
        associationId: ASSO,
        productName: 'Adhesion',
      })
    );
    return record.id;
  }

  it("closing a paid FORM as granted grants the form's tier by hand", async () => {
    const buyer = newBuyer();
    const record = await markedFormRecord(buyer, 'a');

    const closed = await service.closePaidNotGranted(ASSO, record, 'manager-1', 'granted', false);

    expect(closed).toMatchObject({ source: 'form', closedOutcome: 'granted' });
    expect(await heldTags(buyer)).toEqual([TAG_A]);
  });

  it('a tier absent from the catalogue is refused PURCHASE_TIER_GONE, typed, and nothing written', async () => {
    const buyer = newBuyer();
    const record = await markedFormRecord(buyer, 'no-such-tier');

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));

    expect(codeOf(refused.error)).toBe('PURCHASE_TIER_GONE');
    expect(await heldTags(buyer)).toEqual([]);
    const rows = await ds.query(
      `SELECT 1 FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
      [record]
    );
    expect(rows).toHaveLength(0);
  });

  it('an ERASED buyer cannot be closed as granted - no cotisant is minted - but can be refunded', async () => {
    const record = await markedFormRecord('[deleted]', 'a');

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));
    expect(codeOf(refused.error)).toBe('PURCHASE_BUYER_ERASED');
    expect(await heldTags('[deleted]')).toEqual([]);

    const closed = await service.closePaidNotGranted(ASSO, record, 'm', 'refunded', false);
    expect(closed).toMatchObject({ closedOutcome: 'refunded' });
  });

  it('an erasure committed while a granted closing waits for the row is SEEN: refused, no tag', async () => {
    const buyer = newBuyer();
    const record = await markedFormRecord(buyer, 'a');

    // The erasure's anonymisation of the record, held open on the test's connection.
    await admin.query('BEGIN');
    await admin.query(`UPDATE purchase_records SET "userId" = '[deleted]' WHERE id = $1`, [record]);
    const closing = settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));
    const waits = await waitersReach(1, null);
    await admin.query('COMMIT');
    const outcome = await closing;

    expect(waits).toBe(1);
    expect(codeOf(outcome.error)).toBe('PURCHASE_BUYER_ERASED');
    expect(await heldTags(buyer)).toEqual([]);
    expect(await heldTags('[deleted]')).toEqual([]);
  });

  it.each(['refunded', 'granted'] as const)(
    "association B cannot close association A's purchase by naming it under its own id (%s)",
    async (outcome) => {
      const OTHER_ASSO = '00000000-0000-4000-8000-0000000000b9';
      const buyer = newBuyer();
      const record = await markedRecord(buyer, TIER_D);

      const refused = await settled(
        service.closePaidNotGranted(OTHER_ASSO, record, 'm', outcome, false)
      );

      expect(refused.error).toBeInstanceOf(NotFoundException);
      const rows = await ds.query(
        `SELECT 1 FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
        [record]
      );
      expect(rows).toHaveLength(0);
      expect(await heldTags(buyer)).toEqual([TAG_B]);
    }
  );

  it('a tier DELIVERED since the payment (a roster grant) closes as GRANTED, the tag only stamped', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);
    // The manager delivered the tier paid for by hand, as the hourly report asks.
    await tags.grantCotisant(ASSO, buyer, 'manager', 'd');
    const tagRow = () =>
      ds.query(
        `SELECT id, "grantedBy", "expiresAt", metadata, "createdAt" FROM user_tags WHERE "userId" = $1`,
        [buyer]
      );
    const before = await tagRow();
    const purchases = new PurchaseRecordService(ds.getRepository(PurchaseRecord));
    const unclosed = await purchases.countUnclosedPaidNotGranted();

    const closed = await service.closePaidNotGranted(ASSO, record, 'm', 'granted', true);

    expect(closed.closedOutcome).toBe('granted');
    // The very row the roster wrote: no renewal, no validity extension - only the ONE stamp key.
    expect(before[0].metadata).not.toHaveProperty('purchaseRecordId');
    expect(await tagRow()).toEqual([
      { ...before[0], metadata: { ...before[0].metadata, purchaseRecordId: record } },
    ]);
    expect(await purchases.countUnclosedPaidNotGranted()).toBe(unclosed - 1);
  });

  it("a tier delivered by the buyer's SECOND payment does not close the first one as granted", async () => {
    const buyer = newBuyer();
    const first = await markedRecord(buyer, TIER_D);
    // The buyer pays tier D again (a rise over B): this payment is granted, and ITS tag is recent.
    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_D, buyer);
    // Its own Lydia request (the stubbed provider answers every opening with the same one).
    await ds.query(`UPDATE product_checkouts SET "requestId" = 'second-payment' WHERE id = $1`, [
      checkoutId,
    ]);
    await settle(checkoutId);
    expect(await heldTags(buyer)).toEqual([TAG_D]);

    const refused = await settled(service.closePaidNotGranted(ASSO, first, 'm', 'granted', false));

    expect(codeOf(refused.error)).toBe('PURCHASE_TARGET_ALREADY_HELD');
    const rows = await ds.query(
      `SELECT 1 FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
      [first]
    );
    expect(rows).toHaveLength(0);
  });

  it('one delivery closes ONE payment: a second payment of the same tier stays reported', async () => {
    const buyer = newBuyer();
    const first = await markedFormRecord(buyer, 'd');
    const second = await markedFormRecord(buyer, 'd');
    await tags.grantCotisant(ASSO, buyer, 'manager', 'd');

    const closed = await service.closePaidNotGranted(ASSO, first, 'm', 'granted', true);
    const refused = await settled(service.closePaidNotGranted(ASSO, second, 'm', 'granted', false));

    expect(closed.closedOutcome).toBe('granted');
    expect(codeOf(refused.error)).toBe('PURCHASE_TARGET_ALREADY_HELD');
    const [row] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === second);
    expect(row).toMatchObject({ grantRefusal: 'target-held', delivered: false });
  });

  it('a tag is stamped as the delivery of ONE record: a second stamp writes nothing', async () => {
    const buyer = newBuyer();
    await grantRawTag(buyer, TAG_D);
    const [{ id }] = await ds.query(`SELECT id FROM user_tags WHERE "userId" = $1`, [buyer]);
    const first = '00000000-0000-4000-8000-0000000000e1';

    const stamps = await ds.transaction(async (m) => [
      await tags.stampDelivery(id, first, m),
      await tags.stampDelivery(id, '00000000-0000-4000-8000-0000000000e2', m),
    ]);

    expect(stamps).toEqual([true, false]);
    const [row] = await ds.query(`SELECT metadata FROM user_tags WHERE id = $1`, [id]);
    expect(row.metadata).toEqual({ purchaseRecordId: first });
  });

  /** The form a record was paid on. */
  const formOf = async (record: string): Promise<string> =>
    (await ds.query(`SELECT "formId" FROM purchase_records WHERE id = $1`, [record]))[0].formId;

  /** A REAL answer to `formId` by `userId` (null: a guest's), PAID. Answers its id. */
  async function answerTo(formId: string, userId: string | null): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(++buyerSeq).padStart(12, '0')}`;
    await ds.query(`INSERT INTO submissions (id, "formId", "userId") VALUES ($1, $2, $3)`, [
      id,
      formId,
      userId,
    ]);
    return id;
  }

  /** The form run's own grant of tier D, dated before any record: time alone says "renewal". */
  const formGrant = (userId: string, submissionId: string) =>
    ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy", metadata, "createdAt")
       VALUES ($1, $2, $3, 'form', $4, '2000-01-01')`,
      [userId, TAG_D, ASSO, JSON.stringify({ submissionId })]
    );

  it("a form answer's own grant, written BEFORE its record (the replay race), closes the record as granted", async () => {
    const buyer = newBuyer();
    const record = await markedFormRecord(buyer, 'd');
    await formGrant(buyer, await answerTo(await formOf(record), buyer));
    const [listed] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === record);
    expect(listed).toMatchObject({ grantRefusal: null, delivered: true });

    const closed = await service.closePaidNotGranted(ASSO, record, 'm', 'granted', true);

    expect(closed.closedOutcome).toBe('granted');
  });

  it.each([
    ['an answer to ANOTHER form, by the same buyer', 'other-form'],
    ["ANOTHER buyer's answer to the same form", 'other-buyer'],
    ['a FIRST answer to the same form, when the buyer paid it twice', 'second-answer'],
    ['a SECOND paid answer to the same form whose record is not written yet', 'unrecorded-answer'],
  ] as const)("is not this payment's delivery: %s", async (_case, variant) => {
    const buyer = newBuyer();
    const record = await markedFormRecord(buyer, 'd');
    const formId = await formOf(record);
    let answer: string;
    if (variant === 'other-form') {
      answer = await answerTo(await formOf(await markedFormRecord(newBuyer(), 'd')), buyer);
    } else if (variant === 'other-buyer') {
      answer = await answerTo(formId, newBuyer());
    } else if (variant === 'unrecorded-answer') {
      // This record's own answer, then a second one paid and granted whose record fulfilment has
      // not written yet: the record count still reads ONE, the paid answers TWO.
      await answerTo(formId, buyer);
      answer = await answerTo(formId, buyer);
    } else {
      // The buyer answered this form twice: the first answer was granted and recorded paid, the
      // second is the marked one. The record names no answer, so the tag cannot be told its.
      answer = await answerTo(formId, buyer);
      await answerTo(formId, buyer);
      await ds.getRepository(PurchaseRecord).save(
        ds.getRepository(PurchaseRecord).create({
          userId: buyer,
          source: 'form',
          formId,
          productId: null,
          amountCents: 1500,
          paymentMethod: 'online',
          status: 'paid',
          stripePaymentIntentId: null,
          associationId: ASSO,
          productName: 'Adhesion',
        })
      );
    }
    await formGrant(buyer, answer);

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));

    expect(codeOf(refused.error)).toBe('PURCHASE_TARGET_ALREADY_HELD');
    const [row] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === record);
    expect(row).toMatchObject({ grantRefusal: 'target-held', delivered: false });
  });

  it('a tag revoked between the list and the click: the "nothing is granted" closing grants nothing', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);
    await tags.grantCotisant(ASSO, buyer, 'manager', 'd');
    const [listed] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === record);
    expect(listed.delivered).toBe(true);
    await ds.query(`DELETE FROM user_tags WHERE "userId" = $1`, [buyer]);

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', true));

    expect(codeOf(refused.error)).toBe('PURCHASE_CLOSING_CHANGED');
    expect(await heldTags(buyer)).toEqual([]);
    const rows = await ds.query(
      `SELECT 1 FROM purchase_record_closings WHERE "purchaseRecordId" = $1`,
      [record]
    );
    expect(rows).toHaveLength(0);
  });

  it('GRANTED is refused PURCHASE_TARGET_ALREADY_HELD when the tier was held BEFORE the payment: it stays reported', async () => {
    const buyer = newBuyer();
    // Held first, then a payment for that same tier marked (a form paid for a renewal it did not buy).
    await grantRawTag(buyer, TAG_D);
    const record = await markedFormRecord(buyer, 'd');
    const purchases = new PurchaseRecordService(ds.getRepository(PurchaseRecord));
    const before = await purchases.countUnclosedPaidNotGranted();

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));

    expect(codeOf(refused.error)).toBe('PURCHASE_TARGET_ALREADY_HELD');
    expect(await purchases.countUnclosedPaidNotGranted()).toBe(before);
    expect(await heldTags(buyer)).toEqual([TAG_D]);
    const [row] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === record);
    expect(row).toMatchObject({ grantRefusal: 'target-held' });
  });

  it('a tier frozen at the opening and gone at the settlement is MARKED, not granted at the rise price', async () => {
    const buyer = newBuyer();
    await grantRawTag(buyer, TAG_B);
    // Opened as the rise B -> D, at the price of that rise ...
    const { checkoutId } = await service.createCheckoutSession(ASSO, TIER_D, buyer);
    // ... then B is revoked before the payment lands: nothing is held, but the rise was ranked over B.
    await ds.query(`DELETE FROM user_tags WHERE "userId" = $1`, [buyer]);

    await settle(checkoutId);

    expect(await heldTags(buyer)).toEqual([]);
    const records = await ds.query(
      `SELECT status FROM purchase_records WHERE "userId" = $1 AND "productId" = $2`,
      [buyer, TIER_D]
    );
    expect(records).toEqual([{ status: 'paid_not_granted' }]);
    expect(refundsLogged()).toBe(1);
  });

  it('GRANTED is refused PURCHASE_NOT_A_RISE when the buyer holds a tier worth as much: never a move down', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);
    // Tier C (same price as D; its key is retagged by its own test, so read it) obtained since.
    const [{ variantKey }] = await ds.query(
      `SELECT "variantKey" FROM association_products WHERE id = $1`,
      [TIER_C]
    );
    await tags.grantCotisant(ASSO, buyer, 'manager', variantKey);

    const refused = await settled(service.closePaidNotGranted(ASSO, record, 'm', 'granted', false));

    expect(codeOf(refused.error)).toBe('PURCHASE_NOT_A_RISE');
    expect(await heldTags(buyer)).toEqual([`cotisant:cercle-it-${variantKey}`]);
    const [row] = (await service.listAssociationPurchases(ASSO)).filter((r) => r.id === record);
    expect(row).toMatchObject({ grantRefusal: 'not-a-rise', buyerTier: 'Tier c' });
  });

  /** The erasure's tier statements, in the order `ERASURE_ROW_STATEMENTS` runs them. */
  const erasureTierStatements = () =>
    ERASURE_ROW_STATEMENTS.filter((st) =>
      (ERASURE_TIER_ORDER as readonly string[]).includes(st.label)
    );

  it("a payment landing AFTER its buyer's erasure is marked paid_not_granted and grants nothing", async () => {
    const buyer = newBuyer();
    const attempt = await openAttempt(buyer, TIER_A);
    // The erasure committed while the payment was in flight: the attempt names no account now.
    await ds.transaction(async (m) => {
      for (const st of erasureTierStatements()) await m.query(st.sql, erasureParams(st, buyer));
    });

    await settle(attempt.id);

    const [settledRow] = await ds.query(
      `SELECT "purchaseRecordId" FROM product_checkouts WHERE id = $1`,
      [attempt.id]
    );
    const [record] = await ds.query(`SELECT "userId", status FROM purchase_records WHERE id = $1`, [
      settledRow.purchaseRecordId,
    ]);
    // The same form the erasure writes on purchase_records, not the checkout's `[deleted]:<id>`.
    expect(record).toEqual({ userId: '[deleted]', status: 'paid_not_granted' });
    expect(await heldTags(`[deleted]:${attempt.id}`)).toEqual([]);
    expect(await heldTags(buyer)).toEqual([]);
    expect(refundsLogged()).toBe(1);
  });

  it('an erasure that meets a settlement mid-flight waits for it, then rewrites the record it wrote', async () => {
    const buyer = newBuyer();
    const attempt = await openAttempt(buyer, TIER_A);
    // The settlement's transaction, held open on the test's connection: it holds the checkout row
    // and has written its purchase record, not committed yet.
    await admin.query('BEGIN');
    await admin.query(`SELECT id FROM product_checkouts WHERE id = $1 FOR UPDATE`, [attempt.id]);
    const inserted = await admin.query(
      `INSERT INTO purchase_records ("userId", source, "productId", "amountCents", "paymentMethod", status, "associationId", "productName")
       VALUES ($1, 'product', $2, 1500, 'online', 'paid', $3, 'Tier') RETURNING id`,
      [buyer, TIER_A, ASSO]
    );
    const recordId = (inserted.rows[0] as { id: string }).id;
    const erasure = settled(
      ds.transaction(async (m) => {
        for (const st of erasureTierStatements()) await m.query(st.sql, erasureParams(st, buyer));
      })
    );
    const waits = await waitersReach(1, null);
    await admin.query('COMMIT');
    const outcome = await erasure;

    expect(waits).toBe(1);
    expect(outcome.error).toBeNull();
    // Checkouts first: the erasure waited on the row, so the record was committed before it was
    // rewritten. Records first would have missed it and left the real id behind.
    // THAT record, by its id - not a scan that an absent row would pass.
    const records = await ds.query(`SELECT "userId" FROM purchase_records WHERE id = $1`, [
      recordId,
    ]);
    expect(records).toEqual([{ userId: '[deleted]' }]);
    const left = await ds.query(`SELECT 1 FROM purchase_records WHERE "userId" = $1`, [buyer]);
    expect(left).toHaveLength(0);
  });

  it('closing GRANTED over a buyer holding TWO tiers ranks against the dearer and leaves ONE tier', async () => {
    const buyer = newBuyer();
    const record = await markedRecord(buyer, TIER_D);
    // markedRecord leaves B; A is added beside it: two tiers held at once (both 1500).
    await grantRawTag(buyer, TAG_A);

    const closed = await service.closePaidNotGranted(ASSO, record, 'manager-1', 'granted', false);

    expect(closed.closedOutcome).toBe('granted');
    // D (2000) is a rise over the dearer held (1500); the sibling XOR revoked BOTH held tiers.
    expect(await heldTags(buyer)).toEqual([TAG_D]);
  });

  it('the hourly count reads only the marked payments nobody has closed', async () => {
    const purchases = new PurchaseRecordService(ds.getRepository(PurchaseRecord));
    const before = await purchases.countUnclosedPaidNotGranted();
    const first = await markedRecord(newBuyer(), TIER_D);
    await markedRecord(newBuyer(), TIER_D);
    expect(await purchases.countUnclosedPaidNotGranted()).toBe(before + 2);

    await service.closePaidNotGranted(ASSO, first, 'manager-1', 'refunded', false);

    expect(await purchases.countUnclosedPaidNotGranted()).toBe(before + 1);
  });
  it("a paid form's pre-check ranks against the real tables: held, not a rise, a rise", async () => {
    const buyer = newBuyer();
    await ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [buyer, TAG_B, ASSO]
    );
    expect(await tags.rankCotisationTier(ASSO, buyer, 'b')).toBe('held');
    expect(await tags.rankCotisationTier(ASSO, buyer, 'a')).toBe('lower');
    expect(await tags.rankCotisationTier(ASSO, buyer, 'd')).toBe('higher');
    expect(await tags.rankCotisationTier(ASSO, newBuyer(), 'a')).toBe('none');
  });

  it('a payment for a product deleted meanwhile is recorded paid_not_granted, nothing granted', async () => {
    const buyer = newBuyer();
    const gone = '00000000-0000-4000-8000-0000000000c9';
    await ds.getRepository(AssociationProduct).save(
      ds.getRepository(AssociationProduct).create({
        id: gone,
        associationId: ASSO,
        name: 'Gone',
        type: 'other',
        amountCents: 1500,
        currency: 'eur',
        isActive: true,
      })
    );
    const attempt = await openAttempt(buyer, gone);
    await ds.query(`DELETE FROM association_products WHERE id = $1`, [gone]);

    await settle(attempt.id);

    expect(
      await ds.query(`SELECT status FROM purchase_records WHERE "userId" = $1`, [buyer])
    ).toEqual([{ status: 'paid_not_granted' }]);
    expect(await heldTags(buyer)).toEqual([]);
    expect(refundsLogged()).toBe(1);
  });
});
