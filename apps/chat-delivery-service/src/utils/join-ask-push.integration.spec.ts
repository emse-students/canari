import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { SeatEviction } from '../entities/seat-eviction.entity';
import { joinAskAnnouncementsSettled, pushJoinAsk } from './join-ask-announce';

/**
 * THE ONE-PUSH-PER-DECLINE CLAIM, against real PostgreSQL: the `INSERT ... ON CONFLICT ... WHERE
 * old gen < new gen RETURNING 1` of `pushJoinAsk` is what two replicas race on, and a model of it
 * proves only the model. The table is built by migration 043 itself, in a throwaway schema.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, like the other integration specs here.
 */
const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '043_join_ask_pushes.sql'),
  'utf8'
);
const GROUP = '00000000-0000-4000-8000-0000000000f1';

maybe('pushJoinAsk claim (migration 043) against PostgreSQL', () => {
  const schema = `join_ask_push_it_${Date.now()}`;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const admin = new DataSource({ type: 'postgres', url: URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [GroupMember, Group, SeatEviction],
      synchronize: true,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    // What the push reads that belongs to core-service, as the shared database holds it.
    await q(`CREATE TABLE users (id varchar PRIMARY KEY, "displayName" varchar,
               "firstName" varchar, "lastName" varchar)`);
    await q(
      `CREATE TABLE user_blocks ("blockerId" varchar NOT NULL, "blockedId" varchar NOT NULL)`
    );
    // The claim table as production gets it: the migration, not an entity.
    await q(MIGRATION);
    await q(
      `INSERT INTO dm_groups (id, "isGroup", "activeEpoch", name) VALUES ($1, true, 3, 'Club')`,
      [GROUP]
    );
    await q(`INSERT INTO users (id, "displayName") VALUES ('carol', 'Carol Dupont')`);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    await q(`DELETE FROM dm_group_members`);
    await q(`DELETE FROM dm_join_ask_pushes`);
    await q(`DELETE FROM dm_seat_evictions`);
    await q(
      `INSERT INTO dm_group_members ("groupId", "userId", "awaitingAdmission") VALUES ($1, 'alice', false)`,
      [GROUP]
    );
  });

  /** The joiner follows the link: a NEW seat row, awaiting. Returns its id (the ask's identity). */
  async function follow(): Promise<string> {
    const rows = await q(
      `INSERT INTO dm_group_members ("groupId", "userId", "awaitingAdmission")
       VALUES ($1, 'carol', true) RETURNING id`,
      [GROUP]
    );
    return rows[0].id as string;
  }

  async function raise(askId: string, push: jest.Mock): Promise<void> {
    pushJoinAsk(ds.manager, GROUP, { userId: 'carol', askId }, push as never);
    await joinAskAnnouncementsSettled();
  }

  const sender = () => jest.fn(async () => ({ sent: 1, failed: 0 }));

  it('accept, withdraw, accept again gives ONE push; a member Decline then gives one more', async () => {
    const push = sender();

    await raise(await follow(), push);
    // The joiner withdraws their own ask: the seat is deleted, no Decline is recorded.
    await q(`DELETE FROM dm_group_members WHERE "userId" = 'carol'`);
    await raise(await follow(), push);
    await q(`DELETE FROM dm_group_members WHERE "userId" = 'carol'`);
    await raise(await follow(), push);
    expect(push).toHaveBeenCalledTimes(1);

    // A member declines them: the counter moves, and only that re-arms the push.
    await q(`DELETE FROM dm_group_members WHERE "userId" = 'carol'`);
    await q(
      `INSERT INTO dm_seat_evictions ("groupId", "userId", "declinedAtSeatGeneration")
       VALUES ($1, 'carol', 4)`,
      [GROUP]
    );
    await raise(await follow(), push);
    await q(`DELETE FROM dm_group_members WHERE "userId" = 'carol'`);
    await raise(await follow(), push);

    expect(push).toHaveBeenCalledTimes(2);
    const rows = await q(`SELECT gen FROM dm_join_ask_pushes WHERE "userId" = 'carol'`);
    expect(rows).toEqual([{ gen: 4 }]);
  });

  it('two replicas claiming the same ask at once send ONE push', async () => {
    const push = sender();
    const askId = await follow();

    await Promise.all([raise(askId, push), raise(askId, push)]);

    expect(push).toHaveBeenCalledTimes(1);
  });
});
