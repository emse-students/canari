/**
 * A boutique attempt against a REAL PostgreSQL: migration 101 as written, and the settlement's row
 * lock. The unit spec runs on an in-memory store whose "lock" is JavaScript's single thread, so it
 * cannot show that two settlements racing on one payment (the confirm callback and the payer's
 * return) record ONE purchase - only a database serialises two transactions.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- product-checkout.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ProductCheckout } from './entities/product-checkout.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { ProductsService } from './products.service';
import { isUniqueViolation } from '../common/pg-errors';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const PRODUCT = '00000000-0000-4000-8000-0000000000b1';
const ASSO = '00000000-0000-4000-8000-0000000000a1';
const USER = 'c'.repeat(64);

maybe('product checkout attempts against PostgreSQL', () => {
  const schema = `product_checkout_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ProductsService;

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    extra: { options: `-c search_path=${schema},public` },
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // The tables the settlement touches beside the attempt, from their entities.
    const others = new DataSource(options(true, [PurchaseRecord, AssociationProduct]));
    await others.initialize();
    await others.destroy();
    ds = new DataSource(options(false, [ProductCheckout, PurchaseRecord, AssociationProduct]));
    await ds.initialize();
    // The attempt table from the migration file itself, twice: it must be idempotent.
    const migration = readFileSync(
      join(__dirname, '../migrations/101_product_checkouts.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    // The held tier frozen at the opening (112), on the admin connection: its `SET lock_timeout`
    // must not stay on a pool connection.
    await admin.query(`SET search_path TO ${schema},public`);
    await admin.query(
      readFileSync(join(__dirname, '../migrations/112_product_checkouts_held_tier.sql'), 'utf8')
    );
    await admin.query('RESET lock_timeout');

    service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: ds.getRepository(ProductCheckout),
      purchaseRecordService: new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
    }) as unknown as ProductsService;
    // The product is gone (no row): the purchase is still recorded, no tag granted - and said so.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const openAttempt = (overrides: Partial<ProductCheckout> = {}) =>
    ds.getRepository(ProductCheckout).save(
      ds.getRepository(ProductCheckout).create({
        productId: PRODUCT,
        userId: USER,
        associationId: ASSO,
        paymentAssociationId: ASSO,
        vendorToken: 'vendor-test',
        amountCents: 1000,
        currency: 'eur',
        productName: 'Cotisation',
        requestUuid: 'a'.repeat(32),
        requestId: '1001',
        status: 'open',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        settledAt: null,
        purchaseRecordId: null,
        ...overrides,
      })
    );

  it('records ONE purchase when eight settlements of one paid attempt race', async () => {
    const row = await openAttempt();
    const settle = (service as any).settlePaidCheckout.bind(service) as (
      id: string
    ) => Promise<void>;
    await Promise.all(Array.from({ length: 8 }, () => settle(row.id)));

    const records = await ds.query(`SELECT id FROM purchase_records WHERE "productId" = $1`, [
      PRODUCT,
    ]);
    expect(records).toHaveLength(1);
    const [after] = await ds.query(
      `SELECT status, "purchaseRecordId" FROM product_checkouts WHERE id = $1`,
      [row.id]
    );
    expect(after).toEqual({ status: 'paid', purchaseRecordId: records[0].id });
  });

  it('completes an attempt paid before its request id was known ONCE, however many callbacks race', async () => {
    // A lost request/do, paid and settled by order_ref on the payer's return: no id to record.
    const row = await openAttempt({ userId: 'd'.repeat(64), requestUuid: null, requestId: null });
    await (service as any).settlePaidCheckout(row.id);
    const [before] = await ds.query(
      `SELECT "stripePaymentIntentId" FROM purchase_records WHERE "userId" = $1`,
      ['d'.repeat(64)]
    );
    expect(before.stripePaymentIntentId).toBeNull();

    const log = jest.spyOn(Logger.prototype, 'log');
    const complete = (service as any).completePaidWithoutRequestId.bind(service) as (
      id: string,
      requestId: string
    ) => Promise<void>;
    await Promise.all(Array.from({ length: 8 }, () => complete(row.id, '1001')));
    const [after] = await ds.query(
      `SELECT "stripePaymentIntentId" FROM purchase_records WHERE "userId" = $1`,
      ['d'.repeat(64)]
    );
    expect(after.stripePaymentIntentId).toBe('1001');
    // `IS NULL` on the update is what makes ONE of them the completion that may credit a top-up.
    expect(
      log.mock.calls.filter(([m]) => String(m).includes('purchase record completed'))
    ).toHaveLength(1);
    log.mockRestore();
  });

  it('completes the record when the return settled it while the callback held an open snapshot', async () => {
    const buyer = 'e'.repeat(64);
    const row = await openAttempt({ userId: buyer, requestUuid: null, requestId: null });
    const repo = ds.getRepository(ProductCheckout);
    const stale = await repo.findOneOrFail({ where: { id: row.id } });
    // The payer's return wins the race: paid, no id known.
    await (service as any).settlePaidCheckout(row.id);
    const findOne = jest.spyOn(repo, 'findOne').mockResolvedValueOnce(stale);
    // Lydia answers paid; the settlement then finds the row paid and records nothing.
    const read = jest.fn(async (r: ProductCheckout) => {
      await (service as any).settlePaidCheckout(r.id);
      return 'paid';
    });
    const racing = Object.assign(Object.create(service) as object, {
      readAndApplyRequestState: read,
    }) as unknown as ProductsService;

    await expect(
      racing.handlePurchaseCompleted(PRODUCT, row.id, '1001', 'vendor-test')
    ).resolves.toEqual({
      outcome: 'paid',
    });
    findOne.mockRestore();
    expect(read).toHaveBeenCalledTimes(1);
    const records = await ds.query(
      `SELECT "stripePaymentIntentId" FROM purchase_records WHERE "userId" = $1`,
      [buyer]
    );
    expect(records).toEqual([{ stripePaymentIntentId: '1001' }]);
    const [after] = await ds.query(
      `SELECT "requestId", status FROM product_checkouts WHERE id = $1`,
      [row.id]
    );
    expect(after).toEqual({ requestId: '1001', status: 'paid' });
  });

  it('refuses a second OPEN attempt of one product and buyer, and allows one once the first is closed', async () => {
    const first = await openAttempt();
    const second = await openAttempt().catch((e: unknown) => e);
    expect(isUniqueViolation(second)).toBe(true);

    await ds.query(`UPDATE product_checkouts SET status = 'declined' WHERE id = $1`, [first.id]);
    await expect(openAttempt()).resolves.toMatchObject({ status: 'open' });
  });

  it('refuses a status the migration does not know', async () => {
    const row = await ds.query(`SELECT id FROM product_checkouts LIMIT 1`);
    await expect(
      ds.query(`UPDATE product_checkouts SET status = 'refunded' WHERE id = $1`, [row[0].id])
    ).rejects.toThrow(/product_checkouts_status/);
  });
});
