/**
 * THE DERIVED SLUG OF A NEW ASSOCIATION, AGAINST A REAL POSTGRESQL.
 *
 * The slug is derived from the name and the UNIQUE index on `associations.slug` is the arbiter: a
 * collision walks to `-2`, `-3`, each candidate in its own transaction, and a unique violation on
 * ANY OTHER index is not retried. A mock cannot prove the constraint name the driver reports, nor
 * that two concurrent creates both land.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- association-slug-derivation.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes, dropped at the
 * end. The `users` table the campus read needs is a three-column stand-in.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { SLUG_UNIQUE_CONSTRAINT } from './association-slug.util';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('association slug derivation against PostgreSQL', () => {
  const schema = `asso_slug_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: AssociationsService;
  let assos: Repository<Association>;
  let audiences: Repository<AssociationAudience>;

  const create = (name: string, slug?: string) =>
    service.create({ name, ...(slug ? { slug } : {}) } as never, 'creator', true);
  const slugsNamed = async (prefix: string) =>
    (await assos.find())
      .map((a) => a.slug)
      .filter((s) => s.startsWith(prefix))
      .sort();

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Association, AssociationAudience, Space],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    await ds.query(`CREATE TABLE users (id text PRIMARY KEY, campus text, cursus text)`);
    await ds.query(`INSERT INTO users (id, campus) VALUES ('creator', 'gardanne')`);
    assos = ds.getRepository(Association);
    audiences = ds.getRepository(AssociationAudience);
    const unused = {} as never;
    service = new AssociationsService(
      assos,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('the constraint name the code expects is the one PostgreSQL built', async () => {
    const rows = (await ds.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'associations'::regclass AND contype = 'u'`
    )) as { conname: string }[];
    expect(rows.map((r) => r.conname)).toContain(SLUG_UNIQUE_CONSTRAINT);
  });

  it("seeded 'club' and 'club-2', 'Club' becomes 'club-3' with exactly ONE audience row", async () => {
    await create('Club');
    await create('Club');
    const third = await create('Club');

    expect(third.slug).toBe('club-3');
    expect(await slugsNamed('club')).toEqual(['club', 'club-2', 'club-3']);
    expect(await audiences.count({ where: { associationId: third.id } })).toBe(1);
  });

  it('two concurrent creates of one name both succeed with distinct slugs', async () => {
    const [a, b] = await Promise.all([create('Photo'), create('Photo')]);

    expect(a.slug).not.toBe(b.slug);
    expect(await slugsNamed('photo')).toEqual(['photo', 'photo-2']);
  });

  it('a failure that is not a unique violation leaves no row', async () => {
    const before = await assos.count();
    // A NUL byte is refused by PostgreSQL itself, after the transaction has begun.
    await expect(create('Bad\u0000Name')).rejects.toBeDefined();
    expect(await assos.count()).toBe(before);
  });

  it('a unique violation on ANOTHER index is rethrown, not retried', async () => {
    await ds.query(`CREATE UNIQUE INDEX other_unique ON associations (name) WHERE name = 'Solo'`);
    await create('Solo');

    await expect(create('Solo')).rejects.toMatchObject({
      code: '23505',
      constraint: 'other_unique',
    });
    expect(await slugsNamed('solo')).toEqual(['solo']);
  });

  it('an explicit slug is still refused when taken, and a reserved one is refused', async () => {
    await create('Taken', 'taken-slug');
    await expect(create('Other', 'taken-slug')).rejects.toBeInstanceOf(BadRequestException);
    await expect(create('Other', 'new')).rejects.toBeInstanceOf(BadRequestException);
  });
});
