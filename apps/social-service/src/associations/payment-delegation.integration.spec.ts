/**
 * A LIST COLLECTS THROUGH A DELEGATE, AGAINST A REAL POSTGRESQL (owner, 2026-11-02; migration 125).
 *
 * What a mocked repository cannot prove: that the approval writes `approved` AND its record in one
 * transaction, that a revoke and an unlink withhold exactly the list's on-sale products in the same
 * transaction as the write that stranded it, that a NEW acceptance puts back exactly those in its
 * own transaction, that a paid form of the list reads paused and resumes with the same facts, and
 * that a purchase of the list routes to the RECEIVER's Lydia Business. Migration 125 runs twice.
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
import { PostNotification } from '../posts/entities/post-notification.entity';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const RECEIVER = '00000000-0000-4000-8000-0000000002a1';
const OTHER_RECEIVER = '00000000-0000-4000-8000-0000000002a2';
const LIST = '00000000-0000-4000-8000-0000000002b1';
const TREASURER = 'treasurer-of-the-receiver';
const BDE_STAR = 'bde-governing-the-receiver';
/** Governs the receiver as a BDE super-admin AND holds `MANAGE_PRODUCTS` in its own member row. */
const BDE_MEMBER = 'bde-star-who-granted-itself-the-shop';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('a list collects through an accepted payment delegation (PostgreSQL)', () => {
  const schema = `delegation_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let products: ProductsService;
  const tell = jest.fn(async () => 1);
  const tellDelegation = jest.fn(async () => 1);

  const options = (synchronize: boolean) => ({
    type: 'postgres' as const,
    url: URL,
    entities: [AssociationProduct, Association, AssociationAudience, Space, PostNotification],
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
    await admin.query(migration('125_payment_delegation_acceptances.sql'));
    await admin.query(migration('125_payment_delegation_acceptances.sql'));
    // `clearLydiaAccount` closes the cashiers of the unlinked Business.
    await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
    await admin.query(migration('119_lydia_cashiers_lot3.sql'));
    // The bridge's table (lydia-account-bridge.ts), read by every Lydia path: twice, idempotent.
    await admin.query(migration('167_lydia_account_bridge.sql'));
    await admin.query(migration('167_lydia_account_bridge.sql'));
    await admin.query('RESET lock_timeout');
    // A readiness revert reports to the platform admins, read from core's `users` (a stand-in here).
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false)`
    );
    await admin.query(`INSERT INTO users (id, admin) VALUES ('global-admin', true)`);

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
      lydiaNotifier: { enabled: () => true, tell, tellDelegation },
      listFlagHolders: async (id: string) => [`shop-manager-of-${id.slice(-2)}`],
      // The receiver's OWN shop manager holds MANAGE_PRODUCTS on it; the BDE star only through the
      // governing tier, which `withoutGoverningBde` drops. The tiers themselves are proven in
      // `associations.service.may-act.spec.ts`.
      mayAct: async (
        userId: string,
        _id: string,
        _flag: number,
        opts?: { withoutGoverningBde?: boolean }
      ) =>
        userId === TREASURER ||
        userId === BDE_MEMBER ||
        (userId === BDE_STAR && !opts?.withoutGoverningBde),
      isAssociationSuperAdminOf: async (userId: string) =>
        userId === BDE_STAR || userId === BDE_MEMBER,
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
      `SELECT "childAssociationId", "parentAssociationId", "acceptedByUserId", "acceptedAs",
              "accepterGoverningSuperAdmin"
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
        accepterGoverningSuperAdmin: false,
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

  it('a BDE governing the receiver may NOT revoke for it: typed 403, nothing changes', async () => {
    await expect(
      associations.rejectPaymentDelegation(RECEIVER, LIST, {
        userId: BDE_STAR,
        isGlobalAdmin: false,
      })
    ).rejects.toMatchObject({ response: { code: 'DELEGATION_REVOKE_RECEIVER_ONLY' } });
    expect(await associations.collectsNow(LIST)).toBe(true);
  });

  it('a revoke by the receiver PAUSES the list: products withheld, managers told, form paused', async () => {
    const sweat = await onSale(LIST, 'Sweat');
    const offSale = await onSale(LIST, 'Retired');
    await ds.query(`UPDATE association_products SET "isActive" = false WHERE id = $1`, [
      offSale.id,
    ]);
    tellDelegation.mockClear();

    await associations.rejectPaymentDelegation(RECEIVER, LIST, {
      userId: TREASURER,
      isGlobalAdmin: false,
    });

    expect(await productState(sweat.id)).toEqual({ isActive: false, activationWithheld: true });
    // A product a manager took off sale is not the platform's to release later.
    expect(await productState(offSale.id)).toEqual({ isActive: false, activationWithheld: false });
    expect(tellDelegation).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'revoked', [
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
    tellDelegation.mockClear();
    // The release is the acceptance's OWN transaction: committed, nothing is left withheld.
    await expect(accept(OTHER_RECEIVER, 'platform-admin-1', true)).resolves.toMatchObject({
      released: 1,
    });

    expect(await productState(sweatId)).toEqual({ isActive: true, activationWithheld: false });
    expect(tellDelegation).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'resumed', [
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
    tellDelegation.mockClear();

    await associations.clearLydiaAccount(OTHER_RECEIVER);

    expect(await productState(sweatId)).toEqual({ isActive: false, activationWithheld: true });
    expect(await productState(ownProduct.id)).toEqual({
      isActive: false,
      activationWithheld: true,
    });
    expect(tellDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ id: LIST }),
      'receiver-not-ready',
      [`shop-manager-of-${LIST.slice(-2)}`]
    );
    // Only an entity something was withheld from is told: the receiver's own managers get the
    // Lydia notice, never this one.
    expect(tellDelegation).toHaveBeenCalledTimes(1);
    expect(await associations.collectsNow(LIST)).toBe(false);
    // The release finds the receiver not ready: nothing goes back on sale.
    expect(await products.releaseWithheldProducts(LIST)).toBe(0);
  });

  // Owner review of #2967: a list that does not delegate resolves NOT ready whatever Lydia account
  // id a row from before the decision still carries - and the release reads the same answer.
  it('a non-delegating list with a stale own Lydia account id is never ready, and releases nothing', async () => {
    await ds.query(
      `UPDATE associations SET "paymentParentAssociationId" = NULL, "paymentDelegationStatus" = NULL,
              "lydiaAccountId" = 'stale-vendor', "lydiaOnboardingComplete" = true WHERE id = $1`,
      [LIST]
    );
    expect(await associations.collectsNow(LIST)).toBe(false);
    expect(await products.releaseWithheldProducts(LIST)).toBe(0);
    await ds.query(
      `UPDATE associations SET "lydiaAccountId" = NULL, "lydiaOnboardingComplete" = false WHERE id = $1`,
      [LIST]
    );
  });

  // Owner review of #2967: a governing BDE super-admin may grant itself MANAGE_PRODUCTS on the
  // receiver and accept as a member; the member row keeps no provenance, so the record carries it.
  it('records that a member accepter ALSO governed the receiver as a BDE super-admin', async () => {
    await associations.requestPaymentDelegation(LIST, RECEIVER);
    await accept(RECEIVER, BDE_MEMBER);
    const rows = await acceptances();
    expect(rows[rows.length - 1]).toMatchObject({
      acceptedByUserId: BDE_MEMBER,
      acceptedAs: 'member',
      accepterGoverningSuperAdmin: true,
    });
  });

  // A receiver whose account is ready again releases its delegates IN the readiness transaction.
  it("the receiver's readiness returning releases the list's products in the same transaction", async () => {
    const tee = await onSale(LIST, 'Tee');
    await associations.setLydiaReadiness('vendor-receiver', false, 'request-refused', {
      path: 'shop',
    });
    expect(await productState(tee.id)).toEqual({ isActive: false, activationWithheld: true });
    tellDelegation.mockClear();
    await associations.setLydiaReadiness('vendor-receiver', true, 'admin', { path: 'admin' });
    expect(await productState(tee.id)).toEqual({ isActive: true, activationWithheld: false });
    expect(tellDelegation).toHaveBeenCalledWith(expect.objectContaining({ id: LIST }), 'resumed', [
      `shop-manager-of-${LIST.slice(-2)}`,
    ]);
  });

  // Owner review of #2967 (F1): the readiness reads its delegates, then releases them. A revoke
  // committing in between used to be invisible to the release, which re-opened the paused list's
  // products for good. Interleaved deterministically: the revoke's row lock is taken and its write
  // made on a connection of its own, the readiness started, and the revoke committed only once the
  // readiness is seen WAITING on that lock.
  it('a revoke committing while the receiver becomes ready again is never undone by the release', async () => {
    const tee = await onSale(LIST, 'Tee (raced)');
    await associations.setLydiaReadiness('vendor-receiver', false, 'request-refused', {
      path: 'shop',
    });
    expect(await productState(tee.id)).toEqual({ isActive: false, activationWithheld: true });

    const revoke = new Client({ connectionString: URL });
    await revoke.connect();
    await revoke.query(`SET search_path TO ${schema},public`);
    await revoke.query('BEGIN');
    await revoke.query(`SELECT id FROM associations WHERE id = $1 FOR UPDATE`, [LIST]);
    await revoke.query(
      `UPDATE associations SET "paymentParentAssociationId" = NULL, "paymentDelegationStatus" = NULL
        WHERE id = $1`,
      [LIST]
    );
    tellDelegation.mockClear();
    let settled = false;
    const readiness = associations
      .setLydiaReadiness('vendor-receiver', true, 'admin', { path: 'admin' })
      .finally(() => {
        settled = true;
      });
    // Until the readiness waits on the revoke's lock - or finishes without waiting, which is the
    // defect, and the assertions below then fail.
    for (;;) {
      const {
        rows: [{ waiting }],
      } = await admin.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [schema]
      );
      if (waiting > 0 || settled) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await revoke.query('COMMIT');
    await revoke.end();
    await readiness;

    expect(await productState(tee.id)).toEqual({ isActive: false, activationWithheld: true });
    expect(tellDelegation).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: LIST }),
      'resumed',
      expect.anything()
    );
    // Back to the delegation the next tests start from.
    await associations.requestPaymentDelegation(LIST, RECEIVER);
    await accept(RECEIVER, TREASURER);
    await ds.query(`DELETE FROM association_products WHERE id = $1`, [tee.id]);
  });

  // Owner review of #2967 (F2): a list that sells through paid forms only has no product to
  // withhold, and stops collecting all the same - it is told every time its collecting changes.
  it('tells a forms-only list each time it stops or starts collecting, and nobody when nothing changed', async () => {
    await ds.query(`DELETE FROM association_products WHERE "associationId" = $1`, [LIST]);
    expect(await associations.collectsNow(LIST)).toBe(true);
    const told = () =>
      (tellDelegation.mock.calls as unknown as Array<[{ id: string }, string]>)
        .filter(([asso]) => asso.id === LIST)
        .map(([, notice]) => notice);

    tellDelegation.mockClear();
    await associations.setLydiaReadiness('vendor-receiver', false, 'request-refused', {
      path: 'form',
    });
    await associations.setLydiaReadiness('vendor-receiver', false, 'request-refused', {
      path: 'form',
    });
    await associations.setLydiaReadiness('vendor-receiver', true, 'admin', { path: 'admin' });
    await associations.setLydiaReadiness('vendor-receiver', true, 'admin', { path: 'admin' });
    expect(told()).toEqual(['receiver-not-ready', 'resumed']);

    tellDelegation.mockClear();
    await associations.rejectPaymentDelegation(RECEIVER, LIST, {
      userId: TREASURER,
      isGlobalAdmin: false,
    });
    expect(told()).toEqual(['revoked']);
    expect(await associations.collectsNow(LIST)).toBe(false);

    // A PENDING request refused: the list was not collecting through it, nothing to tell.
    tellDelegation.mockClear();
    await associations.requestPaymentDelegation(LIST, RECEIVER);
    await associations.rejectPaymentDelegation(RECEIVER, LIST, {
      userId: TREASURER,
      isGlobalAdmin: false,
    });
    expect(told()).toEqual([]);

    await associations.requestPaymentDelegation(LIST, RECEIVER);
    await accept(RECEIVER, TREASURER);
    expect(told()).toEqual(['resumed']);
  });

  it('a list holds no Lydia account of its own, and cannot RECEIVE a delegation', async () => {
    expect(await associations.payoutAccountRefusal(LIST)).toBe('LIST_NO_OWN_LYDIA_ACCOUNT');
    expect(await associations.payoutAccountRefusal(RECEIVER)).toBeNull();
    await expect(associations.requestPaymentDelegation(RECEIVER, LIST)).rejects.toMatchObject({
      response: { code: 'LIST_NO_OWN_LYDIA_ACCOUNT' },
    });
  });

  // Review of #2967: the request checks "no chain" before any lock, so two CROSSED requests - A asks
  // B while B asks C - both pass, and each writes its link whenever its own transaction runs. The
  // acceptance is where a chain would be written; whichever of the two is accepted second must
  // refuse, whichever order the writes and acceptances land in. B->C's write is the SQL below: the
  // late write of a request whose checks already passed.
  describe('no acceptance ever writes a chain', () => {
    const [A, B, C] = [
      '00000000-0000-4000-8000-0000000002c1',
      '00000000-0000-4000-8000-0000000002c2',
      '00000000-0000-4000-8000-0000000002c3',
    ];
    const status = async (id: string) =>
      (
        await ds.query(`SELECT "paymentDelegationStatus" AS s FROM associations WHERE id = $1`, [
          id,
        ])
      )[0].s as string | null;
    const accepted = async () =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM payment_delegation_acceptances
            WHERE "childAssociationId" = ANY($1)`,
          [[A, B]]
        )
      )[0].n as number;
    const approve = (parent: string, child: string) =>
      associations.approvePaymentDelegation(parent, child, {
        userId: TREASURER,
        isGlobalAdmin: false,
      });

    beforeEach(async () => {
      await ds.query(
        `DELETE FROM payment_delegation_acceptances WHERE "childAssociationId" = ANY($1)`,
        [[A, B]]
      );
      await ds.query(`DELETE FROM associations WHERE id = ANY($1)`, [[A, B, C]]);
      const repo = ds.getRepository(Association);
      for (const id of [A, B, C]) {
        await repo.save(
          repo.create({
            id,
            type: 'association',
            name: `Chain ${id.slice(-2)}`,
            slug: `chain-${id.slice(-2)}`,
            createdBy: 'it',
            lydiaAccountId: `vendor-${id.slice(-2)}`,
            lydiaOnboardingComplete: true,
          } as Partial<Association>)
        );
      }
      await associations.requestPaymentDelegation(A, B);
    });
    const bAsksC = () =>
      ds.query(
        `UPDATE associations SET "paymentParentAssociationId" = $2, "paymentDelegationStatus" = 'pending'
          WHERE id = $1`,
        [B, C]
      );
    const refused = { status: 409, response: { code: 'DELEGATION_CHAIN_REFUSED' } };

    it('B asks C: A->B is refused while B->C is pending AND once it is approved', async () => {
      await bAsksC();
      await expect(approve(B, A)).rejects.toMatchObject(refused);
      await approve(C, B);
      await expect(approve(B, A)).rejects.toMatchObject(refused);
      expect(await status(A)).toBe('pending');
      expect(await accepted()).toBe(1);
    });

    it("A->B accepted before B's request lands: accepting B->C is refused, B already receives", async () => {
      await approve(B, A);
      await bAsksC();
      await expect(approve(C, B)).rejects.toMatchObject({
        status: 409,
        response: { code: 'DELEGATION_CHAIN_REFUSED' },
      });
      expect(await status(B)).toBe('pending');
      expect(await accepted()).toBe(1);
    });
  });
});
