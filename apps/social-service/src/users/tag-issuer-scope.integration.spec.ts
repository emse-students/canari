/**
 * A TAG GRANT IS SCOPED TO THE ASSOCIATION THAT GRANTS IT, AGAINST A REAL POSTGRESQL.
 *
 * Two halves of one invariant. A raw tag grant (`UserTagService.grantTagForAssociation`) accepts only
 * a name in the granting association's own namespace, resolved by the `associations` table (the
 * longest slug wins). And every tier-holding read - the listings' relation and price, the rank a
 * grant applies, the cotisant status, the held-tier lists - counts only rows ISSUED by the tier's own
 * association, while the sibling-tier XOR deletes only that association's rows.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- tag-issuer-scope.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { AssociationProduct } from '../associations/entities/association-product.entity';
import { Association } from '../associations/entities/association.entity';
import { ProductsService } from '../associations/products.service';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from './entities/purchase-record.entity';
import { UserTag } from './entities/user-tag.entity';
import { PurchaseRecordService } from './purchase-record.service';
import { TAG_OUTSIDE_ISSUER_NAMESPACE, UserTagService } from './user-tag.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** The association whose tiers are under test. */
const OWN = '00000000-0000-4000-8000-0000000000e1';
/** Another association, with its own (unrelated) cotisation. */
const OTHER = '00000000-0000-4000-8000-0000000000e2';
/** An association whose slug EXTENDS `OWN`'s, so its namespace sits inside `OWN`'s prefix. */
const LONGER = '00000000-0000-4000-8000-0000000000e3';
const TIER_A = '00000000-0000-4000-8000-0000000000f1';
const TIER_B = '00000000-0000-4000-8000-0000000000f2';
const TAG_A = 'cotisant:scope-it-a';
const TAG_B = 'cotisant:scope-it-b';

maybe('a tag grant is scoped to the association that grants it (PostgreSQL)', () => {
  const schema = `tag_scope_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let products: ProductsService;
  let tags: UserTagService;
  let userSeq = 0;

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

    const assos = ds.getRepository(Association);
    for (const [id, slug] of [
      [OWN, 'scope-it'],
      [OTHER, 'autre-it'],
      [LONGER, 'scope-it-annexe'],
    ] as const) {
      await assos.save(
        assos.create({
          id,
          name: slug,
          slug,
          createdBy: 'it',
          cotisationEnabled: true,
          cotisationMode: 'lifetime',
        } as Partial<Association>)
      );
    }
    // Tier B carries a preferential price for holders of tier A: what a rise from A costs.
    const productRepo = ds.getRepository(AssociationProduct);
    for (const [id, variantKey, amountCents, preferential] of [
      [TIER_A, 'a', 1500, null],
      [TIER_B, 'b', 3000, TAG_A],
    ] as const) {
      await productRepo.save(
        productRepo.create({
          id,
          associationId: OWN,
          name: `Tier ${variantKey}`,
          type: 'membership',
          variantKey,
          amountCents,
          amountCentsMember: preferential ? 1500 : null,
          memberPriceTag: preferential,
          currency: 'eur',
          isActive: true,
          grantedTagName: `cotisant:scope-it-${variantKey}`,
        })
      );
    }

    tags = new UserTagService(ds.getRepository(UserTag));
    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      checkoutRepo: ds.getRepository(ProductCheckout),
      productRepo,
      assoRepo: assos,
      purchaseRecordService: new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      userTagService: tags,
      config: { get: () => undefined },
      pricingFacts: { profileFor: () => Promise.resolve({ promo: null, formation: null }) },
    }) as unknown as ProductsService;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /** A fresh user per test, so no test reads another's tags. */
  const newUser = () => `scope-user-${++userSeq}`.padEnd(64, '0');

  /** Writes a tag row as `issuer` issued it, bypassing every grant path. */
  const issuedBy = (userId: string, tagName: string, issuer: string | null) =>
    ds.query(
      `INSERT INTO user_tags ("userId", "tagName", "issuingAssocId", "grantedBy") VALUES ($1, $2, $3, 'it')`,
      [userId, tagName, issuer]
    );

  const rowsOf = async (userId: string) =>
    (await ds.query(
      `SELECT "tagName", "issuingAssocId" FROM user_tags WHERE "userId" = $1 ORDER BY 1, 2`,
      [userId]
    )) as { tagName: string; issuingAssocId: string | null }[];

  /** The tiers' relation and due amount in the association's own listing, for `userId`. */
  const listed = async (userId: string) => {
    const rows = await products.listByAssoc(OWN, userId);
    const of = (id: string) => {
      const p = rows.find((r) => r.id === id)!;
      return { relation: p.viewerTierRelation, due: p.viewerDueCents };
    };
    return { a: of(TIER_A), b: of(TIER_B) };
  };

  describe('the raw grant', () => {
    it("refuses a name in another association's namespace, and writes nothing", async () => {
      const user = newUser();

      const refused = tags.grantTagForAssociation(OTHER, {
        userId: user,
        tagName: TAG_B,
        grantedBy: 'it',
      });

      await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refused).rejects.toMatchObject({
        response: { code: TAG_OUTSIDE_ISSUER_NAMESPACE },
      });
      expect(await rowsOf(user)).toEqual([]);
    });

    it('refuses a name inside a LONGER slug that belongs to another association', async () => {
      const user = newUser();

      await expect(
        tags.grantTagForAssociation(OWN, {
          userId: user,
          tagName: 'cotisant:scope-it-annexe-2026-2027',
          grantedBy: 'it',
        })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await rowsOf(user)).toEqual([]);
    });

    it("refuses a name in no association's namespace", async () => {
      const user = newUser();

      await expect(
        tags.grantTagForAssociation(OWN, { userId: user, tagName: 'vip:nobody', grantedBy: 'it' })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await rowsOf(user)).toEqual([]);
    });

    it('grants a name in its own namespace, issued by itself, and that tag then holds the tier', async () => {
      const user = newUser();

      await tags.grantTagForAssociation(OWN, { userId: user, tagName: TAG_A, grantedBy: 'it' });

      expect(await rowsOf(user)).toEqual([{ tagName: TAG_A, issuingAssocId: OWN }]);
      expect(await listed(user)).toEqual({
        a: { relation: 'held', due: null },
        b: { relation: 'higher', due: 1500 },
      });
    });
  });

  describe('a tag of the same name issued by another association holds no tier here', () => {
    it('neither for the listing, nor its price, nor the cotisant status', async () => {
      const user = newUser();
      await issuedBy(user, TAG_A, OTHER);

      expect(await listed(user)).toEqual({
        a: { relation: 'none', due: 1500 },
        b: { relation: 'none', due: 3000 },
      });
      const own = (await ds.getRepository(Association).findOneByOrFail({ id: OWN }))!;
      expect(await products.isBuyerCotisant(own, user)).toBe(false);
      expect(await products.getCotisantStatusBySlug('scope-it', user)).toEqual({
        isCotisant: false,
        tier: null,
        expiresAt: null,
      });
      expect(await tags.holdsAnyCotisation(user, OWN)).toBe(false);
      expect(await tags.listHeldCotisationTiers(user, OWN)).toEqual([]);
      expect((await tags.heldCotisationTiersByAssociation(user, [OWN])).get(OWN)).toEqual([]);
    });

    it('nor for the rank of a grant, whose XOR leaves the other association its row', async () => {
      const user = newUser();
      // The dearer tier's name, issued elsewhere: were it counted, A would be refused as `lower`.
      await issuedBy(user, TAG_B, OTHER);

      const outcome = await tags.grantCotisantIfARise(OWN, user, 'it', 'a', {});

      expect(outcome).toMatchObject({ granted: { tagName: TAG_A, issuingAssocId: OWN } });
      expect(await rowsOf(user)).toEqual([
        { tagName: TAG_A, issuingAssocId: OWN },
        { tagName: TAG_B, issuingAssocId: OTHER },
      ]);
    });

    it('nor with no issuer at all', async () => {
      const user = newUser();
      await issuedBy(user, TAG_A, null);

      expect(await listed(user)).toEqual({
        a: { relation: 'none', due: 1500 },
        b: { relation: 'none', due: 3000 },
      });
      expect(await tags.holdsAnyCotisation(user, OWN)).toBe(false);
    });
  });

  it("the sibling XOR still swaps the association's OWN tier, and only that", async () => {
    const user = newUser();
    await tags.grantCotisant(OWN, user, 'it', 'a');

    await tags.grantCotisant(OWN, user, 'it', 'b');

    expect(await rowsOf(user)).toEqual([{ tagName: TAG_B, issuingAssocId: OWN }]);
    expect(await listed(user)).toEqual({
      a: { relation: 'lower', due: null },
      b: { relation: 'held', due: null },
    });
  });
});
