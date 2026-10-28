/**
 * Two creates of a tier with the same label, against a REAL PostgreSQL. The derivation reads the
 * sibling keys and then inserts, and `association_products` has no unique constraint on the key,
 * so only the association's tier lock (`lockAssociationTiers`) keeps two concurrent creates from
 * both reading the key as free. The unit spec cannot show that: its "database" is one JavaScript
 * thread.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- tier-key-derivation.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { ProductsService } from './products.service';
import { associationTierLockKey } from '../users/buyer-tier-lock';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a2';
/** An association whose deleted "Avec alcool" tier left an active holder behind. */
const ASSO_ORPHAN = '00000000-0000-4000-8000-0000000000a3';

maybe('a tier key derived from its label, two creates at once, against PostgreSQL', () => {
  const schema = `tier_key_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ProductsService;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      // `associations` too: the derivation reads every other association's stems.
      entities: [AssociationProduct, Association, AssociationAudience, Space, UserTag],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    service = Object.assign(Object.create(ProductsService.prototype) as object, {
      logger: new Logger('ProductsService'),
      productRepo: ds.getRepository(AssociationProduct),
    }) as unknown as ProductsService;
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /** A new tier row as `create` hands it to the locked insert: no key, no tag yet. */
  const draft = (name: string, associationId: string) =>
    ds.getRepository(AssociationProduct).create({
      associationId,
      name,
      type: 'membership',
      currency: 'eur',
      amountCents: 1500,
      isActive: false,
    });

  const saveDerived = (name: string, associationId: string = ASSO) =>
    (
      service as unknown as {
        saveTierWithDerivedKey(
          p: AssociationProduct,
          slug: string,
          mode: 'lifetime' | 'dated',
          name: string
        ): Promise<AssociationProduct>;
      }
    ).saveTierWithDerivedKey(draft(name, associationId), 'cercle', 'lifetime', name);

  it('gives two concurrent creates of one label two distinct keys, and neither hangs', async () => {
    // Hold the association's tier lock from another session so BOTH creates queue on it, then let
    // them go together: without the lock inside the derivation they would read the same siblings.
    await admin.query('BEGIN');
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      associationTierLockKey(ASSO),
    ]);
    const both = Promise.all([saveDerived('Avec alcool'), saveDerived('Avec alcool')]);
    await admin.query('COMMIT');

    const [a, b] = await both;
    expect(new Set([a.variantKey, b.variantKey])).toEqual(
      new Set(['avec-alcool', 'avec-alcool-2'])
    );
    expect(a.grantedTagName).not.toBe(b.grantedTagName);

    const rows = await ds.getRepository(AssociationProduct).find({
      where: { associationId: ASSO, type: 'membership' },
    });
    expect(rows.map((r) => r.variantKey).sort()).toEqual(['avec-alcool', 'avec-alcool-2']);
  }, 30_000);

  it('skips a key whose tag a deleted tier still has an active holder of, and adopts nobody', async () => {
    // "Avec alcool" was deleted before the delete guard existed: its holder kept the tag.
    await ds.getRepository(UserTag).insert({
      userId: 'orphan-holder',
      tagName: 'cotisant:cercle-avec-alcool',
      issuingAssocId: ASSO_ORPHAN,
      grantedBy: 'system',
      expiresAt: null,
    });

    const created = await saveDerived('Avec alcool', ASSO_ORPHAN);

    expect(created.variantKey).toBe('avec-alcool-2');
    expect(created.grantedTagName).toBe('cotisant:cercle-avec-alcool-2');
    const holders = await ds
      .getRepository(UserTag)
      .count({ where: { issuingAssocId: ASSO_ORPHAN, tagName: created.grantedTagName! } });
    expect(holders).toBe(0);
  }, 30_000);
});
