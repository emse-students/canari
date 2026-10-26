/**
 * A COMMUNITY KEEPS AN ADMIN WHILE IT HAS MEMBERS, AGAINST A REAL POSTGRESQL - whatever two writes
 * to its membership interleave.
 *
 * Leaving, being kicked and changing a member's role each answer an early check, then write under
 * the community removal lock and decide again there, from what holds then. A revoke of
 * `workspace.manage` on a role is asked the same question under the same lock; an erasure promotes
 * its successor under it, in the transaction that deletes the account's row, or deletes the
 * community it was the last member of; an admission asks there that the community still has
 * members; and a community's deletion takes it before anything else, so every writer here takes its
 * locks in one order - the removal lock, salon rows, member rows.
 *
 * Each race commits (or starts) the second operation from a hook inside the first: after one of its
 * reads, or inside its first call to chat-delivery. Where the second operation must be WAITING on a
 * lock before the first goes on, the hook waits for PostgreSQL to report it waiting
 * (`pg_stat_activity`) - a state, never a sleep - and stops waiting if it settled instead.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- last-admin.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ChannelService } from './channel.service';
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

/** The `where` of a repository read, as the service passes it. */
type ReadOptions = { where?: Record<string, unknown>; lock?: { mode?: string } } | undefined;

const NO_ADMIN = 'WORKSPACE_WOULD_HAVE_NO_ADMIN';

maybe('the last admin against PostgreSQL', () => {
  const schema = `last_admin_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let members: Repository<ChannelMember>;
  let previousFetch: typeof fetch;
  let previousSecret: string | undefined;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** One fresh community per case: two administrators and one plain member. */
  const community = async () => {
    const ws = crypto.randomUUID();
    const roles = { admin: crypto.randomUUID(), base: crypto.randomUUID() };
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', $2, 'a1')`,
      [ws, `w-${ws.slice(0, 8)}`]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES
         ($1, $3, 'Administrateur', 100, 'workspace.manage'),
         ($2, $3, 'Membre', 10, '')`,
      [roles.admin, roles.base, ws]
    );
    for (const [userId, roleId] of [
      ['a1', roles.admin],
      ['a2', roles.admin],
      ['m1', roles.base],
    ]) {
      await members.save(members.create({ workspaceId: ws, userId, roleIds: [roleId] }));
    }
    return { ws, roles };
  };

  /** A role named `name` in `ws`, carrying `permissions` (comma-joined, as the column stores them). */
  const addRole = async (ws: string, name: string, permissions: string) => {
    const id = crypto.randomUUID();
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES ($1, $2, $3, 50, $4)`,
      [id, ws, name, permissions]
    );
    return id;
  };

  /** Gives `userId` exactly the role `roleId`. */
  const setRole = (ws: string, userId: string, roleId: string) =>
    q(`UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = $3`, [
      roleId,
      ws,
      userId,
    ]);

  /** A private salon in `ws`, so a departure and a deletion both have a salon row to lock. */
  const privateSalon = async (ws: string, allowed: string[]) => {
    const id = crypto.randomUUID();
    await q(
      `INSERT INTO channels (id, "workspaceId", name, "isPrivate", "allowedUsers") VALUES ($1, $2, 'p', true, $3)`,
      [id, ws, allowed.join(',')]
    );
    return id;
  };

  /** Who still holds the administrator role. */
  const adminsOf = async (ws: string, adminRole: string): Promise<string[]> =>
    (await members.find({ where: { workspaceId: ws }, order: { userId: 'ASC' } }))
      .filter((r) => r.roleIds.includes(adminRole))
      .map((r) => r.userId);

  /** Who holds ANY role carrying `workspace.manage` - the definition of an admin. */
  const governorsOf = async (ws: string): Promise<string[]> => {
    const roles = (await q(`SELECT id, permissions FROM channel_roles WHERE "workspaceId" = $1`, [
      ws,
    ])) as { id: string; permissions: string }[];
    const managing = new Set(
      roles.filter((r) => r.permissions.split(',').includes('workspace.manage')).map((r) => r.id)
    );
    return (await members.find({ where: { workspaceId: ws }, order: { userId: 'ASC' } }))
      .filter((r) => r.roleIds.some((id) => managing.has(id)))
      .map((r) => r.userId);
  };

  /** How many rows of `ws` each table still holds. */
  const leftOf = async (ws: string) => ({
    workspaces: (await q(`SELECT 1 FROM channel_workspaces WHERE id = $1`, [ws])).length,
    members: await members.count({ where: { workspaceId: ws } }),
    salons: (await q(`SELECT 1 FROM channels WHERE "workspaceId" = $1`, [ws])).length,
  });

  /** A refusal's typed code; the exception itself when it carries none. */
  const codeOf = (e: unknown): unknown =>
    (e instanceof HttpException ? (e.getResponse() as { code?: unknown }).code : undefined) ?? e;
  const settle = (call: Promise<unknown>) =>
    call.then(
      () => 'allowed' as unknown,
      (e: unknown) => codeOf(e)
    );

  /**
   * Runs `hook` right after the service's `nth` read of the whole community's membership rows
   * (a `find` naming the community and no user) has answered - the read an early last-admin check
   * makes - so `hook` commits between that check and the write. Answers whether it ran.
   */
  const afterMembersRead = (
    ws: string,
    nth: number,
    hook: () => Promise<unknown>
  ): (() => boolean) => {
    let seen = 0;
    let ran = false;
    const original = members.find.bind(members) as (o: ReadOptions) => Promise<unknown>;
    const spy = jest.spyOn(members, 'find').mockImplementation((async (o: ReadOptions) => {
      const answer = await original(o);
      const where = o?.where ?? {};
      if (where.workspaceId === ws && where.userId === undefined && ++seen === nth) {
        spy.mockRestore();
        ran = true;
        await hook();
      }
      return answer;
    }) as never);
    return () => ran;
  };

  /** Runs `hook` once, right after the first role read by name `name` has answered. */
  const afterRoleRead = (name: string, hook: () => Promise<unknown>): (() => boolean) => {
    let ran = false;
    const roles = ds.getRepository(ChannelRole);
    const original = roles.findOne.bind(roles) as (o: ReadOptions) => Promise<unknown>;
    const spy = jest.spyOn(roles, 'findOne').mockImplementation((async (o: ReadOptions) => {
      const answer = await original(o);
      if (o?.where?.name === name) {
        spy.mockRestore();
        ran = true;
        await hook();
      }
      return answer;
    }) as never);
    return () => ran;
  };

  /**
   * Runs `hook` once, right after an `EntityManager` call that `matches` has answered - what a
   * transaction's repository makes, so `hook` runs while that transaction is still open. `matches`
   * is given the entity and the call's options (`find`), row (`save`) or new values (`update`).
   */
  const insideTransaction = (
    method: 'find' | 'save' | 'update',
    matches: (entity: unknown, arg: unknown) => boolean,
    hook: () => Promise<unknown>
  ): (() => boolean) => {
    let ran = false;
    const original = EntityManager.prototype[method] as (...a: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(EntityManager.prototype, method).mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      const answer = await original.apply(this, args);
      if (!ran && matches(args[0], method === 'update' ? args[2] : args[1])) {
        ran = true;
        spy.mockRestore();
        await hook();
      }
      return answer;
    } as never);
    return () => ran;
  };

  /**
   * Starts `operation` and returns once PostgreSQL reports another session waiting on a lock - the
   * operation is blocked behind the transaction the caller holds - or once the operation settled
   * without ever waiting. A state read from the server, never a clock. The outcome comes back
   * WRAPPED: awaiting a bare promise here would wait for the operation, which waits for the caller.
   */
  const startUntilWaiting = async (
    operation: () => Promise<unknown>
  ): Promise<{ outcome: Promise<unknown> }> => {
    let settled = false;
    const outcome = settle(operation()).finally(() => {
      settled = true;
    });
    while (!settled) {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if (rows[0].n > 0) break;
    }
    return { outcome };
  };

  /** Swaps chat-delivery for one call: `hook` runs, then the call is answered as usual. */
  const insideFirstDeliveryCall = (hook: () => Promise<unknown>): (() => boolean) => {
    const answer = global.fetch;
    let ran = false;
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      global.fetch = answer;
      ran = true;
      await hook();
      return answer(...args);
    }) as typeof fetch;
    return () => ran;
  };

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
    members = ds.getRepository(ChannelMember);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      members,
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    // chat-delivery, as a departure and a deletion see it: no community here has a key group.
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ evicted: false }), { status: 200 })
    ) as unknown as typeof fetch;
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

  it('two self-demotions that each passed the early check: the second is refused', async () => {
    const { ws, roles } = await community();
    const ran = afterMembersRead(ws, 1, () =>
      service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a2')
    );
    const outcome = await settle(service.updateWorkspaceMemberRole(ws, 'a1', 'Membre', 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await adminsOf(ws, roles.admin)).toEqual(['a1']);
  });

  it('a leave that passed the early check, racing a demotion: the leave is refused', async () => {
    const { ws, roles } = await community();
    const ran = afterMembersRead(ws, 1, () =>
      service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a1')
    );
    const outcome = await settle(service.leaveWorkspace(ws, 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await adminsOf(ws, roles.admin)).toEqual(['a1']);
  });

  it('a demotion that passed the early check, racing a kick: the demotion is refused', async () => {
    const { ws, roles } = await community();
    const ran = afterMembersRead(ws, 1, () => service.kickFromWorkspace(ws, 'a1', 'a2'));
    const outcome = await settle(service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a2'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await adminsOf(ws, roles.admin)).toEqual(['a2']);
  });

  it('a kick that passed the early check, racing a demotion: the kick is refused', async () => {
    // The kick's first community read is its actor bound; the second is the last-admin check.
    const { ws, roles } = await community();
    const ran = afterMembersRead(ws, 2, () =>
      service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a2')
    );
    const outcome = await settle(service.kickFromWorkspace(ws, 'a1', 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await adminsOf(ws, roles.admin)).toEqual(['a1']);
  });

  it('a role change whose new role lost workspace.manage meanwhile is decided as the demotion it now is', async () => {
    // a1 is the only admin and moves to a role that carries workspace.manage when it is read; the
    // role loses it before the write (allowed: a1 still holds Administrateur then).
    const { ws, roles } = await community();
    await setRole(ws, 'a2', roles.base);
    const steward = await addRole(ws, 'Intendance', 'workspace.manage');
    const ran = afterRoleRead('Intendance', () =>
      service.setRoleBasePermission(steward, 'a1', 'workspace.manage', false)
    );
    const outcome = await settle(service.updateWorkspaceMemberRole(ws, 'a1', 'Intendance', 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await governorsOf(ws)).toEqual(['a1']);
  });

  it('a role change whose actor lost the right to make it meanwhile is refused', async () => {
    // a1 moves m1 out of a role that grants nothing yet. Meanwhile that role gains
    // workspace.manage, a2 leaves, and m1 - an admin now - demotes a1. Judged on what a1 held
    // before, the change would take away the last admin.
    const { ws } = await community();
    const steward = await addRole(ws, 'Intendance', '');
    await setRole(ws, 'm1', steward);
    const ran = afterMembersRead(ws, 1, async () => {
      await service.setRoleBasePermission(steward, 'a1', 'workspace.manage', true);
      await service.leaveWorkspace(ws, 'a2');
      await service.updateWorkspaceMemberRole(ws, 'a1', 'Membre', 'm1');
    });
    const outcome = await settle(service.updateWorkspaceMemberRole(ws, 'm1', 'Membre', 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(ForbiddenException);
    expect(await governorsOf(ws)).toEqual(['m1']);
  });

  it('a revoke of workspace.manage that would leave no admin is refused, and the role keeps it', async () => {
    // A plain refusal, no race: the guard asked under the lock.
    const { ws, roles } = await community();
    const outcome = await settle(
      service.setRoleBasePermission(roles.admin, 'a1', 'workspace.manage', false)
    );
    expect(outcome).toBe(NO_ADMIN);
    const [role] = await q(`SELECT permissions FROM channel_roles WHERE id = $1`, [roles.admin]);
    expect(String((role as { permissions: string }).permissions)).toContain('workspace.manage');
    expect(await adminsOf(ws, roles.admin)).toEqual(['a1', 'a2']);
  });

  it('a revoke of workspace.manage while another role still grants it is allowed', async () => {
    const { ws, roles } = await community();
    await setRole(ws, 'm1', await addRole(ws, 'Intendance', 'workspace.manage'));
    expect(
      await settle(service.setRoleBasePermission(roles.admin, 'a1', 'workspace.manage', false))
    ).toBe('allowed');
  });

  it('an erasure whose other admin leaves meanwhile still promotes a successor', async () => {
    // The other admin leaves to its commit from inside the erasure's first call to chat-delivery
    // (its eviction): after anything decided before the departure, before the account's row goes.
    // The erased account belongs to this community alone: an erasure leaves every community.
    const { ws, roles } = await community();
    const erased = `x-${ws.slice(0, 8)}`;
    await q(
      `UPDATE channel_members SET "userId" = $1 WHERE "workspaceId" = $2 AND "userId" = 'a1'`,
      [erased, ws]
    );
    const answer = global.fetch;
    const ran = insideFirstDeliveryCall(() => service.leaveWorkspace(ws, 'a2'));
    try {
      await service.removeAccountFromWorkspaces(erased);
    } finally {
      global.fetch = answer;
    }
    expect(ran()).toBe(true);
    expect(await adminsOf(ws, roles.admin)).toEqual(['m1']);
  });

  it('an erasure whose community empties meanwhile deletes it, and a failed deletion is found again by the retry', async () => {
    // The erased account and m1 are left. m1 leaves from inside the erasure's eviction, so the
    // account is the last member when its departure would commit; the deletion that follows fails
    // once at chat-delivery. The account's row must still name the community for the retry.
    const { ws } = await community();
    const erased = `x-${ws.slice(0, 8)}`;
    await q(`DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'a2'`, [ws]);
    await q(
      `UPDATE channel_members SET "userId" = $1 WHERE "workspaceId" = $2 AND "userId" = 'a1'`,
      [erased, ws]
    );
    const answer = global.fetch;
    const ran = insideFirstDeliveryCall(async () => {
      await service.leaveWorkspace(ws, 'm1');
      // The next call to chat-delivery - the community's deletion - fails once.
      global.fetch = (async () => {
        global.fetch = answer;
        return new Response('', { status: 503 });
      }) as typeof fetch;
    });
    // The failed deletion is reported at error, as it must be; this case expects exactly that.
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect(await settle(service.removeAccountFromWorkspaces(erased))).toBe(
        'ERASURE_WORKSPACE_REPAIR_FAILED'
      );
    } finally {
      global.fetch = answer;
      errors.mockRestore();
    }
    expect(ran()).toBe(true);
    expect(await members.count({ where: { workspaceId: ws, userId: erased } })).toBe(1);

    expect(await service.removeAccountFromWorkspaces(erased)).toBe(1);
    expect(await leftOf(ws)).toEqual({ workspaces: 0, members: 0, salons: 0 });
  });

  it('an erasure deleting a community it was the last member of admits nobody meanwhile', async () => {
    // A link is accepted from inside the deletion's first call to chat-delivery, after the erasure
    // decided the account was alone: it must find the door closed, not join and be deleted.
    const { ws } = await community();
    const erased = `x-${ws.slice(0, 8)}`;
    await q(`DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" <> 'a1'`, [ws]);
    const { token } = await service.createWorkspaceInvite(ws, 'a1');
    await q(
      `UPDATE channel_members SET "userId" = $1 WHERE "workspaceId" = $2 AND "userId" = 'a1'`,
      [erased, ws]
    );
    const answer = global.fetch;
    let joined: unknown;
    const ran = insideFirstDeliveryCall(async () => {
      joined = await settle(service.acceptWorkspaceInvite(token, 'n1'));
    });
    try {
      expect(await service.removeAccountFromWorkspaces(erased)).toBe(1);
    } finally {
      global.fetch = answer;
    }
    expect(ran()).toBe(true);
    expect(joined).not.toBe('allowed');
    expect(await leftOf(ws)).toEqual({ workspaces: 0, members: 0, salons: 0 });
  });

  it('an invite accepted while an administrator deletes the community leaves no membership behind', async () => {
    // The accept holds its admission open (the joiner written, not committed) until the deletion is
    // waiting on a lock, then commits.
    const { ws } = await community();
    const { token } = await service.createWorkspaceInvite(ws, 'a1');
    let deletion: Promise<unknown> = Promise.resolve();
    const ran = insideTransaction(
      'save',
      (_entity, row) => (row as { userId?: string } | undefined)?.userId === 'n1',
      async () => {
        deletion = (await startUntilWaiting(() => service.deleteWorkspace(ws, 'a1', 'W'))).outcome;
      }
    );
    const accepted = await settle(service.acceptWorkspaceInvite(token, 'n1'));
    expect(ran()).toBe(true);
    expect(accepted).toBe('allowed');
    expect(await deletion).toBe('allowed');
    expect(await leftOf(ws)).toEqual({ workspaces: 0, members: 0, salons: 0 });
  });

  it('a kick and a deletion of the same community both complete, in one lock order', async () => {
    // The kick holds its removal transaction open after reading its member rows under a shared lock
    // until the deletion is waiting on a lock. In two orders the two would deadlock.
    const { ws } = await community();
    await privateSalon(ws, ['a1', 'a2']);
    let deletion: Promise<unknown> = Promise.resolve();
    const ran = insideTransaction(
      'find',
      (entity, options) =>
        entity === ChannelMember && (options as ReadOptions)?.lock?.mode === 'pessimistic_read',
      async () => {
        deletion = (await startUntilWaiting(() => service.deleteWorkspace(ws, 'a1', 'W'))).outcome;
      }
    );
    const kicked = await settle(service.kickFromWorkspace(ws, 'm1', 'a2'));
    expect(ran()).toBe(true);
    expect(kicked).toBe('allowed');
    expect(await deletion).toBe('allowed');
    expect(await leftOf(ws)).toEqual({ workspaces: 0, members: 0, salons: 0 });
  });

  it("an erasure's promotion and a salon grant to the successor both complete, in one lock order", async () => {
    // The erasure holds its departure open right after writing the successor's row until a grant
    // of a private salon to that successor is waiting on a lock.
    const { ws, roles } = await community();
    const erased = `x-${ws.slice(0, 8)}`;
    await q(`DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'a2'`, [ws]);
    await q(
      `UPDATE channel_members SET "userId" = $1 WHERE "workspaceId" = $2 AND "userId" = 'a1'`,
      [erased, ws]
    );
    const salon = await privateSalon(ws, [erased]);
    let grant: Promise<unknown> = Promise.resolve();
    const grantTo = (userId: string) =>
      (
        service as unknown as {
          grantPrivateChannelAccess: (c: string, u: string) => Promise<{ outcome: string }>;
        }
      ).grantPrivateChannelAccess(salon, userId);
    const ran = insideTransaction(
      'update',
      (entity, partial) =>
        entity === ChannelMember &&
        Array.isArray((partial as { roleIds?: unknown })?.roleIds) &&
        (partial as { roleIds: string[] }).roleIds.includes(roles.admin),
      async () => {
        grant = (await startUntilWaiting(() => grantTo('m1'))).outcome;
      }
    );
    expect(await settle(service.removeAccountFromWorkspaces(erased))).toBe('allowed');
    expect(ran()).toBe(true);
    expect(await grant).toBe('allowed');
    expect(await adminsOf(ws, roles.admin)).toEqual(['m1']);
    const [row] = (await q(`SELECT "allowedUsers" FROM channels WHERE id = $1`, [salon])) as {
      allowedUsers: string;
    }[];
    expect(row.allowedUsers.split(',')).toEqual(['m1']);
  });

  it('an invite accepted while the last member leaves is refused', async () => {
    const { ws } = await community();
    await q(`DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" <> 'a1'`, [ws]);
    const { token } = await service.createWorkspaceInvite(ws, 'a1');
    // Read #1 is the accept's preview; #2-#3 the leave's early check, #4 its count of who is left,
    // held there so the leave's hard delete waits until the accept has answered.
    let seen = 0;
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    let reachedCount!: () => void;
    const leaveDeparted = new Promise<void>((r) => (reachedCount = r));
    let leave: Promise<unknown> = Promise.resolve();
    const original = members.find.bind(members) as (o: ReadOptions) => Promise<unknown>;
    const spy = jest.spyOn(members, 'find').mockImplementation((async (o: ReadOptions) => {
      const answer = await original(o);
      const where = o?.where ?? {};
      if (where.workspaceId !== ws || where.userId !== undefined) return answer;
      seen += 1;
      if (seen === 1) {
        leave = service.leaveWorkspace(ws, 'a1');
        // FAIL FAST: a leave that ends - answered or thrown - before its count of who is left was
        // never held there, and waiting for it would hang to the test's timeout.
        await Promise.race([
          leaveDeparted,
          leave.then(
            () => Promise.reject(new Error('the leave ended before its count of who is left')),
            (e: unknown) => Promise.reject(e)
          ),
        ]);
      } else if (seen === 4) {
        reachedCount();
        await gate;
      }
      return answer;
    }) as never);
    try {
      const outcome = await settle(service.acceptWorkspaceInvite(token, 'n1'));
      expect(outcome).toBe('WORKSPACE_HAS_NO_MEMBERS');
      expect(await members.count({ where: { workspaceId: ws, userId: 'n1' } })).toBe(0);
    } finally {
      released();
      await leave.catch(() => undefined);
      spy.mockRestore();
    }
    expect(await q(`SELECT 1 FROM channel_workspaces WHERE id = $1`, [ws])).toHaveLength(0);
  });

  it('one admin demoting the other while they stay admin is allowed', async () => {
    const { ws, roles } = await community();
    expect(await settle(service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a1'))).toBe(
      'allowed'
    );
    expect(await adminsOf(ws, roles.admin)).toEqual(['a1']);
  });
});
