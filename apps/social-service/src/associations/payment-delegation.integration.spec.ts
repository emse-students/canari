/**
 * A LIST COLLECTS THROUGH A DELEGATE, AGAINST A REAL POSTGRESQL (owner, 2026-11-02; migration 124).
 *
 * What a mocked repository cannot prove: that the approval writes `approved` AND its record in one
 * transaction, that a revoke and an unlink withhold exactly the list's on-sale products in the same
 * transaction as the write that stranded it, that the release after a NEW acceptance puts back
 * exactly those, that a paid form of the list reads paused and resumes with the same facts, and
 * that a purchase of the list routes to the RECEIVER's Lydia Business. Migration 124 runs twice.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- payment-delegation.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const RECEIVER = '00000000-0000-4000-8000-0000000002a1';
const OTHER_RECEIVER = '00000000-0000-4000-8000-0000000002a2';
const LIST = '00000000-0000-4000-8000-0000000002b1';
const TREASURER = 'treasurer-of-the-receiver';
const BDE_STAR = 'bde-governing-the-receiver';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('a list collects through an accepted payment delegation (PostgreSQL)', () => {
  const schema = `delegation_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let products: ProductsService;
  const tell = jest.fn(async () => 1);

  const options = (synchronize: boolean) => ({
    type: 'postgres' as const,
    url: URL,
    entities: [AssociationProduct, Association, AssociationAudience, Space],
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
    const sync = new DataSource(options(true));
    await sync.initialize();
    await sync.destroy();
    ds = new DataSource(options(false));
    await ds.initialize();
    // TWICE: CD may replay it, and every statement is IF NOT EXISTS.
    await admin.query(migration('124_payment_delegation_acceptances.sql'));
    await admin.query(migration('124_payment_delegation_acceptances.sql'));
    // `clearLydiaAccount` closes the cashiers of the unlinked Business.
    await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
    await admin.query(migration('119_lydia_cashiers_lot3.sql'));
    await admin.query('RESET lock_timeout');

    const assoRepo = ds.getRepository(Association);
    for (const [id, type, extra] of [
      [
        RECEIVER,
        'association',
        { lydiaAccountId: 'vendor-receiver', lydiaOnboardingComplete: true },
      ],
      [
        OTHER_RECEIVER,
        'association',
        { lydiaAccountId: 'vendor-other', lydiaOnboardingComplete: true },
      ],
      [LIST, 'list', {}],
    ] as const) {
      await assoRepo.save(
        assoRepo.create({
          id,
          type,
          name: `Entity ${id.slice(-2)}`,
          slug: `entity-${id.slice(-2)}`,
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
      listFlagHolders: async (id: string) => [`shop-manager-of-${id.slice(-2)}`],
      // The receiver's OWN shop manager holds MANAGE_PRODUCTS on it; the BDE star only through the
      // governing tier, which `withoutGoverningBde` drops. The tiers themselves are proven in
      // `associations.service.may-act.spec.ts`.
      mayAct: async (
        userId: string,
        _id: string,
        _flag: number,
        opts?: { withoutGoverningBde?: boolean }
      ) => userId === TREASURER || (userId === BDE_STAR && !opts?.withoutGoverningBde),
      getActivePaymentProvider: async () => 'lydia',
    }) as unknown as AssociationsService;
    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      assoRepo,
      productRepo: ds.getRepository(AssociationProduct),
      logger: new Logger('ProductsService'),
      activePaymentProvider: async () => 'lydia',
    }) as unknown as ProductsService;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const onSale = async (associationId: string, name: string) => {
    const repo = ds.getRepository(AssociationProduct);
    return repo.save(
      repo.create({
        associationId,
        name,
        type: 'other',
        amountCents: 1500,
        currency: 'eur',
        isActive: true,
      } as Partial<AssociationProduct>)
    );
  };
  const productState = async (id: string) => {
    const [row] = await ds.query(
      `SELECT "isActive", "activationWithheld" FROM association_products WHERE id = $1`,
      [id]
    );
    return row as { isActive: boolean; activationWithheld: boolean };
  };
  const acceptances = () =>
    ds.query(
      `SELECT "childAssociationId", "parentAssociationId", "acceptedByUserId", "acceptedAs"
         FROM payment_delegation_acceptances ORDER BY "acceptedAt", id`
    );
  const accept = (parent: string, userId: string, isGlobalAdmin = false) =>
    associations.approvePaymentDelegation(parent, LIST, { userId, isGlobalAdmin });

  it('a list requests; a BDE governing the receiver may NOT accept, nothing is written', async () => {
    await associations.requestPaymentDelegation(LIST, RECEIVER);
    await expect(accept(RECEIVER, BDE_STAR)).rejects.toMatchObject({
      response: { code: 'DELEGATION_ACCEPT_RECEIVER_ONLY' },
    });
    const [row] = await ds.query(
      `SELECT "paymentDelegationStatus" FROM associations WHERE id = $1`,
      [LIST]
    );
    expect(row.paymentDelegationStatus).toBe('pending');
    expect(await acceptances()).toEqual([]);
    expect(await associations.collectsNow(LIST)).toBe(false);
  });

  it("the receiver's own manager accepts: approved and RECORDED together; the list collects", async () => {
    await accept(RECEIVER, TREASURER);
    expect(await acceptances()).toEqual([
      {
        childAssociationId: LIST,
        parentAssociationId: RECEIVER,
        acceptedByUserId: TREASURER,
        acceptedAs: 'member',
      },
    ]);
    expect(await associations.collectsNow(LIST)).toBe(true);
    const [served] = await associations.withPaymentsReady([
      (await ds.getRepository(Association).findOneByOrFail({ id: LIST })) as Association,
    ]);
    expect(served.paymentsReady).toBe(true);
  });

  it("routes a purchase of the list to the RECEIVER's Lydia Business", async () => {
    const list = await ds.getRepository(Association).findOneByOrFail({ id: LIST });
    const target = await (
      products as unknown as { resolvePaymentTargetFor(a: Association): Promise<unknown> }
    ).resolvePaymentTargetFor(list);
    expect(target).toMatchObject({
      targetAssociationId: RECEIVER,
      connectAccountId: 'vendor-receiver',
      ready: true,
      delegated: true,
    });
  });

  it('a revoke by the receiver PAUSES the list: products withheld, managers told, form paused', async () => {
    const sweat = await onSale(LIST, 'Sweat');
    const offSale = await onSale(LIST, 'Retired');
    await ds.query(`UPDATE association_products SET "isActive" = false WHERE id = $1`, [
      offSale.id,
    ]);
    tell.mockClear();

    await associations.rejectPaymentDelegation(RECEIVER, LIST);

    expect(await productState(sweat.id)).toEqual({ isActive: false, activationWithheld: true });
    // A product a manager took off sale is not the platform's to release later.
    expect(await productState(offSale.id)).toEqual({ isActive: false, activationWithheld: false });
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'paused', [
      `shop-manager-of-${LIST.slice(-2)}`,
    ]);
    expect(await associations.collectsNow(LIST)).toBe(false);
  });

  it('a NEW acceptance (another receiver, by the platform admin) is recorded and RESUMES the list', async () => {
    const [{ id: sweatId }] = await ds.query(
      `SELECT id FROM association_products WHERE "associationId" = $1 AND name = 'Sweat'`,
      [LIST]
    );
    await associations.requestPaymentDelegation(LIST, OTHER_RECEIVER);
    await accept(OTHER_RECEIVER, 'platform-admin-1', true);
    tell.mockClear();
    // The route composes the release and the notice after the acceptance (controller).
    const released = await products.releaseWithheldProducts(LIST);
    await associations.tellDelegationResumed(LIST, released);

    expect(released).toBe(1);
    expect(await productState(sweatId)).toEqual({ isActive: true, activationWithheld: false });
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'active', [
      `shop-manager-of-${LIST.slice(-2)}`,
    ]);
    expect((await acceptances()).map((r: { acceptedAs: string }) => r.acceptedAs)).toEqual([
      'member',
      'platform-admin',
    ]);
    expect(await associations.collectsNow(LIST)).toBe(true);
  });

  it("the receiver's Lydia UNLINKED by the admin pauses the list too, and tells its managers", async () => {
    const [{ id: sweatId }] = await ds.query(
      `SELECT id FROM association_products WHERE "associationId" = $1 AND name = 'Sweat'`,
      [LIST]
    );
    const ownProduct = await onSale(OTHER_RECEIVER, 'Gala');
    tell.mockClear();

    await associations.clearLydiaAccount(OTHER_RECEIVER);

    expect(await productState(sweatId)).toEqual({ isActive: false, activationWithheld: true });
    expect(await productState(ownProduct.id)).toEqual({
      isActive: false,
      activationWithheld: true,
    });
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'paused', [
      `shop-manager-of-${LIST.slice(-2)}`,
    ]);
    expect(await associations.collectsNow(LIST)).toBe(false);
    // The release finds the receiver not ready: nothing goes back on sale.
    expect(await products.releaseWithheldProducts(LIST)).toBe(0);
  });

  it('a list holds no Lydia account of its own, and cannot RECEIVE a delegation', async () => {
    expect(await associations.payoutAccountRefusal(LIST)).toBe('LIST_NO_OWN_LYDIA_ACCOUNT');
    expect(await associations.payoutAccountRefusal(RECEIVER)).toBeNull();
    await expect(associations.requestPaymentDelegation(RECEIVER, LIST)).rejects.toMatchObject({
      response: { code: 'LIST_NO_OWN_LYDIA_ACCOUNT' },
    });
  });
});
