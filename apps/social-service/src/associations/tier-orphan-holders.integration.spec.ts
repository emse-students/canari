/**
 * A COTISATION TIER DELETED WHILE PEOPLE STILL HOLD IT, AGAINST A REAL POSTGRESQL.
 *
 * Every tier read derives a holder's tier from the membership products that exist, so a tier
 * product deleted under its holders left them holding a tag that named nothing: ranked as holding
 * no tier, they could buy any tier, a cheaper one included, and the sibling XOR never revoked the
 * tag. Two halves, both proven here (docs/wiki/cotisations.md "A tier deleted while people still
 * hold it"):
 *
 * - deleting a tier people hold is refused `409 TIER_HAS_HOLDERS`, under the association's tier
 *   lock EXCLUSIVE, so a grant in flight is counted;
 * - a tag of a tier already gone is read by NAME: it is a held tier with no price (`unranked`), and
 *   the sibling XOR revokes it.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- tier-orphan-holders.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
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
import { ProductsService } from './products.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000b7';
const SLUG = 'orph-it';
const LOW = '00000000-0000-4000-8000-0000000000d1';
const HIGH = '00000000-0000-4000-8000-0000000000d2';
/** Each delete test gets a tier of its own, so a deletion never changes another test's catalogue. */
const HELD = '00000000-0000-4000-8000-0000000000d3';
const UNHELD = '00000000-0000-4000-8000-0000000000d4';
const RACED = '00000000-0000-4000-8000-0000000000d5';
const WAITED = '00000000-0000-4000-8000-0000000000d6';
/** A tier of ASSO whose tag stem is ANOTHER association's base stem (its slug extends ASSO's). */
const CROSSED = '00000000-0000-4000-8000-0000000000d7';
const OTHER_ASSO = '00000000-0000-4000-8000-0000000000b8';
const OTHER_BASE = '00000000-0000-4000-8000-0000000000d8';
const tag = (key: string) => `cotisant:${SLUG}-${key}`;
/** The tag of a tier that no longer exists, as a row written before deleting one was refused. */
const GONE = tag('gone');

maybe('a tier deleted while people still hold it (PostgreSQL)', () => {
  const schema = `tier_orphan_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ProductsService;
  let tags: UserTagService;
  let buyerSeq = 0;

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
    await ds.query(
      readFileSync(join(__dirname, '../migrations/101_product_checkouts.sql'), 'utf8')
    );
    // On the admin connection: their `SET lock_timeout` must not stay on a pool connection that
    // later waits on an advisory lock.
    for (const name of [
      '112_product_checkouts_held_tier.sql',
      '113_purchase_record_closings.sql',
    ]) {
      await admin.query(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
    }
    await admin.query('RESET lock_timeout');

    await ds.getRepository(Association).save(
      ds.getRepository(Association).create({
        id: ASSO,
        name: 'Orphan IT',
        slug: SLUG,
        createdBy: 'it',
        cotisationEnabled: true,
        cotisationMode: 'lifetime',
      } as Partial<Association>)
    );
    for (const [id, variantKey, amountCents] of [
      [LOW, 'low', 1000],
      [HIGH, 'high', 3000],
      [HELD, 'held', 2000],
      [UNHELD, 'unheld', 2000],
      [RACED, 'raced', 2000],
      [WAITED, 'waited', 2000],
      [CROSSED, 'xb', 2000],
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
          grantedTagName: tag(variantKey),
        })
      );
    }

    // Another association whose slug extends this one's: its base tag is `cotisant:orph-it-xb`,
    // the very name tier `xb` of ASSO derives.
    await ds.getRepository(Association).save(
      ds.getRepository(Association).create({
        id: OTHER_ASSO,
        name: 'Other IT',
        slug: `${SLUG}-xb`,
        createdBy: 'it',
        cotisationEnabled: true,
        cotisationMode: 'lifetime',
      } as Partial<Association>)
    );
    await ds.getRepository(AssociationProduct).save(
      ds.getRepository(AssociationProduct).create({
        id: OTHER_BASE,
        associationId: OTHER_ASSO,
        name: 'Other base',
        type: 'membership',
        variantKey: null,
        amountCents: 1000,
        currency: 'eur',
        isActive: true,
        grantedTagName: `cotisant:${SLUG}-xb`,
      })
    );

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
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const newBuyer = () => `orphan-${String(++buyerSeq).padStart(2, '0')}`.padEnd(64, '0');

  const giveTag = (userId: string, tagName: string) =>
    admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [userId, tagName, ASSO]
    );

  const heldTags = async (userId: string) =>
    (
      (await ds.query(`SELECT "tagName" FROM user_tags WHERE "userId" = $1 ORDER BY 1`, [
        userId,
      ])) as { tagName: string }[]
    ).map((r) => r.tagName);

  const productExists = async (id: string) =>
    (await ds.query(`SELECT 1 FROM association_products WHERE id = $1`, [id])).length === 1;

  const settled = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ value, error: null as unknown }),
      (e: unknown) => ({ value: null as T | null, error: e })
    );

  const conflictBody = (e: unknown) =>
    (e as ConflictException).getResponse() as { code: string; holderCount?: number };

  /**
   * Reads `pg_locks` until `n` OTHER sessions wait on the advisory lock of `key` (its one-key 64-bit
   * form: `classid` the high half, `objid` the low half, `objsubid` 1), or a bounded number of reads
   * has gone by; answers the last count. Filtered on the key and on another backend, so a parallel
   * spec waiting on some other lock cannot stand in for the wait under test. A read loop, never a
   * clock.
   */
  async function advisoryWaiters(key: string, n: number): Promise<number> {
    let waiting = 0;
    for (let i = 0; i < 10_000 && waiting < n; i++) {
      const [row] = (
        await admin.query(
          `WITH k AS (SELECT hashtextextended($1, 0) AS h)
           SELECT count(*)::int AS n FROM pg_locks, k
            WHERE NOT granted AND locktype = 'advisory' AND pid <> pg_backend_pid()
              AND objsubid = 1
              AND classid::bigint = ((k.h >> 32) & 4294967295)
              AND objid::bigint = (k.h & 4294967295)`,
          [key]
        )
      ).rows as { n: number }[];
      waiting = row.n;
    }
    return waiting;
  }

  it('refuses to delete a tier people hold: 409 TIER_HAS_HOLDERS with the count, nothing deleted', async () => {
    await giveTag(newBuyer(), tag('held'));
    await giveTag(newBuyer(), tag('held'));
    // An EXPIRED holder is not counted.
    await admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy", "expiresAt")
       VALUES ($1, $2, $3, 'it', now() - interval '1 day')`,
      [newBuyer(), tag('held'), ASSO]
    );

    const { error } = await settled(service.delete(ASSO, HELD));

    expect(error).toBeInstanceOf(ConflictException);
    expect(conflictBody(error)).toMatchObject({ code: 'TIER_HAS_HOLDERS', holderCount: 2 });
    expect(await productExists(HELD)).toBe(true);
  });

  it('CONTROL: deletes a tier nobody holds', async () => {
    await service.delete(ASSO, UNHELD);
    expect(await productExists(UNHELD)).toBe(false);
  });

  it('a delete waits for a grant in flight, then counts it and refuses', async () => {
    const buyer = newBuyer();
    // A per-buyer path's locks, in its order: the association SHARED, then the buyer.
    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [
      `tier:${ASSO}`,
    ]);
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `tier:${ASSO}:${buyer}`,
    ]);
    await giveTag(buyer, tag('waited'));
    const deletion = settled(service.delete(ASSO, WAITED));
    // The delete waits on the association key, held shared above, which it wants exclusive.
    const waited = await advisoryWaiters(`tier:${ASSO}`, 1);
    await admin.query('COMMIT');
    const { error } = await deletion;

    expect(waited).toBe(1);
    expect(conflictBody(error)).toMatchObject({ code: 'TIER_HAS_HOLDERS', holderCount: 1 });
    expect(await productExists(WAITED)).toBe(true);
  });

  it('a delete racing a settlement of the same tier never leaves a tag naming a deleted tier', async () => {
    const buyer = newBuyer();
    const attempt = await ds.getRepository(ProductCheckout).save(
      ds.getRepository(ProductCheckout).create({
        productId: RACED,
        userId: buyer,
        associationId: ASSO,
        paymentAssociationId: ASSO,
        vendorToken: 'vendor-test',
        amountCents: 2000,
        currency: 'eur',
        productName: 'Tier raced',
        requestUuid: null,
        requestId: 'raced-1',
        status: 'open',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        settledAt: null,
        purchaseRecordId: null,
      })
    );

    const [deletion] = await Promise.all([
      settled(service.delete(ASSO, RACED)),
      (service as any).settlePaidCheckout(attempt.id) as Promise<void>,
    ]);

    const [record] = await ds.query(`SELECT status FROM purchase_records WHERE "userId" = $1`, [
      buyer,
    ]);
    const outcome = {
      tierExists: await productExists(RACED),
      deleteRefused: deletion.error === null ? null : conflictBody(deletion.error).code,
      held: await heldTags(buyer),
      payment: record.status as string,
    };
    // Either serial order refuses the delete and grants the tier paid for: settled first, the buyer
    // holds it; deleted first, the open attempt refuses the delete. Never a refund owed, never a
    // tag naming a deleted tier.
    expect([
      {
        tierExists: true,
        deleteRefused: 'TIER_HAS_HOLDERS',
        held: [tag('raced')],
        payment: 'paid',
      },
      {
        tierExists: true,
        deleteRefused: 'TIER_CHECKOUT_OPEN',
        held: [tag('raced')],
        payment: 'paid',
      },
    ]).toContainEqual(outcome);
  });

  it('a holder of a DELETED tier is refused a lower tier, TIER_NOT_RANKABLE, and no attempt opens', async () => {
    const buyer = newBuyer();
    await giveTag(buyer, GONE);

    const { error } = await settled(service.createCheckoutSession(ASSO, LOW, buyer));

    expect(conflictBody(error).code).toBe('TIER_NOT_RANKABLE');
    expect(await ds.query(`SELECT id FROM product_checkouts WHERE "userId" = $1`, [buyer])).toEqual(
      []
    );
    // The paid form's pre-check reads the same rank.
    expect(await tags.rankCotisationTier(ASSO, buyer, 'low')).toBe('unranked');
    expect(await tags.rankCotisationTier(ASSO, buyer, 'high')).toBe('unranked');
    expect(await tags.grantCotisantIfARise(ASSO, buyer, 'form', 'low', {})).toEqual({
      refused: 'unranked',
    });
    expect(await heldTags(buyer)).toEqual([GONE]);
  });

  it("a manager's grant swaps the tag of a DELETED tier out, and touches no other issuer's row", async () => {
    const buyer = newBuyer();
    await giveTag(buyer, GONE);
    // The same name issued by nobody: not this association's row, so not its to revoke.
    const stranger = newBuyer();
    await admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, NULL, 'it')`,
      [stranger, GONE]
    );

    await tags.grantCotisant(ASSO, buyer, 'manager', 'low');
    await tags.grantCotisant(ASSO, stranger, 'manager', 'low');

    expect(await heldTags(buyer)).toEqual([tag('low')]);
    expect(await heldTags(stranger)).toEqual([GONE, tag('low')]);
  });

  it('the legacy claim grants its tier over the tag of a DELETED tier, and swaps it out', async () => {
    const buyer = newBuyer();
    await giveTag(buyer, GONE);

    expect(await tags.grantCotisantUnlessHeld(ASSO, buyer, 'legacy', 'low', {})).toMatchObject({
      tagName: tag('low'),
    });
    expect(await heldTags(buyer)).toEqual([tag('low')]);
  });

  it('a raw grant in the cotisant namespace that is not one of its own tier tags is refused', async () => {
    const buyer = newBuyer();
    const refused = await settled(
      tags.grantTagForAssociation(ASSO, { userId: buyer, tagName: GONE, grantedBy: 'manager' })
    );
    expect(refused.error).toBeInstanceOf(ForbiddenException);
    expect(((refused.error as ForbiddenException).getResponse() as { code: string }).code).toBe(
      'TAG_NOT_ISSUER_TIER'
    );
    expect(await heldTags(buyer)).toEqual([]);
  });

  it("a count that crosses associations: another association's holders neither block a delete nor are told", async () => {
    // Held under the other association's base tier - the same name tier `xb` of ASSO derives.
    await ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [newBuyer(), `cotisant:${SLUG}-xb`, OTHER_ASSO]
    );
    expect(await tags.countActiveTierHolders(ASSO, SLUG, 'xb', ds.manager)).toBe(0);
    // A row no association issued is held for nobody here (every tier read is issuer-scoped) and
    // no manager can revoke it, so it does not block either.
    const unissued = newBuyer();
    await admin.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, NULL, 'it')`,
      [unissued, `cotisant:${SLUG}-xb`]
    );
    expect(await tags.countActiveTierHolders(ASSO, SLUG, 'xb', ds.manager)).toBe(0);
    await admin.query(`DELETE FROM user_tags WHERE "userId" = $1`, [unissued]);

    await service.delete(ASSO, CROSSED);

    expect(await productExists(CROSSED)).toBe(false);
  });

  it('the hourly report counts every active orphan row, and only those', async () => {
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM user_tags
        WHERE "tagName" = $1 AND "issuingAssocId" = $2
          AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
      [GONE, ASSO]
    );
    expect(n).toBeGreaterThan(0);
    // The other association's base tag is its own tier, not an orphan of either.
    expect(await tags.countOrphanTierTags()).toBe(n);
  });
});
