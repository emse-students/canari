/**
 * A DUPLICATE WAITING FOR ITS MERGE IS IN NO PICKER, AGAINST A REAL POSTGRESQL (D56,
 * profiles-and-access.md): `search` and `directory` leave out the Canari account whose MiConnect uuid
 * is the duplicate of an OPEN `alumni_merges` row - requested or marked - keep it once the merge is
 * cancelled (the row closed), and never hide the TARGET; the block clause still applies beside it.
 * The `NOT EXISTS` names the query builder's alias, which only a real query can judge.
 *
 * GATED ON `CORE_IT_DATABASE_URL`, like the other integration files; the `boot-nest-apps` job in
 * `ci.yml` sets it. Its own tables, in a throwaway schema dropped at the end.
 *
 *   CORE_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- picker-merging-duplicate
 */
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { AlumniMerge } from './entities/alumni-merge.entity';
import { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';

const URL = process.env.CORE_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('a duplicate waiting for its merge is in no picker, against PostgreSQL (D56)', () => {
  const schema = `picker_merging_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let users: Repository<User>;
  let service: UsersService;
  let blocked: string[] = [];

  const DUP_UUID = '11111111-1111-4111-8111-111111111111';
  const TARGET_UUID = '22222222-2222-4222-8222-222222222222';

  /** An open merge of the duplicate onto the target: `marked` sets `markedAt`, never `completedAt`. */
  const openMerge = (marked: boolean) =>
    ds.query(
      `INSERT INTO alumni_merges ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", held, "markedAt")
       VALUES ('admin', $1, 'alumni-0001', $2, '{}'::jsonb, $3) RETURNING id`,
      [DUP_UUID, TARGET_UUID, marked ? new Date() : null]
    ) as Promise<{ id: string }[]>;
  const searched = async () =>
    (await service.search('Camille Durand', 'reader')).map((u) => u.id).sort();
  const listed = async () =>
    (await service.directory({ q: 'Camille Durand' } as never, 'reader')).users
      .map((u) => u.id)
      .sort();

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [User, AlumniMerge],
      synchronize: true,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    users = ds.getRepository(User);
    const blocks = { invisibleUserIdsFor: async () => blocked } as unknown as UserBlocksService;
    service = new UsersService(users, ds, blocks);
    await users.insert([
      {
        id: 'target',
        displayName: 'Camille Durand',
        miconnectUuid: TARGET_UUID,
        cursus: [{ formation: 'ICM', promo: 2018 }] as never,
      },
      {
        id: 'duplicate',
        displayName: 'Camille Durand',
        miconnectUuid: DUP_UUID,
        cursus: [{ formation: 'ICM', promo: 2018 }] as never,
      },
      { id: 'other', displayName: 'Camille Durand', miconnectUuid: null, promo: 2021 },
    ]);
  });

  afterAll(async () => {
    await ds?.query(`DROP SCHEMA ${schema} CASCADE`);
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    blocked = [];
    await ds.query('DELETE FROM alumni_merges');
  });

  it('lists everybody while no merge is open', async () => {
    expect(await searched()).toEqual(['duplicate', 'other', 'target']);
    expect(await listed()).toEqual(['duplicate', 'other', 'target']);
  });

  it('leaves out a REQUESTED and a MARKED duplicate, never the target', async () => {
    for (const marked of [false, true]) {
      await openMerge(marked);
      expect(await searched()).toEqual(['other', 'target']);
      expect(await listed()).toEqual(['other', 'target']);
      await ds.query('DELETE FROM alumni_merges');
    }
  });

  it('brings the duplicate back once the merge is cancelled (the row closed)', async () => {
    const [{ id }] = await openMerge(true);
    await ds.query(
      `UPDATE alumni_merges SET "cancelledAt" = now(), "completedAt" = now() WHERE id = $1`,
      [id]
    );
    expect(await searched()).toEqual(['duplicate', 'other', 'target']);
  });

  it('keeps the block clause beside it', async () => {
    await openMerge(true);
    blocked = ['other'];
    expect(await searched()).toEqual(['target']);
    expect(await listed()).toEqual(['target']);
  });

  it('answers each row with its earliest cursus, or the legacy pair', async () => {
    const rows = await service.search('Camille Durand', 'reader');
    expect(rows.find((r) => r.id === 'target')).toEqual({
      id: 'target',
      displayName: 'Camille Durand',
      promo: 2018,
      formation: 'ICM',
    });
    expect(rows.find((r) => r.id === 'other')).toEqual(
      expect.objectContaining({ promo: 2021, formation: null })
    );
  });
});
