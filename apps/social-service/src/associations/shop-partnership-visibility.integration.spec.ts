/**
 * THE SHOP AND THE PARTNERSHIPS FOLLOW THE CAMPUS, against a real PostgreSQL (owner, 2026-10-31).
 *
 * A product or a partnership card belongs to an association, and is LISTED - on /shop, and for a
 * card anywhere - only to someone that association is VISIBLE to: `associationVisibleToViewerSql`,
 * the directory's and the agenda's predicate (a member of it, D21, or its rules reach one of their
 * spaces). A card claimed by its id outside that answers 404, like a card that does not exist. A
 * PRODUCT stays payable by anyone holding the association page's link (`listByAssoc`, D37), as a
 * form's link is enough: the campus decides what /shop offers, not who may pay.
 *
 * The unit specs stub the listing; this file is where the predicate is run. Which rows survive is
 * what is under test, so the annotation of the listing (cotisant status, tier prices) and the
 * payment routing are stubbed, as `product-tier-lock.integration.spec.ts` stubs them.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- shop-partnership-visibility.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Association } from './entities/association.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { PartnershipCard } from './entities/partnership-card.entity';
import { PartnershipCode } from './entities/partnership-code.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { ProductsService } from './products.service';
import { PARTNERSHIP_ERROR_CODES, PartnershipsService } from './partnerships.service';
import type { AssociationsService } from './associations.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** The cast. Readable ids: a failure names a person, not a uuid. */
const ICM_SE = 'icm-se'.padEnd(64, '0');
const ISMIN_GA = 'ismin-ga'.padEnd(64, '0');
/** An ISMIN Gardanne student who is a MEMBER of the Saint-Etienne association (D21). */
const GA_MEMBER = 'ga-member'.padEnd(64, '0');

/** Reaches the whole Saint-Etienne campus. */
const SE_ASSO = '00000000-0000-4000-8000-0000000000a1';
/** Reaches the whole Gardanne campus. */
const GA_ASSO = '00000000-0000-4000-8000-0000000000a2';
const SE_PRODUCT = '00000000-0000-4000-8000-0000000000b1';
const GA_PRODUCT = '00000000-0000-4000-8000-0000000000b2';
const SE_CARD = '00000000-0000-4000-8000-0000000000c1';
const GA_CARD = '00000000-0000-4000-8000-0000000000c2';

/** The typed `code` of a refusal (never its message). */
async function refusal(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
  throw new Error('expected a refusal, the call succeeded');
}

maybe('the shop and the partnerships follow the campus (PostgreSQL)', () => {
  const schema = `shop_vis_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let products: ProductsService;
  let partnerships: PartnershipsService;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Association,
        AssociationProduct,
        PartnershipCard,
        PartnershipCode,
        AssociationAudience,
        Space,
      ],
      synchronize: true,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The tables of other owners the predicate reads, with only the columns it reads.
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
         campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]')`
    );
    await admin.query(
      `CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
         "userId" varchar(255) NOT NULL)`
    );

    await admin.query(
      `INSERT INTO users (id, campus, cursus) VALUES
         ($1, 'saint-etienne', '[{"formation": "ICM"}]'),
         ($2, 'gardanne', '[{"formation": "ISMIN"}]'),
         ($3, 'gardanne', '[{"formation": "ISMIN"}]')`,
      [ICM_SE, ISMIN_GA, GA_MEMBER]
    );
    await admin.query(
      `INSERT INTO spaces (formation, campus) VALUES ('ICM', 'saint-etienne'), ('ISMIN', 'gardanne')`
    );
    for (const [id, slug, campus] of [
      [SE_ASSO, 'se-asso', 'saint-etienne'],
      [GA_ASSO, 'ga-asso', 'gardanne'],
    ] as const) {
      await ds
        .getRepository(Association)
        .save(
          ds
            .getRepository(Association)
            .create({ id, name: slug, slug, createdBy: 'it' } as Partial<Association>)
        );
      await admin.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)`,
        [id, campus]
      );
    }
    await admin.query(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, $2)`,
      [SE_ASSO, GA_MEMBER]
    );
    for (const [id, associationId] of [
      [SE_PRODUCT, SE_ASSO],
      [GA_PRODUCT, GA_ASSO],
    ] as const) {
      await ds.getRepository(AssociationProduct).save(
        ds.getRepository(AssociationProduct).create({
          id,
          associationId,
          name: `product of ${associationId.slice(-2)}`,
          type: 'other',
          amountCents: 1000,
          currency: 'eur',
          isActive: true,
        })
      );
    }
    for (const [id, associationId] of [
      [SE_CARD, SE_ASSO],
      [GA_CARD, GA_ASSO],
    ] as const) {
      await ds.getRepository(PartnershipCard).save(
        ds.getRepository(PartnershipCard).create({
          id,
          associationId,
          title: `card of ${associationId.slice(-2)}`,
          claimMode: 'text',
          staticText: 'Show your student card',
        })
      );
    }

    products = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      productRepo: ds.getRepository(AssociationProduct),
      assoRepo: ds.getRepository(Association),
      // Which rows survive is under test, not how they are annotated.
      annotateForViewer: (rows: AssociationProduct[]) => Promise.resolve(rows),
      // Payments are routed and ready: what is under test is who may buy, not where it is paid.
      pricingFacts: { profileFor: () => Promise.resolve({ promo: null, formation: null }) },
      activePaymentProvider: () => Promise.resolve('lydia'),
      routeWith: () =>
        Promise.resolve({
          ready: true,
          delegated: false,
          connectAccountId: 'vendor-test',
          targetAssociationId: SE_ASSO,
          provider: 'lydia',
        }),
    }) as unknown as ProductsService;
    partnerships = new PartnershipsService(
      ds.getRepository(PartnershipCard),
      ds.getRepository(PartnershipCode),
      ds.getRepository(Association),
      { isBuyerCotisant: () => Promise.resolve(false) } as unknown as ProductsService,
      {} as unknown as AssociationsService
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  describe('the shop', () => {
    it("lists each reader the products of their own campus's associations, and a member its association's", async () => {
      expect(ids(await products.listAllActive(ICM_SE))).toEqual([SE_PRODUCT]);
      expect(ids(await products.listAllActive(ISMIN_GA))).toEqual([GA_PRODUCT]);
      // D21: a member of the Saint-Etienne association sees its products from Gardanne.
      expect(ids(await products.listAllActive(GA_MEMBER))).toEqual([SE_PRODUCT, GA_PRODUCT]);
    });

    it('lets anyone holding the association page link BUY, whatever their campus (owner, 2026-10-31)', async () => {
      const prepare = (assoId: string, productId: string, userId: string) =>
        (
          products as unknown as {
            preparePurchase: (a: string, p: string, u: string) => Promise<unknown>;
          }
        ).preparePurchase(assoId, productId, userId);

      // Not listed on their /shop (above), and still payable from the page the link opens - as a
      // form's link is enough to answer it.
      await expect(prepare(SE_ASSO, SE_PRODUCT, ISMIN_GA)).resolves.toMatchObject({
        productId: SE_PRODUCT,
      });
      await expect(prepare(GA_ASSO, GA_PRODUCT, ICM_SE)).resolves.toMatchObject({
        productId: GA_PRODUCT,
      });
      await expect(prepare(SE_ASSO, SE_PRODUCT, ICM_SE)).resolves.toMatchObject({
        productId: SE_PRODUCT,
      });
    });

    it("keeps listing an association's products on its own page, reached by its link (D37)", async () => {
      expect(ids(await products.listByAssoc(SE_ASSO, ISMIN_GA))).toEqual([SE_PRODUCT]);
    });
  });

  describe('the partnerships', () => {
    it("lists each reader the cards of their own campus's associations, and a member its association's", async () => {
      expect(ids(await partnerships.listAllActive(ICM_SE))).toEqual([SE_CARD]);
      expect(ids(await partnerships.listAllActive(ISMIN_GA))).toEqual([GA_CARD]);
      expect(ids(await partnerships.listAllActive(GA_MEMBER))).toEqual([SE_CARD, GA_CARD]);
    });

    it("lists an association's cards on its page only to those it is visible to", async () => {
      expect(ids(await partnerships.listActiveByAssoc(SE_ASSO, ICM_SE))).toEqual([SE_CARD]);
      expect(await partnerships.listActiveByAssoc(SE_ASSO, ISMIN_GA)).toEqual([]);
      expect(ids(await partnerships.listActiveByAssoc(SE_ASSO, GA_MEMBER))).toEqual([SE_CARD]);
    });

    it('refuses a claim BY ID of a card of another campus as NOT FOUND, and lets the same campus and a member claim', async () => {
      const refused = await refusal(partnerships.claimCard(SE_CARD, ISMIN_GA));
      expect(refused).toEqual({
        status: 404,
        body: { code: PARTNERSHIP_ERROR_CODES.NOT_FOUND, message: 'Partnership not found' },
      });

      await expect(partnerships.claimCard(SE_CARD, ICM_SE)).resolves.toEqual({
        mode: 'text',
        staticText: 'Show your student card',
      });
      await expect(partnerships.claimCard(SE_CARD, GA_MEMBER)).resolves.toMatchObject({
        mode: 'text',
      });
    });
  });
});
