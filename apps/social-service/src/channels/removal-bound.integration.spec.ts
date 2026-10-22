/**
 * A REMOVAL'S CHECK AND ITS SAVE, AGAINST A REAL POSTGRESQL - one transaction, under one lock.
 *
 * `updateChannelAccess`, `kickFromWorkspace` and `removeMemberFromChannel` compare the actor's
 * permissions with the target's, then cut off and save. The three run in ONE transaction holding the
 * community's removal lock (a transaction-scoped advisory lock), and the comparison reads every
 * membership and role row it uses with a shared row lock - so a role change cannot land between the
 * check and the save. A mock cannot judge a lock, so the interleavings are made deterministic here:
 * a raw client holds the conflicting write open, and the test waits until the server reports the
 * service PARKED on it (never a sleep) before committing.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- removal-bound.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import { ForbiddenException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { DistributionEvictionOwed } from './entities/distribution-eviction-owed.entity';
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const WS = '00000000-0000-4000-8000-0000000000f1';
const ADMIN_ROLE = '00000000-0000-4000-8000-0000000000f2';
const MOD_ROLE = '00000000-0000-4000-8000-0000000000f3';
const SALONS_ROLE = '00000000-0000-4000-8000-0000000000f4';
const BASE_ROLE = '00000000-0000-4000-8000-0000000000f5';

maybe('a removal against PostgreSQL', () => {
  const schema = `removal_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let salonSeq = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Adds a member holding `roleId`, so every test names its own targets. */
  const member = async (userId: string, roleId: string) => {
    const members = ds.getRepository(ChannelMember);
    await members.save(members.create({ workspaceId: WS, userId, roleIds: [roleId] }));
  };
  /** A fresh private salon listing `allowed`. */
  const salon = async (allowed: string[]): Promise<string> => {
    const channels = ds.getRepository(Channel);
    const row = await channels.save(
      channels.create({
        workspaceId: WS,
        name: `prive-${salonSeq++}`,
        isPrivate: true,
        allowedUsers: allowed,
      })
    );
    return row.id;
  };
  const allowedOn = async (channelId: string): Promise<string[]> =>
    (await ds.getRepository(Channel).findOneByOrFail({ id: channelId })).allowedUsers;
  const codeOf = (e: unknown): unknown =>
    e instanceof ForbiddenException ? (e.getResponse() as { code?: unknown }).code : e;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Workspace,
        Channel,
        ChannelRole,
        ChannelMember,
        ChannelMessage,
        WorkspaceInvite,
        DistributionEvictionOwed,
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      ds.getRepository(ChannelMember),
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    // The key-distribution cut-offs and the grant announcements call chat-delivery; what is judged
    // here is the check and the rows.
    for (const name of [
      'cutOffKeyDistribution',
      'cutOffEveryPrivateChannel',
      'evictFromChannelGroup',
      'announceChannelAccessGranted',
    ]) {
      jest.spyOn(service as never, name as never).mockResolvedValue(undefined as never);
    }
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w-removal', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES
         ($1, $5, 'Administrateur', 100, 'workspace.manage'),
         ($2, $5, 'Moderateur', 50, 'member.kick,member.invite'),
         ($3, $5, 'Salons', 30, 'channel.manage'),
         ($4, $5, 'Membre', 10, '')`,
      [ADMIN_ROLE, MOD_ROLE, SALONS_ROLE, BASE_ROLE, WS]
    );
    await member('owner', ADMIN_ROLE);
    await member('salons', SALONS_ROLE);
    await member('kicker', MOD_ROLE);
    // ITS OWN BUDGET, NOT JEST'S 5 s DEFAULT. This hook builds the schema - DDL on a server that may
    // have just started - and on a fresh container that took from 0.2 s to 4.5 s here (measured
    // 2026-10-22, 45 cold starts); past 5 s every test failed as "Exceeded timeout ... for a hook".
    // The other integration specs give their setup the same kind of budget.
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  /**
   * Resolves once `count` backends are WAITING on a lock `holder` (a backend pid) holds - read
   * from the server's own lock table - or once `settled` says the call finished without waiting,
   * which is the failure the test then reports. Each round is a real query, never a sleep.
   */
  const blockedBy = async (holder: number, settled: () => boolean, count = 1) => {
    while (!settled()) {
      const waiting: unknown[] = await q(
        `SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))`,
        [holder]
      );
      if (waiting.length >= count) return;
    }
  };

  /** A raw client in the test schema, holding a transaction the test commits when it chooses. */
  const holder = async (): Promise<{ client: Client; pid: number }> => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return { client, pid };
  };

  /** Starts `call`, recording when it settles, with its error (or `'allowed'`) as the outcome. */
  const started = (call: Promise<unknown>) => {
    let done = false;
    const outcome = call.then(
      () => 'allowed' as unknown,
      (e: unknown) => codeOf(e)
    );
    void outcome.finally(() => {
      done = true;
    });
    return { outcome, settled: () => done };
  };

  it('drops a plain member from a private salon and saves the list', async () => {
    await member('plain', BASE_ROLE);
    const id = await salon(['salons', 'plain']);
    await service.updateChannelAccess(id, 'salons', true, ['salons']);
    expect(await allowedOn(id)).toEqual(['salons']);
  });

  it('judges a role change committed while the check waits on it, and refuses', async () => {
    // A role change has promoted the target and not committed when the access-list rewrite starts.
    // The check waits on the target's row, reads the committed role, and saves nothing.
    await member('promoted', BASE_ROLE);
    const id = await salon(['salons', 'promoted']);
    const change = await holder();
    try {
      await change.client.query('BEGIN');
      await change.client.query(
        `UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = 'promoted'`,
        [MOD_ROLE, WS]
      );
      const rewrite = started(service.updateChannelAccess(id, 'salons', true, ['salons']));
      await blockedBy(change.pid, rewrite.settled);
      await change.client.query('COMMIT');
      expect(await rewrite.outcome).toBe('REMOVAL_EXCEEDS_ACTOR');
      expect(await allowedOn(id)).toEqual(['salons', 'promoted']);
    } finally {
      await change.client.query('ROLLBACK').catch(() => undefined);
      await change.client.end();
    }
  });

  it('judges a role whose permissions grew while the check waits on it, and refuses', async () => {
    const grown = '00000000-0000-4000-8000-0000000000f6';
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions)
       VALUES ($1, $2, 'Aide', 11, '')`,
      [grown, WS]
    );
    await member('helper', grown);
    const id = await salon(['salons', 'helper']);
    const change = await holder();
    try {
      await change.client.query('BEGIN');
      await change.client.query(
        `UPDATE channel_roles SET permissions = 'member.kick' WHERE id = $1`,
        [grown]
      );
      const rewrite = started(service.updateChannelAccess(id, 'salons', true, ['salons']));
      await blockedBy(change.pid, rewrite.settled);
      await change.client.query('COMMIT');
      expect(await rewrite.outcome).toBe('REMOVAL_EXCEEDS_ACTOR');
      expect(await allowedOn(id)).toEqual(['salons', 'helper']);
    } finally {
      await change.client.query('ROLLBACK').catch(() => undefined);
      await change.client.end();
    }
  });

  it('a kick and a salon removal wait for the community removal lock', async () => {
    await member('leaver', BASE_ROLE);
    await member('dropped', BASE_ROLE);
    const id = await salon(['salons', 'dropped']);
    const other = await holder();
    try {
      await other.client.query('BEGIN');
      await other.client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('community_removal:' || $1, 0))`,
        [WS]
      );
      const kick = started(service.kickFromWorkspace(WS, 'leaver', 'kicker'));
      await blockedBy(other.pid, kick.settled);
      const removal = started(service.removeMemberFromChannel(id, 'dropped', 'salons'));
      await blockedBy(other.pid, removal.settled, 2);
      expect(kick.settled()).toBe(false);
      expect(removal.settled()).toBe(false);
      await other.client.query('COMMIT');
      expect(await kick.outcome).toBe('allowed');
      expect(await removal.outcome).toBe('allowed');
      expect(await allowedOn(id)).toEqual(['salons']);
    } finally {
      await other.client.query('ROLLBACK').catch(() => undefined);
      await other.client.end();
    }
  });
  it('records the eviction a salon removal owes, and calls it only after the commit', async () => {
    // The call fails the first time: the removal stays committed, the row stays owed, and the next
    // pass completes it. Neither call runs while any advisory lock is held.
    await member('evicted', BASE_ROLE);
    const id = await salon(['salons', 'evicted']);
    await q(`UPDATE channels SET "distributionGroupId" = gen_random_uuid() WHERE id = $1`, [id]);
    const owed = () =>
      q(
        `SELECT "userId" FROM distribution_evictions_owed WHERE kind = 'channel' AND "scopeId" = $1`,
        [id]
      );
    const evict = (service as unknown as { evictFromChannelGroup: jest.Mock })
      .evictFromChannelGroup;
    const locksAtCall: number[] = [];
    const advisoryLocks = async () =>
      Number((await q(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`))[0].n);
    evict.mockImplementationOnce(async () => {
      locksAtCall.push(await advisoryLocks());
      throw new Error('chat-delivery down');
    });

    expect(await started(service.removeMemberFromChannel(id, 'evicted', 'salons')).outcome).toBe(
      'allowed'
    );
    expect(await allowedOn(id)).toEqual(['salons']);
    expect(await owed()).toEqual([{ userId: 'evicted' }]);

    evict.mockImplementationOnce(async () => {
      locksAtCall.push(await advisoryLocks());
    });
    expect(await service.settleOwedEvictions()).toBe(1);
    expect(await owed()).toEqual([]);
    expect(locksAtCall).toEqual([0, 0]);
  });
});
