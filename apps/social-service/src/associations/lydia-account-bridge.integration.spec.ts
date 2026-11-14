/**
 * THE BRIDGE FROM A HISTORICAL LYDIA ACCOUNT TO THE ENROLLED BUSINESS, AGAINST A REAL POSTGRESQL
 * (owner, 2026-11-13; lydia-account-bridge.ts, migration 167).
 *
 * What a mocked manager cannot prove: that the enrolment of an association whose historical account
 * collects leaves that account collecting; that the VALIDATED of the enrolled Business swaps the two
 * under the association's lock, so the NEXT checkout - and one racing the switch - goes to the new
 * Business; that a forged VALIDATED costs one error 5, a switch back and the SAME purchase issued on
 * the historical account, with exactly ONE request existing at Lydia; that the historical key still
 * opens, by the row's vendor token, after the switch; and that a delegate of the parent follows the
 * switch. Migration 167 runs twice.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-account-bridge.integration
 *
 * Every vendor token and key below is a throwaway string made up for the test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { type Observable, of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';
import { ProductCheckout } from './entities/product-checkout.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { Submission } from '../forms/entities/submission.entity';
import { PurchaseRecordClosing } from '../users/entities/purchase-record-closing.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { SECRET_BOX_ENV } from '../common/secret-box';
import { AssociationsService } from './associations.service';
import {
  LYDIA_BUSINESS_HOLDS_PAYMENTS,
  LYDIA_BUSINESS_PENDING_VALIDATION,
} from './lydia-account-bridge';
import { LYDIA_PAYMENTS_PAUSED_TYPE } from './lydia-payments-notifier.service';
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const BDE = '00000000-0000-4000-8000-0000000002b1';
const LIST = '00000000-0000-4000-8000-0000000002b2';
const HISTORICAL = 'vendor-token-historical';
const ENROLLED = 'vendor-token-enrolled';
const HISTORICAL_KEY = 'throwaway-historical-key';
const ENROLLED_KEY = 'throwaway-enrolled-key';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

/** Core's answer to a `request/do` Lydia refused with error 5: no request exists at Lydia. */
const error5 = () =>
  Object.assign(new Error('refused'), {
    response: { status: 400, data: { code: 'LYDIA_BUSINESS_NOT_VALIDATED', providerCode: '5' } },
  });

maybe(
  'Lydia account bridge: a historical account until the enrolled Business is validated (PostgreSQL)',
  () => {
    const schema = `lydia_bridge_it_${Math.random().toString(36).slice(2, 10)}`;
    let admin: Client;
    let ds: DataSource;
    let associations: AssociationsService;
    let products: ProductsService;
    let savedSecret: string | undefined;
    const tell = jest.fn(async (_asso: { id: string }, _kind: string, _to: string[]) => 1);
    const tellDelegation = jest.fn(
      async (_asso: { id: string }, _notice: string, _to: string[]) => 1
    );
    /**
     * The fake core-service: every `create-checkout-session` is recorded with the Business it names;
     * a token in `refusing` answers error 5 (nothing issued at Lydia), any other ISSUES a request.
     */
    const core = {
      calls: [] as string[],
      issued: [] as string[],
      refusing: new Set<string>(),
    };
    const post = (_url: string, body: { connectAccountId: string }): Observable<unknown> => {
      core.calls.push(body.connectAccountId);
      if (core.refusing.has(body.connectAccountId)) return throwError(error5);
      core.issued.push(body.connectAccountId);
      const n = core.issued.length;
      return of({
        data: {
          ok: true,
          url: `https://lydia.example/pay/${n}`,
          id: randomUUID(),
          requestId: `${n}`,
        },
      });
    };

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
        Submission,
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
      await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
      await admin.query(migration('119_lydia_cashiers_lot3.sql'));
      // TWICE: CD may replay it, and every statement is IF NOT EXISTS.
      await admin.query(migration('167_lydia_account_bridge.sql'));
      await admin.query(migration('167_lydia_account_bridge.sql'));
      // The ledger the link writes (lydia-contract-flux.ts).
      await admin.query(migration('168_lydia_enrolled_businesses.sql'));
      await admin.query('RESET lock_timeout');
      await admin.query(
        `CREATE TABLE users (id varchar(255) PRIMARY KEY, "firstName" text, "lastName" text,
         "displayName" text, admin boolean NOT NULL DEFAULT false)`
      );
      await admin.query(
        `INSERT INTO users (id, "firstName", admin) VALUES ('global-admin', 'Admin', true)`
      );
      savedSecret = process.env[SECRET_BOX_ENV];
      process.env[SECRET_BOX_ENV] = 'throwaway-encryption-secret-0123456789abcdef';

      const assoRepo = ds.getRepository(Association);
      for (const [id, extra] of [
        [BDE, {}],
        [LIST, { paymentParentAssociationId: BDE, paymentDelegationStatus: 'approved' }],
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
        lydiaNotifier: { enabled: () => true, tell, tellDelegation },
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
        httpService: { post },
        pricingFacts: { profileFor: () => Promise.resolve({ promo: null, formation: null }) },
        activePaymentProvider: () => Promise.resolve('lydia'),
      }) as unknown as ProductsService;

      // THE BDE's CASE, generic: its historical account was linked before the bridge, ready.
      await associations.setLydiaAccountId(BDE, HISTORICAL, null, HISTORICAL_KEY);
      await products.markLydiaReady(HISTORICAL, 'admin', { path: 'admin' });
      // The operator's step that puts the association on a bridge (docs/wiki/frontend/modules/
      // payments.md): one row naming the account that collects today.
      await ds.query(
        `INSERT INTO lydia_account_bridges ("associationId", "historicalVendorToken") VALUES ($1, $2)`,
        [BDE, HISTORICAL]
      );
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      if (savedSecret === undefined) delete process.env[SECRET_BOX_ENV];
      else process.env[SECRET_BOX_ENV] = savedSecret;
      await ds?.destroy();
      await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin?.end();
    });

    beforeEach(() => {
      core.calls = [];
      core.issued = [];
      core.refusing.clear();
      tell.mockClear();
      tellDelegation.mockClear();
    });

    const product = (associationId: string, name: string) =>
      ds.getRepository(AssociationProduct).save(
        ds.getRepository(AssociationProduct).create({
          associationId,
          name,
          type: 'other',
          amountCents: 1500,
          currency: 'eur',
          isActive: true,
        } as Partial<AssociationProduct>)
      );
    /** One checkout by a buyer seen for the first time, so no earlier attempt is settled first. */
    const buy = (associationId: string, productId: string) =>
      products.createCheckoutSession(associationId, productId, `buyer-${randomUUID()}`);
    const active = async () =>
      (
        await ds.query(
          `SELECT "lydiaAccountId" AS token, "lydiaOnboardingComplete" AS ready FROM associations WHERE id = $1`,
          [BDE]
        )
      )[0] as { token: string; ready: boolean };
    const bridge = async () =>
      (
        await ds.query(
          `SELECT state, "enrolledVendorToken" AS enrolled, "standbyReady", "standbyReadinessCause",
                "switchCount", "switchBackCount", "reissueCount"
           FROM lydia_account_bridges WHERE "associationId" = $1`,
          [BDE]
        )
      )[0] as {
        state: string;
        enrolled: string | null;
        standbyReady: boolean;
        standbyReadinessCause: string | null;
        switchCount: number;
        switchBackCount: number;
        reissueCount: number;
      };

    it('migration 167 ran twice and keeps two Businesses apart', async () => {
      await expect(
        ds.query(
          `INSERT INTO lydia_account_bridges ("associationId", "historicalVendorToken", "enrolledVendorToken")
         VALUES ($1, 'same', 'same')`,
          [LIST]
        )
      ).rejects.toThrow(/two_businesses/);
      await expect(
        ds.query(
          `INSERT INTO lydia_account_bridges ("associationId", "historicalVendorToken", state)
         VALUES ($1, 'x', 'switched')`,
          [LIST]
        )
      ).rejects.toThrow(/switched_names_enrolled/);
    });

    it('an enrolment while the historical account collects: the new Business is PENDING, the historical one still collects', async () => {
      // The historical account's key is not the managers' to see, even as a flag.
      await expect(associations.isLydiaBusinessKeySet(BDE)).resolves.toBe(false);
      await associations.claimLydiaEnrolment(BDE);
      await associations.recordLydiaEnrolmentVendorToken(BDE, ENROLLED);
      await associations.setLydiaAccountId(
        BDE,
        ENROLLED,
        'https://lydia.example/console',
        ENROLLED_KEY
      );
      expect(await active()).toEqual({ token: HISTORICAL, ready: true });
      expect(await bridge()).toMatchObject({ state: 'historical', enrolled: ENROLLED });
      // The PENDING Business is recorded as Canari-enrolled at its link (the platform's Lydia flux,
      // lydia-contract-flux.ts). This fixture installed the historical account through the same
      // link, which no production path does - the flux excludes it by its bridge anyway.
      const ledger = (await ds.query(`SELECT "vendorToken" FROM lydia_enrolled_businesses`)) as {
        vendorToken: string;
      }[];
      expect(ledger.map((r) => r.vendorToken)).toContain(ENROLLED);
      await expect(associations.isLydiaBusinessKeySet(BDE)).resolves.toBe(true);

      // The managers see the new Business only, not validated; the historical one is invisible.
      const managers = await associations.getPayoutAccount(BDE);
      expect(managers).toMatchObject({
        lydiaAccountId: ENROLLED,
        lydiaOnboardingComplete: false,
        enrolmentInFlightSince: null,
      });
      expect(managers.bridge).toBeUndefined();
      expect(JSON.stringify(managers)).not.toContain(HISTORICAL);
      const globalAdmin = await associations.getPayoutAccount(BDE, { isGlobalAdmin: true });
      expect(globalAdmin.bridge).toMatchObject({
        state: 'historical',
        historicalReady: true,
        enrolledLinked: true,
      });

      // A second enrolment while the first waits for Lydia: the typed 409.
      const second = await associations.claimLydiaEnrolment(BDE).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(ConflictException);
      expect((second as ConflictException).getResponse()).toMatchObject({
        code: LYDIA_BUSINESS_PENDING_VALIDATION,
      });
      // Both keys open, each by its own vendor token.
      await expect(associations.lydiaCallbackKey(HISTORICAL)).resolves.toBe(HISTORICAL_KEY);
      await expect(associations.lydiaCallbackKey(ENROLLED)).resolves.toBe(ENROLLED_KEY);
      await expect(associations.lydiaBusinessOfVendorToken(ENROLLED)).resolves.toMatchObject({
        associationId: BDE,
        role: 'pending',
      });
    });

    it('a payment while the Business is pending goes to the historical account, a delegate`s too', async () => {
      const own = await product(BDE, 'pending-own');
      const delegated = await product(LIST, 'pending-delegated');
      await buy(BDE, own.id);
      await buy(LIST, delegated.id);
      expect(core.calls).toEqual([HISTORICAL, HISTORICAL]);
    });

    it('the VALIDATED of the enrolled Business switches: the next payment goes to it, a replay switches nothing', async () => {
      const outcome = await products.markLydiaReady(ENROLLED, 'webhook-validated', {
        path: 'webhook',
      });
      expect(outcome).toMatchObject({ kind: 'transitioned', bridgeSwitched: true });
      expect(await active()).toEqual({ token: ENROLLED, ready: true });
      expect(await bridge()).toMatchObject({
        state: 'switched',
        standbyReady: true,
        switchCount: 1,
        switchBackCount: 0,
      });
      // No notice yet: an unsigned VALIDATED is not a proof. The delegate's collecting did not stop.
      expect(tell).not.toHaveBeenCalled();
      expect(tellDelegation).not.toHaveBeenCalled();
      await expect(
        products.markLydiaReady(ENROLLED, 'webhook-validated', { path: 'webhook' })
      ).resolves.toMatchObject({ kind: 'replay' });
      expect((await bridge()).switchCount).toBe(1);

      const own = await product(BDE, 'switched-own');
      const delegated = await product(LIST, 'switched-delegated');
      await buy(BDE, own.id);
      await buy(LIST, delegated.id);
      expect(core.calls).toEqual([ENROLLED, ENROLLED]);
      // The first request Lydia issued on it is the proof: the managers are told "active" ONCE.
      expect(tell.mock.calls.map(([asso, kind]) => [asso.id, kind])).toEqual([[BDE, 'active']]);
      expect(
        (await ds.query(`SELECT "enrolledProvenAt" FROM lydia_account_bridges`))[0].enrolledProvenAt
      ).not.toBeNull();
      // The historical key still opens by its token, to refund what that account took.
      await expect(associations.lydiaCallbackKey(HISTORICAL)).resolves.toBe(HISTORICAL_KEY);
      await expect(associations.lydiaBusinessOfVendorToken(HISTORICAL)).resolves.toMatchObject({
        associationId: BDE,
        role: 'retired',
      });
      // The managers now see the new Business validated, and nothing of the old one.
      const managers = await associations.getPayoutAccount(BDE);
      expect(managers).toMatchObject({ lydiaAccountId: ENROLLED, lydiaOnboardingComplete: true });
      expect(JSON.stringify(managers)).not.toContain(HISTORICAL);
    });

    it('a FORGED VALIDATED: error 5 switches back and the SAME purchase is issued on the historical account - ONE request at Lydia', async () => {
      // State: switched by the VALIDATED above, which Lydia did not mean - its Business answers 5.
      core.refusing.add(ENROLLED);
      await ds.query(`DELETE FROM post_notifications`);
      const item = await product(BDE, 'forged');
      const opened = await buy(BDE, item.id);
      // Two calls to core, ONE request at Lydia: error 5 is answered before any request exists.
      expect(core.calls).toEqual([ENROLLED, HISTORICAL]);
      expect(core.issued).toEqual([HISTORICAL]);
      const attempts = await ds.query(
        `SELECT id, status, "vendorToken" FROM product_checkouts WHERE "productId" = $1 ORDER BY "createdAt"`,
        [item.id]
      );
      expect(attempts.map((a: { status: string }) => a.status)).toEqual(['cancelled', 'open']);
      expect(attempts[1]).toMatchObject({ id: opened.checkoutId, vendorToken: HISTORICAL });
      expect(await active()).toEqual({ token: HISTORICAL, ready: true });
      expect(await bridge()).toMatchObject({
        state: 'historical',
        enrolled: ENROLLED,
        standbyReady: false,
        standbyReadinessCause: 'request-refused',
        switchCount: 1,
        switchBackCount: 1,
        reissueCount: 1,
      });
      // The global admins' bell row, marked as a switch back; payments did not stop, so the delegate
      // is told nothing - the managers, told "active" once it proved itself, get the counter-notice.
      expect(
        await ds.query(`SELECT "recipientId", type, meta FROM post_notifications WHERE type = $1`, [
          LYDIA_PAYMENTS_PAUSED_TYPE,
        ])
      ).toEqual([
        {
          recipientId: 'global-admin',
          type: LYDIA_PAYMENTS_PAUSED_TYPE,
          meta: expect.objectContaining({ cause: 'request-refused', bridge: 'switched-back' }),
        },
      ]);
      expect(tell.mock.calls.map(([asso, kind]) => [asso.id, kind])).toEqual([[BDE, 'paused']]);
      expect(tellDelegation).not.toHaveBeenCalled();
      // The managers see their Business waiting for Lydia again.
      expect(await associations.getPayoutAccount(BDE)).toMatchObject({
        lydiaAccountId: ENROLLED,
        lydiaOnboardingComplete: false,
      });

      // Lydia refused it: a later UNSIGNED VALIDATED is held, only a global admin switches again.
      core.refusing.clear();
      await expect(
        products.markLydiaReady(ENROLLED, 'webhook-validated', { path: 'webhook' })
      ).resolves.toMatchObject({ kind: 'held-by-lydia', previousCause: 'request-refused' });
      expect(await bridge()).toMatchObject({ state: 'historical', switchCount: 1 });
      await expect(
        products.markLydiaReady(ENROLLED, 'admin', { path: 'admin' })
      ).resolves.toMatchObject({ kind: 'transitioned', bridgeSwitched: true });
      expect(await bridge()).toMatchObject({ state: 'switched', switchCount: 2 });
    });

    /** Back to the historical account, if switched: one purchase meeting error 5 switches back. */
    const switchBack = async (name: string) => {
      if ((await bridge()).state !== 'switched') return;
      core.refusing.add(ENROLLED);
      await buy(BDE, (await product(BDE, name)).id);
      core.refusing.clear();
    };

    it('a STREAM of forged VALIDATED during purchases: held after the first switch back, every purchase issued on the historical account', async () => {
      // The switch above was never proven: its switch back tells the managers nothing.
      tell.mockClear();
      await switchBack('stream-back');
      expect(tell).not.toHaveBeenCalled();
      const before = await bridge();
      expect(before).toMatchObject({
        state: 'historical',
        standbyReadinessCause: 'request-refused',
      });
      core.calls = [];
      core.issued = [];
      const items = await Promise.all(
        [BDE, LIST, BDE, LIST].map((id, i) => product(id, `stream-${i}`))
      );
      const forged = Array.from({ length: 10 }, () =>
        products.markLydiaReady(ENROLLED, 'webhook-validated', { path: 'webhook' })
      );
      const [outcomes] = await Promise.all([
        Promise.all(forged),
        Promise.all(items.map((item) => buy(item.associationId, item.id))),
      ]);
      expect(new Set(outcomes.map((o) => o.kind))).toEqual(new Set(['held-by-lydia']));
      // Not one purchase failed, met the enrolled Business, or was re-issued.
      expect(core.calls).toEqual([HISTORICAL, HISTORICAL, HISTORICAL, HISTORICAL]);
      expect(core.issued).toHaveLength(4);
      expect(await bridge()).toEqual(before);
      expect(tell).not.toHaveBeenCalled();
    });

    it('a Business Lydia BLOCKED is never switched onto by an unsigned VALIDATED', async () => {
      expect((await bridge()).state).toBe('historical');
      // A 2701 naming the pending Business is recorded on it.
      await associations.revertLydiaReadinessAfterRefusal(ENROLLED, 'request-blocked', {
        path: 'shop',
        id: 'late-2701',
      });
      expect((await bridge()).standbyReadinessCause).toBe('request-blocked');
      await expect(
        products.markLydiaReady(ENROLLED, 'webhook-validated', { path: 'webhook' })
      ).resolves.toMatchObject({ kind: 'held-by-lydia', previousCause: 'request-blocked' });
      expect(await active()).toEqual({ token: HISTORICAL, ready: true });
    });

    it('the enrolled Business that took payments cannot be unlinked: its key stays for their callbacks and refunds', async () => {
      expect((await bridge()).state).toBe('historical');
      // It collected while switched (the proof above): those checkouts name it.
      const refusal = await associations.clearLydiaAccount(BDE).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: LYDIA_BUSINESS_HOLDS_PAYMENTS,
      });
      expect(await bridge()).toMatchObject({ enrolled: ENROLLED });
      await expect(associations.lydiaCallbackKey(ENROLLED)).resolves.toBe(ENROLLED_KEY);
    });

    it('a switch committed while a purchase is prepared: the typed ROUTING_CHANGED under the lock, NO request', async () => {
      for (const [associationId, name] of [
        [BDE, 'raced-own'],
        [LIST, 'raced-delegated'],
      ] as const) {
        await switchBack(`${name}-back`);
        expect((await bridge()).state).toBe('historical');
        core.calls = [];
        const item = await product(associationId, name);
        const prepare = (products as any).preparePurchase.bind(products);
        const spy = jest
          .spyOn(products as any, 'preparePurchase')
          .mockImplementationOnce(async (...args: unknown[]) => {
            const prepared = await prepare(...args);
            // The VALIDATED commits between the purchase's preparation and its decision.
            await products.markLydiaReady(ENROLLED, 'admin', { path: 'admin' });
            return prepared;
          });
        const refusal = await buy(associationId, item.id).catch((e: unknown) => e);
        spy.mockRestore();
        // The account prepared is no longer the one that collects: refused before any row or request
        // - the payer retries, and the retry goes to the new Business.
        expect(refusal).toBeInstanceOf(ConflictException);
        expect((refusal as ConflictException).getResponse()).toMatchObject({
          code: 'PAYMENT_ROUTING_CHANGED',
        });
        expect(core.calls).toEqual([]);
        expect(
          await ds.query(`SELECT id FROM product_checkouts WHERE "productId" = $1`, [item.id])
        ).toEqual([]);
        await buy(associationId, item.id);
        expect(core.calls).toEqual([ENROLLED]);
      }
    });

    it('a switch racing purchases on separate connections: each is issued on the Business its row names, or refused unissued', async () => {
      for (let round = 0; round < 5; round++) {
        await switchBack(`race-back-${round}`);
        core.calls = [];
        const items = await Promise.all(
          [BDE, LIST, BDE, LIST].map((id, i) => product(id, `race-${round}-${i}`))
        );
        const settled = await Promise.allSettled([
          products.markLydiaReady(ENROLLED, 'admin', { path: 'admin' }),
          ...items.map((item) => buy(item.associationId, item.id)),
        ]);
        // A purchase refused by the race is refused with the routing code, and nothing else.
        const refusals = settled
          .slice(1)
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => ((r.reason as ConflictException).getResponse() as { code?: string }).code);
        expect(refusals.filter((code) => code !== 'PAYMENT_ROUTING_CHANGED')).toEqual([]);
        const rows: Array<{ vendorToken: string; requestUuid: string | null }> = await ds.query(
          `SELECT "vendorToken", "requestUuid" FROM product_checkouts WHERE "productId" = ANY($1)`,
          [items.map((i) => i.id)]
        );
        // Every request issued names the Business its row names, once; a refusal wrote no row.
        expect(rows).toHaveLength(settled.slice(1).filter((r) => r.status === 'fulfilled').length);
        expect([...core.calls].sort()).toEqual(rows.map((r) => r.vendorToken).sort());
        expect(rows.every((r) => r.requestUuid !== null)).toBe(true);
        expect(await active()).toEqual({ token: ENROLLED, ready: true });
        expect((await bridge()).state).toBe('switched');
      }
    });

    it('three purchases meeting error 5 at once: ONE switch back, each purchase issued ONCE on the historical account', async () => {
      if ((await bridge()).state !== 'switched') {
        await products.markLydiaReady(ENROLLED, 'admin', { path: 'admin' });
      }
      const before = await bridge();
      core.refusing.add(ENROLLED);
      core.calls = [];
      const items = await Promise.all(
        [BDE, LIST, BDE].map((id, i) => product(id, `error5-race-${i}`))
      );
      await Promise.all(items.map((item) => buy(item.associationId, item.id)));
      // Each purchase met error 5 at most once and was issued exactly once, on the historical account.
      expect(core.issued).toEqual([HISTORICAL, HISTORICAL, HISTORICAL]);
      expect(core.calls.filter((t) => t === ENROLLED).length).toBeLessThanOrEqual(3);
      const after = await bridge();
      expect(after.state).toBe('historical');
      expect(after.switchBackCount).toBe(before.switchBackCount + 1);
      expect(after.reissueCount - before.reissueCount).toBe(
        core.calls.filter((t) => t === ENROLLED).length
      );
      core.refusing.clear();
    });

    it('a VALIDATED naming a Business nobody holds is no-holder, the bridge untouched', async () => {
      const before = await bridge();
      // (BUSINESS_UNVALIDATED never reaches social-service: core logs it, webhook.controller.ts.)
      await expect(
        products.markLydiaReady('vendor-token-nobody', 'webhook-validated', { path: 'webhook' })
      ).resolves.toMatchObject({ kind: 'no-holder' });
      expect(await bridge()).toEqual(before);
    });

    it('a 2701 on the switched-to Business is the ordinary pause, never a switch back', async () => {
      if ((await bridge()).state !== 'switched') {
        await products.markLydiaReady(ENROLLED, 'admin', { path: 'admin' });
      }
      const switchBacks = (await bridge()).switchBackCount;
      await expect(
        associations.revertLydiaReadinessAfterRefusal(ENROLLED, 'request-blocked', {
          path: 'shop',
          id: 'blocked',
        })
      ).resolves.toBe(false);
      expect(await active()).toEqual({ token: ENROLLED, ready: false });
      expect(await bridge()).toMatchObject({ state: 'switched', switchBackCount: switchBacks });
    });
  }
);
