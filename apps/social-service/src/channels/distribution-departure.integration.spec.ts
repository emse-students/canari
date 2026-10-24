/**
 * HOW A KEY-GROUP DEPARTURE ENDED IS DECIDED ONCE - against a real PostgreSQL, migration 108 included.
 *
 * chat-delivery's hourly drain asks `decideDistributionDeparture` about a departure whose second
 * eviction never arrived, and the question DECIDES: with no `departed` row it writes `cancelled`, and
 * the roster write's own record of that name is then refused. Whichever commits first wins, and an
 * insert arriving while the other is uncommitted WAITS on the primary key. That wait is the whole
 * mechanism, and no fake can judge it - so it is run here, in both orders, deterministically: one
 * side holds a transaction open, the test reads `pg_blocking_pids` until the other side is parked
 * on it, then commits or rolls back. No sleep anywhere.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- distribution-departure.integration
 *
 * Everything happens in a throwaway schema, created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why) and dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RECORD_CANCELLED_SQL, RECORD_DEPARTED_SQL } from './distribution-departures';
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '108_distribution_departures.sql'),
  'utf8'
);

const WS = '00000000-0000-4000-8000-0000000000d1';
const SALON = '00000000-0000-4000-8000-0000000000d2';
/** chat-delivery's id of the salon's key group, as its first eviction names it. */
const GROUP = '00000000-0000-4000-8000-0000000000d3';

maybe('a key-group departure against the drain asking how it ended (PostgreSQL)', () => {
  const schema = `departure_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let previousSecret: string | undefined;
  let previousFetch: typeof fetch;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** chat-delivery, as the departure sees it: the first eviction begins `departure`, by name. */
  const deliveryBeginning = (departure: number) => {
    global.fetch = jest.fn(async (url: unknown) => {
      const settles = String(url).includes('phase=after_roster_write');
      return new Response(
        JSON.stringify({
          evicted: true,
          memberships: 1,
          queued: 0,
          routes: 1,
          ...(settles ? {} : { groupId: GROUP, departure }),
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
  };

  const allowed = async (): Promise<string[]> => {
    const [row]: { allowedUsers: string }[] = await q(
      `SELECT "allowedUsers" FROM channels WHERE id = $1`,
      [SALON]
    );
    return row.allowedUsers ? row.allowedUsers.split(',') : [];
  };
  const recorded = async (userId: string, departure: number): Promise<string | undefined> => {
    const rows: { outcome: string }[] = await q(
      `SELECT outcome FROM distribution_departures WHERE "groupId" = $1 AND "userId" = $2 AND departure = $3`,
      [GROUP, userId, departure]
    );
    return rows[0]?.outcome;
  };

  /**
   * Resolves once at least `count` backends are WAITING on a lock - read from the server's own lock
   * table, so the test knows the other side is parked rather than hoping a pause was long enough.
   * Each round is a real query, never a sleep; jest's timeout bounds it.
   */
  const parked = async (count: number) => {
    for (;;) {
      const [row]: { n: string }[] = await q(
        `SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`
      );
      if (Number(row.n) >= count) return;
    }
  };

  /** A raw client in the test schema, holding a transaction the test ends when it chooses. */
  const holder = async (): Promise<Client> => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    await client.query('BEGIN');
    return client;
  };
  const release = async (client: Client) => {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  };

  beforeAll(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'it-secret';
    previousFetch = global.fetch;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Workspace, Channel, ChannelRole, ChannelMember, ChannelMessage, WorkspaceInvite],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The table as production gets it: the migration, primary key and CHECK included.
    await q(migration);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      ds.getRepository(ChannelMember),
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w-depart', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channels (id, "workspaceId", name, "isPrivate", "allowedUsers", "distributionGroupId")
       VALUES ($1, $2, 'direction', true, 'leaver-a,leaver-b,leaver-c,leaver-d', $3)`,
      [SALON, WS, GROUP]
    );
    const members = ds.getRepository(ChannelMember);
    for (const userId of ['leaver-a', 'leaver-b', 'leaver-c', 'leaver-d', 'actor']) {
      await members.save(members.create({ workspaceId: WS, userId }));
    }
  });

  afterAll(async () => {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a question asked while the roster write is in flight waits for it, and reads departed', async () => {
    deliveryBeginning(7);
    // Hold the salon row, so the departure parks INSIDE its transaction - after recording its name,
    // at its roster write.
    const salonLock = await holder();
    try {
      await salonLock.query(`SELECT id FROM channels WHERE id = $1 FOR UPDATE`, [SALON]);
      const departing = service.leaveChannel(SALON, { userId: 'leaver-a' } as never);
      await parked(1);
      // The drain asks now: its insert parks on the departure's uncommitted record.
      const asked = service.decideDistributionDeparture(GROUP, 'leaver-a', 7);
      await parked(2);
      await salonLock.query('COMMIT');

      await expect(departing).resolves.toEqual({ success: true });
      await expect(asked).resolves.toBe('departed');
      expect(await allowed()).not.toContain('leaver-a');
      expect(await recorded('leaver-a', 7)).toBe('departed');
    } finally {
      await release(salonLock);
    }
  });

  it('a question asked while a roster write is in flight reads cancelled when that write rolls back', async () => {
    // The roster write's own record, uncommitted - then the departure fails and rolls back.
    const rosterWrite = await holder();
    try {
      await rosterWrite.query(RECORD_DEPARTED_SQL, [GROUP, 'leaver-b', 8]);
      const asked = service.decideDistributionDeparture(GROUP, 'leaver-b', 8);
      await parked(1);
      await rosterWrite.query('ROLLBACK');

      await expect(asked).resolves.toBe('cancelled');
      expect(await recorded('leaver-b', 8)).toBe('cancelled');
    } finally {
      await release(rosterWrite);
    }
  });

  it('a roster write arriving while the question is in flight is refused, and the member stays', async () => {
    deliveryBeginning(9);
    // The drain's question, uncommitted: it got there first.
    const question = await holder();
    try {
      await question.query(RECORD_CANCELLED_SQL, [GROUP, 'leaver-c', 9]);
      const departing = service
        .leaveChannel(SALON, { userId: 'leaver-c' } as never)
        .catch((e: unknown) => e);
      await parked(1);
      await question.query('COMMIT');

      expect(await departing).toMatchObject({ response: { code: 'DEPARTURE_SUPERSEDED' } });
      // Final both ways: the roster write rolled back whole, and the answer stays cancelled.
      expect(await allowed()).toContain('leaver-c');
      await expect(service.decideDistributionDeparture(GROUP, 'leaver-c', 9)).resolves.toBe(
        'cancelled'
      );
    } finally {
      await release(question);
    }
  });

  /**
   * THE COMMUNITY REMOVAL LOCK, AND A REFUSAL UNDER IT. A caller re-checks its permission inside the
   * roster write, which runs under `community_removal:<workspace>`; a write holding that lock (here,
   * the actor losing their membership) is waited for, the re-check sees it, and the refusal ends the
   * departure as an abandoned one: nothing recorded `departed`, the roster unchanged, and the
   * departure decided `cancelled`.
   */
  it('a refusal re-checked under the community removal lock leaves the roster and settles cancelled', async () => {
    deliveryBeginning(11);
    const removal = await holder();
    try {
      await removal.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('community_removal:' || $1, 0))`,
        [WS]
      );
      await removal.query(
        `DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'actor'`,
        [WS]
      );

      const depart = (
        service as unknown as {
          departDistributionGroups: (
            cuts: unknown[],
            reason: string,
            workspaceId: string,
            rosterWrite: (m: import('typeorm').EntityManager) => Promise<void>
          ) => Promise<void>;
        }
      ).departDistributionGroups.bind(service);
      const departing = depart(
        [{ scope: { kind: 'channel', id: SALON }, userId: 'leaver-d' }],
        'removed_from_channel',
        WS,
        async (m) => {
          const actor = await m
            .getRepository(ChannelMember)
            .findOne({ where: { workspaceId: WS, userId: 'actor' } });
          if (!actor) throw new Error('REMOVAL_EXCEEDS_ACTOR');
          await m.query(
            `UPDATE channels SET "allowedUsers" = 'leaver-a,leaver-b,leaver-c' WHERE id = $1`,
            [SALON]
          );
        }
      ).catch((e: unknown) => e);
      await parked(1);
      await removal.query('COMMIT');

      expect(await departing).toMatchObject({ message: 'REMOVAL_EXCEEDS_ACTOR' });
      expect(await allowed()).toContain('leaver-d');
      expect(await recorded('leaver-d', 11)).toBe('cancelled');
      const cancelled = (global.fetch as unknown as jest.Mock).mock.calls.map(([url]) =>
        String(url)
      );
      expect(cancelled.some((u) => u.endsWith('/members/leaver-d/departures/11/cancel'))).toBe(
        true
      );
    } finally {
      await release(removal);
    }
  });

  it('refuses an outcome the CHECK does not name', async () => {
    await expect(
      q(
        `INSERT INTO distribution_departures ("groupId", "userId", departure, outcome) VALUES ($1, 'x', 1, 'maybe')`,
        [GROUP]
      )
    ).rejects.toThrow('distribution_departures_outcome_check');
  });
});
