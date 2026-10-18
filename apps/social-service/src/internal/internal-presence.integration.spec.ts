/**
 * THE COMMUNITY HALF OF THE PRESENCE AUDIENCE AGAINST A REAL POSTGRESQL - migration 089 included.
 *
 * `internal-presence.controller.spec.ts` answers the controller's `find` calls from an array, so it
 * proves which QUESTIONS are asked; this file runs them against `channel_members` as TypeORM builds
 * it, and applies migration 089 over that schema. What only a database can say: the `In(...)` pair
 * keeps a member of another community out, and the viewer lookup - `WHERE "userId" = $1`, run on
 * every presence poll - has an index that serves it (the unique (`workspaceId`, `userId`) cannot).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- internal-presence.integration
 *
 * Everything happens in a throwaway schema, created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why the order matters) and dropped at the end.
 */
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { InternalPresenceController } from './internal-presence.controller';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '089_channel_members_user_index.sql'),
  'utf8'
);

const WS_A = '00000000-0000-4000-8000-0000000000a1';
const WS_B = '00000000-0000-4000-8000-0000000000b1';

maybe('the presence audience of communities against PostgreSQL (migration 089)', () => {
  const schema = `presence_it_${Math.random().toString(36).slice(2, 10)}`;
  const env = { ...process.env };
  let admin: Client;
  let ds: DataSource;
  let controller: InternalPresenceController;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [ChannelMember],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    // Production built this table before the entity declared the index: drop it, so what the
    // assertions below see is what the MIGRATION creates.
    await q(`DROP INDEX IF EXISTS "IDX_channel_members_user"`);
    for (const [workspaceId, userId] of [
      [WS_A, 'alice'],
      [WS_A, 'bob'],
      [WS_B, 'carol'],
      [WS_B, 'dora'],
    ]) {
      await q(`INSERT INTO channel_members ("workspaceId", "userId") VALUES ($1, $2)`, [
        workspaceId,
        userId,
      ]);
    }
    controller = new InternalPresenceController(ds.getRepository(ChannelMember));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'it-secret';
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('applies migration 089, twice, and the viewer lookup then uses its index', async () => {
    await q(migration);
    await q(migration);
    const indexes = (await q(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'IDX_channel_members_user'`,
      [schema]
    )) as { indexdef: string }[];
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('("userId")');

    // Four rows are always cheaper to scan, so the planner is told not to: the question is whether
    // an index CAN serve the predicate, which the unique (workspaceId, userId) cannot.
    const plan = (await ds.transaction(async (m) => {
      await m.query('SET LOCAL enable_seqscan = off');
      return m.query(`EXPLAIN SELECT "workspaceId" FROM channel_members WHERE "userId" = $1`, [
        'alice',
      ]);
    })) as { 'QUERY PLAN': string }[];
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('IDX_channel_members_user');
  });

  it('answers the members of a community the viewer shares, and nobody from another', async () => {
    await expect(
      controller.sharedCommunities('it-secret', {
        viewerId: 'Alice',
        userIds: ['bob', 'carol', 'zed', 'alice'],
      })
    ).resolves.toEqual({ userIds: ['bob'] });
  });

  it('answers an empty audience for a viewer in no community', async () => {
    await expect(
      controller.sharedCommunities('it-secret', { viewerId: 'zed', userIds: ['bob'] })
    ).resolves.toEqual({ userIds: [] });
  });
});
