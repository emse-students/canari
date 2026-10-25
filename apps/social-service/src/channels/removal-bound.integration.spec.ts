/**
 * A REMOVAL'S CHECK AND ITS SAVE, AGAINST A REAL POSTGRESQL - one transaction, under one lock.
 *
 * `updateChannelAccess`, `kickFromWorkspace`, `removeMemberFromChannel` and a private
 * `createChannel` compare the actor's permissions with the target's, then save. Each save runs in ONE
 * transaction holding the community's removal lock (a transaction-scoped advisory lock, opened by
 * `departDistributionGroups` or `withCommunityRemovalLock`), and the comparison reads every
 * membership and role row it uses with a shared row lock - so a role change cannot land between the
 * check and the save. An access-list rewrite also re-reads the salon `FOR UPDATE` there. A mock cannot judge a lock, so the interleavings are made deterministic here:
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
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { CHANNEL_ACCESS_CHANGED, ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** `distribution_departures`, as production gets it: every removal's roster write records into it. */
const DEPARTURES_MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '108_distribution_departures.sql'),
  'utf8'
);

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
  let previousFetch: typeof fetch;
  let previousSecret: string | undefined;
  /** How many holders of THIS community's removal lock existed at each call to chat-delivery. */
  const locksAtCall: number[] = [];
  /** chat-delivery's group per salon, minted once (its create is idempotent per scope). */
  const groups = new Map<string, string>();
  /** Run once by the next group create, before it answers - a test's way into that moment. */
  let beforeCreate: (() => Promise<void>) | null = null;
  /** Run once by the next call to chat-delivery whose URL contains `beforeCall.on`. */
  let beforeCall: { on: string; run: () => Promise<void> } | null = null;
  /** The events the service published, by name. */
  let published: jest.Mock;
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
  /** A refusal's typed code; the exception itself when it carries none. */
  const codeOf = (e: unknown): unknown =>
    (e instanceof HttpException ? (e.getResponse() as { code?: unknown }).code : undefined) ?? e;

  beforeAll(async () => {
    previousSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'it-secret';
    previousFetch = global.fetch;
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
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
    await q(DEPARTURES_MIGRATION);
    // What an invitation asks before anything else: nobody here blocks anybody.
    await q(`CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255))`);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      ds.getRepository(ChannelMember),
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      {
        publishChannelEvent: (published = jest.fn().mockResolvedValue(undefined)),
      } as unknown as RedisService
    );
    // chat-delivery, as a departure sees it: every eviction finds no group (the salons here have
    // none), and each call records how many advisory locks the server held when it was made.
    // chat-delivery, as this file needs it: a group create answers the salon's one group id (the
    // real mint runs, its row write included); an eviction finds no group; and each call records
    // how many holders the community's removal lock had - that key only, read from `pg_locks`.
    global.fetch = jest.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
      if (beforeCall && String(url).includes(beforeCall.on)) {
        const hook = beforeCall;
        beforeCall = null;
        await hook.run();
      }
      // An invitee's device count: they have one.
      if (String(url).includes('/count')) {
        return new Response(JSON.stringify({ count: 1 }), { status: 200 });
      }
      locksAtCall.push(
        Number(
          (
            await q(
              `SELECT count(*) AS n FROM pg_locks
               WHERE locktype = 'advisory' AND granted
                 AND ((classid::bigint << 32) | objid::bigint)
                   = hashtextextended('community_removal:' || $1, 0)`,
              [WS]
            )
          )[0].n
        )
      );
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const { scopeId } = JSON.parse(init.body) as { scopeId: string };
        const hook = beforeCreate;
        beforeCreate = null;
        if (hook) await hook();
        if (!groups.has(scopeId)) groups.set(scopeId, crypto.randomUUID());
        return new Response(JSON.stringify({ groupId: groups.get(scopeId) }), { status: 200 });
      }
      return new Response(JSON.stringify({ evicted: false }), { status: 200 });
    }) as unknown as typeof fetch;
    // The grant announcements call chat-delivery for things this file does not judge.
    jest
      .spyOn(service as never, 'announceChannelAccessGranted' as never)
      .mockResolvedValue(undefined as never);
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
    await member('owner2', ADMIN_ROLE);
    // No budget here: every integration spec has one, `jest-integration-budget.cjs`.
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
    await service.updateChannelAccess(id, 'salons', true, ['salons'], undefined, 0);
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
      const rewrite = started(
        service.updateChannelAccess(id, 'salons', true, ['salons'], undefined, 0)
      );
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
      const rewrite = started(
        service.updateChannelAccess(id, 'salons', true, ['salons'], undefined, 0)
      );
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
  it('calls chat-delivery for a kick with no advisory lock held', async () => {
    // The first eviction runs before the removal lock is taken, the second after its commit.
    await member('cut', BASE_ROLE);
    locksAtCall.length = 0;
    expect(await started(service.kickFromWorkspace(WS, 'cut', 'kicker')).outcome).toBe('allowed');
    expect(locksAtCall.length).toBeGreaterThan(0);
    expect(locksAtCall.every((n) => n === 0)).toBe(true);
  });

  it('refuses a rewrite whose salon changed after it was read, and saves nothing', async () => {
    // Another rewrite holds the row and adds 'late'; this one computed its removals from the row
    // before it, so it waits on the row lock, sees the change, and is refused whole.
    await member('late', BASE_ROLE);
    await member('kept', BASE_ROLE);
    const id = await salon(['salons', 'kept']);
    const other = await holder();
    try {
      await other.client.query('BEGIN');
      // Another access write, as every writer makes one: the list AND its revision.
      await other.client.query(
        `UPDATE channels SET "allowedUsers" = $1, "accessRevision" = "accessRevision" + 1
         WHERE id = $2`,
        ['salons,kept,late', id]
      );
      const rewrite = started(
        service.updateChannelAccess(id, 'salons', true, ['salons'], undefined, 0)
      );
      await blockedBy(other.pid, rewrite.settled);
      await other.client.query('COMMIT');
      expect(await rewrite.outcome).toBe(CHANNEL_ACCESS_CHANGED);
      expect(await allowedOn(id)).toEqual(['salons', 'kept', 'late']);
    } finally {
      await other.client.query('ROLLBACK').catch(() => undefined);
      await other.client.end();
    }
  });

  it('refuses a flip computed from a public row another admin made private meanwhile', async () => {
    // Admin B reads the salon public; admin A then commits it private (group G, A and Bob listed)
    // while B's mint is in flight. B's mint answers the same G, and recording it must not write back
    // B's stale public copy - or the check under the lock would see a public row, pass, and drop A
    // and Bob with no departure begun. B is refused whole and A's row stands.
    await member('bob', BASE_ROLE);
    const channels = ds.getRepository(Channel);
    const { id } = await channels.save(
      channels.create({ workspaceId: WS, name: `public-${salonSeq++}`, isPrivate: false })
    );
    const group = crypto.randomUUID();
    groups.set(id, group);
    beforeCreate = async () => {
      await q(
        `UPDATE channels SET "isPrivate" = true, "allowedUsers" = 'owner,bob', "distributionGroupId" = $1,
                "accessRevision" = "accessRevision" + 1
         WHERE id = $2`,
        [group, id]
      );
    };
    expect(await started(service.updateChannelAccess(id, 'owner2', true, [])).outcome).toBe(
      CHANNEL_ACCESS_CHANGED
    );
    const row = await channels.findOneByOrFail({ id });
    expect(row.isPrivate).toBe(true);
    expect(row.allowedUsers).toEqual(['owner', 'bob']);
    expect(row.distributionGroupId).toBe(group);
  });

  it('sends nothing for an invitation into a private salon deleted before its grant', async () => {
    // The salon is read private, then deleted while the invitee's devices are counted. Granting
    // nothing is not enough: announcing the invitation as a PUBLIC salon would hand the private
    // salon's name to the whole community.
    const id = await salon(['owner']);
    beforeCall = {
      on: '/count',
      run: async () => {
        await q(`DELETE FROM channels WHERE id = $1`, [id]);
      },
    };
    published.mockClear();
    const outcome = await started(
      service.inviteToChannel(id, { targetUserId: 'invitee-gone', actorUserId: 'owner' })
    ).outcome;
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(published).not.toHaveBeenCalled();
    // And no half-made invitation: the membership the call created is taken back.
    const rows: unknown[] = await q(
      `SELECT 1 FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'invitee-gone'`,
      [WS]
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses an admin join when the admin was demoted while it was in flight', async () => {
    // The join read the admin's roles; a demotion holds their membership row uncommitted. The grant
    // share-locks that row, so it waits, reads the committed demotion, and grants nothing.
    await member('admin-x', ADMIN_ROLE);
    const id = await salon(['owner']);
    const demotion = await holder();
    try {
      await demotion.client.query('BEGIN');
      await demotion.client.query(
        `UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = 'admin-x'`,
        [BASE_ROLE, WS]
      );
      const join = started(service.joinPrivateChannelAsAdmin(id, 'admin-x'));
      await blockedBy(demotion.pid, join.settled);
      await demotion.client.query('COMMIT');
      expect(await join.outcome).toBeInstanceOf(ForbiddenException);
      expect(await allowedOn(id)).toEqual(['owner']);
    } finally {
      await demotion.client.query('ROLLBACK').catch(() => undefined);
      await demotion.client.end();
    }
  });

  it('retries a kick whose target was granted a private salon since its read, and completes', async () => {
    // Between the kick's read of the salons its target holds and its roster write, the target is
    // granted another private salon, whose group that departure never cut. The departure is
    // superseded, and the kick tries again from a fresh read - which takes the salon too.
    await member('granted-late', BASE_ROLE);
    const id = await salon(['owner']);
    beforeCall = {
      on: 'members/granted-late',
      run: async () => {
        await q(`UPDATE channels SET "allowedUsers" = 'owner,granted-late' WHERE id = $1`, [id]);
      },
    };
    expect(await started(service.kickFromWorkspace(WS, 'granted-late', 'kicker')).outcome).toBe(
      'allowed'
    );
    expect(beforeCall).toBeNull();
    const rows: unknown[] = await q(
      `SELECT 1 FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'granted-late'`,
      [WS]
    );
    expect(rows).toHaveLength(0);
    expect(await allowedOn(id)).toEqual(['owner']);
  });

  it('refuses a private creation that leaves off someone who holds more than its creator', async () => {
    // 'owner' is an administrator: a member holding only `channel.manage` cannot hide a salon from
    // them, and an administrator can.
    const named = async (name: string): Promise<number> =>
      Number((await q(`SELECT count(*) AS n FROM channels WHERE name = $1`, [name]))[0].n);
    const create = (name: string, actorUserId: string) =>
      started(service.createChannel({ workspaceId: WS, name, visibility: 'private', actorUserId }))
        .outcome;
    expect(await create('cache', 'salons')).toBe('REMOVAL_EXCEEDS_ACTOR');
    expect(await named('cache')).toBe(0);
    expect(await create('bureau', 'owner')).toBe('allowed');
    expect(await named('bureau')).toBe(1);
  });

  /**
   * THE SETTINGS PANEL'S BASE. Admin A opens the access tab (one read), admin B grants someone, and
   * A then edits the write policy - sending the whole list it read. Without a base, the server
   * diffed that list against its own fresh read and cut B's grantee off, answering 200.
   */
  describe('an access rewrite names the revision it edited', () => {
    const revisionOf = async (channelId: string): Promise<number> =>
      (await ds.getRepository(Channel).findOneByOrFail({ id: channelId })).accessRevision;
    /** Every call to chat-delivery that names `userId` - an eviction is a DELETE on their member. */
    const evictionsOf = (userId: string): unknown[] =>
      (global.fetch as unknown as jest.Mock).mock.calls.filter(
        ([url, init]: [unknown, { method?: string } | undefined]) =>
          init?.method === 'DELETE' && String(url).includes(`/members/${userId}`)
      );
    /**
     * A private salon WITH a key-distribution group, so a removal from it is a real cut (an eviction
     * call to chat-delivery) rather than a roster write with nothing to evict.
     */
    const keyedSalon = async (allowed: string[]): Promise<string> => {
      const id = await salon(allowed);
      const group = crypto.randomUUID();
      groups.set(id, group);
      await q(`UPDATE channels SET "distributionGroupId" = $1 WHERE id = $2`, [group, id]);
      return id;
    };
    const departuresOf = async (userId: string): Promise<number> =>
      Number(
        (
          await q(`SELECT count(*) AS n FROM distribution_departures WHERE "userId" = $1`, [userId])
        )[0].n
      );

    /**
     * THE PINNED REGRESSION, reproduced on dev 2026-10-25 through the panel's own gestures: panel A
     * shows two allowed members; B grants W4 from its own panel (the server holds three); A, still
     * showing two, grants W5. A's PATCH was answered 200, W4's key distribution was cut
     * (`reason=access_updated`, a `departed` row) and the list became A's edit, with nothing said
     * on either screen. Now A is refused, W4 is untouched, and nothing is cut.
     */
    it('refuses the stale panel that grants W5 after B granted W4, and cuts nobody', async () => {
      await member('w4', BASE_ROLE);
      await member('w5', BASE_ROLE);
      const id = await keyedSalon(['salons', 'owner']);
      const panelA = await service.getChannelAccess(id, 'salons');
      const panelB = await service.getChannelAccess(id, 'owner');
      expect(panelA.allowedUsers).toEqual(['salons', 'owner']);

      // B's "Add": its own list plus W4, at the revision it read.
      await service.updateChannelAccess(
        id,
        'owner',
        true,
        [...panelB.allowedUsers, 'w4'],
        undefined,
        panelB.accessRevision
      );
      expect(await allowedOn(id)).toEqual(['salons', 'owner', 'w4']);
      (global.fetch as unknown as jest.Mock).mockClear();

      // A's "Add": the list it still shows, plus W5, at the revision it read.
      const refusal = await started(
        service.updateChannelAccess(
          id,
          'salons',
          true,
          [...panelA.allowedUsers, 'w5'],
          undefined,
          panelA.accessRevision
        )
      ).outcome;

      expect(refusal).toBe(CHANNEL_ACCESS_CHANGED);
      expect(await allowedOn(id)).toEqual(['salons', 'owner', 'w4']);
      expect(evictionsOf('w4')).toHaveLength(0);
      expect(await departuresOf('w4')).toBe(0);
      expect(await revisionOf(id)).toBe(panelB.accessRevision + 1);
    });

    it('the same sequence from a client that sends no base: W5 is granted, W4 is kept', async () => {
      await member('w4-old', BASE_ROLE);
      await member('w5-old', BASE_ROLE);
      const id = await keyedSalon(['salons', 'owner']);
      const panelA = await service.getChannelAccess(id, 'salons');
      await service.updateChannelAccess(id, 'owner', true, ['salons', 'owner', 'w4-old']);
      (global.fetch as unknown as jest.Mock).mockClear();

      await service.updateChannelAccess(id, 'salons', true, [...panelA.allowedUsers, 'w5-old']);

      expect(new Set(await allowedOn(id))).toEqual(
        new Set(['salons', 'owner', 'w4-old', 'w5-old'])
      );
      expect(evictionsOf('w4-old')).toHaveLength(0);
      expect(await departuresOf('w4-old')).toBe(0);
    });

    it('still cuts a member a CURRENT-base rewrite leaves off - the probe above sees a cut', async () => {
      // The control for the two cases above: the same list, sent at the revision the server holds,
      // is a deliberate removal, and the eviction it makes is exactly what `evictionsOf` counts.
      await member('w4-cut', BASE_ROLE);
      const id = await keyedSalon(['salons', 'owner', 'w4-cut']);
      (global.fetch as unknown as jest.Mock).mockClear();
      await service.updateChannelAccess(id, 'salons', true, ['salons', 'owner'], undefined, 0);
      expect(await allowedOn(id)).toEqual(['salons', 'owner']);
      expect(evictionsOf('w4-cut').length).toBeGreaterThan(0);
    });

    it("refuses A's stale rewrite after B's grant, and the grantee keeps access", async () => {
      await member('grantee', BASE_ROLE);
      const id = await salon(['salons', 'owner']);
      const panel = await service.getChannelAccess(id, 'salons');
      expect(panel.accessRevision).toBe(0);
      // B's grant: an administrator joining is one of the real writers of the list.
      await member('admin-b', ADMIN_ROLE);
      await service.joinPrivateChannelAsAdmin(id, 'admin-b');
      expect(await revisionOf(id)).toBe(1);

      const refusal = await service
        .updateChannelAccess(id, 'salons', true, panel.allowedUsers, 'admins', panel.accessRevision)
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(codeOf(refusal)).toBe(CHANNEL_ACCESS_CHANGED);
      expect(((refusal as HttpException).getResponse() as { current: unknown }).current).toEqual(
        expect.objectContaining({
          allowedUsers: ['salons', 'owner', 'admin-b'],
          accessRevision: 1,
          writePolicy: 'everyone',
        })
      );
      expect(await allowedOn(id)).toEqual(['salons', 'owner', 'admin-b']);
      expect(await revisionOf(id)).toBe(1);
    });

    it('saves a rewrite at the current revision, and raises it once', async () => {
      await member('next', BASE_ROLE);
      const id = await salon(['salons', 'owner']);
      const saved = await service.updateChannelAccess(
        id,
        'salons',
        true,
        ['salons', 'owner', 'next'],
        'admins',
        0
      );
      expect(saved).toMatchObject({ accessRevision: 1, allowedUsers: ['salons', 'owner', 'next'] });
      expect(await revisionOf(id)).toBe(1);
      // The same admin's next edit, at the revision the save answered, needs no reload.
      await service.updateChannelAccess(id, 'salons', true, saved.allowedUsers, 'everyone', 1);
      expect(await revisionOf(id)).toBe(2);
    });

    it('drops nobody on a baseless rewrite, and still saves its grant', async () => {
      await member('old-grant', BASE_ROLE);
      await member('old-new', BASE_ROLE);
      const id = await salon(['salons', 'owner', 'old-grant']);
      // An old panel that read the list before 'old-grant' was added, now granting 'old-new'.
      await service.updateChannelAccess(id, 'salons', true, ['salons', 'owner', 'old-new']);
      expect(new Set(await allowedOn(id))).toEqual(
        new Set(['salons', 'owner', 'old-grant', 'old-new'])
      );
      expect(await revisionOf(id)).toBe(1);
    });

    it('removes one member through the per-member route, and raises the revision', async () => {
      await member('revoked', BASE_ROLE);
      const id = await salon(['salons', 'revoked']);
      const removed = await service.removeMemberFromChannel(id, 'revoked', 'salons');
      expect(removed).toMatchObject({ success: true, accessRevision: 1, allowedUsers: ['salons'] });
      expect(await allowedOn(id)).toEqual(['salons']);
      expect(await revisionOf(id)).toBe(1);
    });

    it('answers exactly one of two rewrites made at the same revision', async () => {
      await member('race-a', BASE_ROLE);
      await member('race-b', BASE_ROLE);
      const id = await salon(['salons']);
      const outcomes = await Promise.all([
        started(service.updateChannelAccess(id, 'salons', true, ['salons', 'race-a'], undefined, 0))
          .outcome,
        started(service.updateChannelAccess(id, 'salons', true, ['salons', 'race-b'], undefined, 0))
          .outcome,
      ]);
      expect(outcomes.filter((o) => o === 'allowed')).toHaveLength(1);
      expect(outcomes.filter((o) => o === CHANNEL_ACCESS_CHANGED)).toHaveLength(1);
      const winner = outcomes[0] === 'allowed' ? 'race-a' : 'race-b';
      expect(await allowedOn(id)).toEqual(['salons', winner]);
      expect(await revisionOf(id)).toBe(1);
    });
  });
});
