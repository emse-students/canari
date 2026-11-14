/**
 * EVERY CURSUS ENTRY IS READ, AGAINST A REAL POSTGRESQL (D32, profiles-and-access.md): the people
 * directory's promo and formation filters, and the formations listing behind a price criterion's
 * picker (`GET internal/users/formations`), see a person's SECOND cursus - never only the
 * `promo`/`formation` columns, which are the first entry (`legacyColumns`). Promo and formation are
 * read from the same entry. And the internal public profile serves the whole list, which is what
 * social-service prices on.
 *
 * The JSON operators are the point, so no mock can judge them. GATED ON `CORE_IT_DATABASE_URL`, like
 * the other integration files; the `boot-nest-apps` job in `ci.yml` sets it. Its own `users` table,
 * in a throwaway schema dropped at the end.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- cursus-reads.integration
 */
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';
import { InternalUsersController } from '../internal/internal-users.controller';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;
const SECRET = 'cursus-reads-it-secret';

maybe('every cursus entry is read, against PostgreSQL (D32)', () => {
  const schema = `cursus_reads_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let users: Repository<User>;
  let service: UsersService;
  let internal: InternalUsersController;
  const savedSecret = process.env.INTERNAL_SECRET;

  /** A person whose columns hold the FIRST entry only, as `legacyColumns` writes them. */
  const seed = (id: string, cursus: { formation: string; promo: number }[]) =>
    users.insert({
      id,
      displayName: id,
      cursus: cursus as never,
      promo: cursus[0]?.promo ?? null,
      formation: cursus[0]?.formation ?? null,
    });
  const ids = async (query: Record<string, unknown>) =>
    (await service.directory(query as never)).users.map((u) => u.id).sort();

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // The directory's filters are accent-insensitive; production has the extension (migrations).
    await admin.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [User],
      synchronize: true,
      installExtensions: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    users = ds.getRepository(User);
    const blocks = { invisibleUserIdsFor: async () => [] } as unknown as UserBlocksService;
    service = new UsersService(users, ds, blocks);
    internal = new InternalUsersController(users);
    process.env.INTERNAL_SECRET = SECRET;

    await seed('a-icm-then-ismin', [
      { formation: 'ICM', promo: 2021 },
      { formation: 'ISMIN', promo: 2024 },
    ]);
    await seed('b-ismin', [{ formation: 'ISMIN', promo: 2023 }]);
    await seed('c-fsss-twice', [
      { formation: 'FSSS', promo: 2022 },
      { formation: 'FSSS', promo: 2025 },
    ]);
    await seed('d-staff', []);
  }, 60_000);

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = savedSecret;
    await ds?.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds?.destroy();
  });

  it('the formation filter finds a person through their SECOND cursus', async () => {
    expect(await ids({ formation: 'ismin' })).toEqual(['a-icm-then-ismin', 'b-ismin']);
    expect(await ids({ formation: 'ICM' })).toEqual(['a-icm-then-ismin']);
  });

  it('the promo filter finds a person through their SECOND cursus', async () => {
    expect(await ids({ promo: 2024 })).toEqual(['a-icm-then-ismin']);
    expect(await ids({ promo: 2025 })).toEqual(['c-fsss-twice']);
  });

  it('promo and formation are read from the SAME entry', async () => {
    expect(await ids({ formation: 'ISMIN', promo: 2024 })).toEqual(['a-icm-then-ismin']);
    // ICM 2021 and ISMIN 2024: "ICM 2024" is neither.
    expect(await ids({ formation: 'ICM', promo: 2024 })).toEqual([]);
  });

  it('the formations listing counts a second cursus, and a person once per formation', async () => {
    expect(await internal.formations(SECRET)).toEqual([
      { value: 'ISMIN', count: 2 },
      { value: 'FSSS', count: 1 },
      { value: 'ICM', count: 1 },
    ]);
  });

  it('the internal public profile serves every cursus entry, in order', async () => {
    const profile = await internal.publicProfile('a-icm-then-ismin', SECRET);
    expect(profile.cursus).toEqual([
      { formation: 'ICM', promo: 2021 },
      { formation: 'ISMIN', promo: 2024 },
    ]);
    expect((await internal.publicProfile('d-staff', SECRET)).cursus).toEqual([]);
  });
});
