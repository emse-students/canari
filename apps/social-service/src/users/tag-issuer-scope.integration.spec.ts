/**
 * A TAG GRANT IS SCOPED TO THE ASSOCIATION THAT GRANTS IT, AGAINST A REAL POSTGRESQL.
 *
 * A raw tag grant (`UserTagService.grantTagForAssociation`) accepts only one of the granting
 * association's own tier tags, and is then the roster's manual add. Every tier-holding read - the
 * listings' relation and price, the rank a grant applies, the cotisant status, the held-tier lists -
 * counts only rows ISSUED by the tier's own association, the sibling-tier XOR deletes only that
 * association's rows, and no grant path renews or takes over a row of the same name issued
 * elsewhere: it is refused by type, and a payment is recorded paid but not granted. A new
 * cotisation stem that could coincide with another association's tag names is refused, and so is a
 * retag onto a name a holder already holds.
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
import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { AssociationProduct } from '../associations/entities/association-product.entity';
import { Association } from '../associations/entities/association.entity';
import {
  assertCotisationStemFree,
  COTISATION_TAG_COLLISION,
  TIER_TAG_NAME_TAKEN,
} from '../associations/cotisation-namespace';
import { ProductsService } from '../associations/products.service';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from './entities/purchase-record.entity';
import { UserTag } from './entities/user-tag.entity';
import { PurchaseRecordService } from './purchase-record.service';
import {
  TAG_HELD_BY_ANOTHER_ISSUER,
  TAG_NOT_ISSUER_TIER,
  TagHeldByAnotherIssuerError,
  UserTagService,
} from './user-tag.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** The association whose tiers are under test. */
const OWN = '00000000-0000-4000-8000-0000000000e1';
/** Another association, with its own (unrelated) cotisation. */
const OTHER = '00000000-0000-4000-8000-0000000000e2';
/** An association whose slug EXTENDS `OWN`'s. */
const LONGER = '00000000-0000-4000-8000-0000000000e3';
const TIER_A = '00000000-0000-4000-8000-0000000000f1';
const TIER_B = '00000000-0000-4000-8000-0000000000f2';
/** Retagged (or refused a retag) by its own tests, so no other test depends on its key. */
const TIER_C = '00000000-0000-4000-8000-0000000000f3';
const TAG_A = 'cotisant:scope-it-a';
const TAG_B = 'cotisant:scope-it-b';
const TAG_C = 'cotisant:scope-it-c';

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
      [TIER_C, 'c', 4000, null],
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
      httpService: { post: () => of({ data: { ok: true } }) },
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

  /** Writes a tag row as `issuer` issued it, directly in the table. */
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
    const notATier = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({ response: { code: TAG_NOT_ISSUER_TIER } });

    it("refuses another association's tier tag, and writes nothing", async () => {
      const user = newUser();

      const refused = tags.grantTagForAssociation(OTHER, {
        userId: user,
        tagName: TAG_B,
        grantedBy: 'it',
      });

      await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
      await notATier(refused);
      expect(await rowsOf(user)).toEqual([]);
    });

    it('refuses a name that is none of its own tier tags', async () => {
      const user = newUser();

      await notATier(
        tags.grantTagForAssociation(OWN, {
          userId: user,
          tagName: 'cotisant:scope-it-annexe',
          grantedBy: 'it',
        })
      );
      await notATier(
        tags.grantTagForAssociation(OWN, { userId: user, tagName: 'vip:scope-it', grantedBy: 'it' })
      );
      expect(await rowsOf(user)).toEqual([]);
    });

    it('grants one of its own tier tags, issued by itself, and that tag then holds the tier', async () => {
      const user = newUser();

      await tags.grantTagForAssociation(OWN, { userId: user, tagName: TAG_A, grantedBy: 'it' });

      expect(await rowsOf(user)).toEqual([{ tagName: TAG_A, issuingAssocId: OWN }]);
      expect(await listed(user)).toEqual({
        a: { relation: 'held', due: null },
        b: { relation: 'higher', due: 1500 },
      });
    });

    it('is the manual add: a second tier swaps the first out (XOR), never two held', async () => {
      const user = newUser();

      await tags.grantTagForAssociation(OWN, { userId: user, tagName: TAG_A, grantedBy: 'it' });
      await tags.grantTagForAssociation(OWN, { userId: user, tagName: TAG_B, grantedBy: 'it' });

      expect(await rowsOf(user)).toEqual([{ tagName: TAG_B, issuingAssocId: OWN }]);
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
      const own = await ds.getRepository(Association).findOneByOrFail({ id: OWN });
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

  describe('no grant path renews or takes over a same-name row issued elsewhere', () => {
    const openAttempt = (userId: string, productId: string) =>
      ds.getRepository(ProductCheckout).save(
        ds.getRepository(ProductCheckout).create({
          productId,
          userId,
          associationId: OWN,
          paymentAssociationId: OWN,
          vendorToken: 'vendor-test',
          amountCents: 1500,
          currency: 'eur',
          productName: 'Tier',
          requestUuid: null,
          requestId: `${productId.slice(-2)}${userId.slice(11, 14)}`,
          status: 'open',
          expiresAt: new Date(Date.now() + 30 * 60_000),
          settledAt: null,
          purchaseRecordId: null,
        })
      );
    const heldElsewhere = (p: Promise<unknown>) =>
      expect(p).rejects.toBeInstanceOf(TagHeldByAnotherIssuerError);

    describe.each([
      ['another association', OTHER],
      ['no association', null],
    ])('a row of the tier tag issued by %s', (_label, issuer) => {
      /** A user holding TAG_A as `issuer` issued it. */
      const holderElsewhere = async () => {
        const user = newUser();
        await issuedBy(user, TAG_A, issuer);
        return user;
      };
      const unchanged = async (user: string) =>
        expect(await rowsOf(user)).toEqual([{ tagName: TAG_A, issuingAssocId: issuer }]);

      it('an online settlement records the payment paid but not granted', async () => {
        const user = await holderElsewhere();
        const attempt = await openAttempt(user, TIER_A);

        await (products as any).settlePaidCheckout(attempt.id);

        const [record] = await ds.query(`SELECT status FROM purchase_records WHERE "userId" = $1`, [
          user,
        ]);
        expect(record.status).toBe('paid_not_granted');
        await unchanged(user);
      });

      it('a cash sale is refused 409 and records nothing', async () => {
        const user = await holderElsewhere();
        const product = await ds.getRepository(AssociationProduct).findOneByOrFail({ id: TIER_A });

        await heldElsewhere(
          (products as any).fulfillProductPurchase({
            product,
            userId: user,
            amountCents: 1500,
            paymentMethod: 'cash',
            stripePaymentIntentId: null,
            grantedBy: 'it',
          })
        );
        expect(
          await ds.query(`SELECT 1 FROM purchase_records WHERE "userId" = $1`, [user])
        ).toEqual([]);
        await unchanged(user);
      });

      it("a paid form's grant answers the refusal", async () => {
        const user = await holderElsewhere();

        expect(await tags.grantCotisantIfARise(OWN, user, 'form', 'a', {})).toEqual({
          refused: TAG_HELD_BY_ANOTHER_ISSUER,
        });
        await unchanged(user);
      });

      it('the manual add, the legacy claim and the raw grant are refused 409', async () => {
        const user = await holderElsewhere();

        await heldElsewhere(tags.grantCotisant(OWN, user, 'it', 'a'));
        await heldElsewhere(tags.grantCotisantUnlessHeld(OWN, user, 'legacy', 'a', {}));
        await heldElsewhere(
          tags.grantTagForAssociation(OWN, { userId: user, tagName: TAG_A, grantedBy: 'it' })
        );
        expect(await rowsOf(user)).toEqual([{ tagName: TAG_A, issuingAssocId: issuer }]);
      });
    });
  });

  describe('cotisation tag names never coincide across associations', () => {
    it.each([
      ["another association's tier stem", null, 'scope-it-a'],
      ["another association's base stem", null, 'autre-it'],
      ['a stem of an association other than the asking one', OTHER, 'scope-it'],
      ["a stem one academic year away from another association's base", null, 'scope-it-2026-2027'],
      [
        "a stem one academic year away from another association's tier",
        null,
        'scope-it-b-2026-2027',
      ],
    ])('refuses %s', async (_label, asking, stem) => {
      await expect(assertCotisationStemFree(ds.manager, asking, stem)).rejects.toMatchObject({
        response: { code: COTISATION_TAG_COLLISION },
      });
    });

    it('accepts a stem that only extends another one, and its own stems', async () => {
      await expect(assertCotisationStemFree(ds.manager, null, 'scope-it-sport')).resolves.toBe(
        undefined
      );
      await expect(assertCotisationStemFree(ds.manager, OWN, 'scope-it-a')).resolves.toBe(
        undefined
      );
    });

    it("refuses a retag whose key makes the tier's stem another association's", async () => {
      // OWN's slug plus this key is LONGER's base stem.
      await expect(
        products.update(OWN, TIER_C, { variantKey: 'annexe' } as never, false)
      ).rejects.toMatchObject({ response: { code: COTISATION_TAG_COLLISION } });
      const [row] = await ds.query(`SELECT "variantKey" FROM association_products WHERE id = $1`, [
        TIER_C,
      ]);
      expect(row.variantKey).toBe('c');
    });
  });

  it('a retag onto a name a holder already holds elsewhere is refused 409, nothing renamed', async () => {
    const user = newUser();
    await issuedBy(user, TAG_C, OWN);
    await issuedBy(user, 'cotisant:scope-it-c2', OTHER);

    const refused = products.update(OWN, TIER_C, { variantKey: 'c2' } as never, false);

    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    await expect(refused).rejects.toMatchObject({ response: { code: TIER_TAG_NAME_TAKEN } });
    expect(await rowsOf(user)).toEqual([
      { tagName: TAG_C, issuingAssocId: OWN },
      { tagName: 'cotisant:scope-it-c2', issuingAssocId: OTHER },
    ]);
    const [row] = await ds.query(`SELECT "variantKey" FROM association_products WHERE id = $1`, [
      TIER_C,
    ]);
    expect(row.variantKey).toBe('c');
  });

  it("an update cannot type a membership product's granted tag: the derived one stays", async () => {
    await products.update(
      OWN,
      TIER_A,
      { grantedTagName: 'cotisant:autre-it', tagExpiresAt: null } as never,
      false
    );

    const [row] = await ds.query(
      `SELECT "grantedTagName" FROM association_products WHERE id = $1`,
      [TIER_A]
    );
    expect(row.grantedTagName).toBe(TAG_A);
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
