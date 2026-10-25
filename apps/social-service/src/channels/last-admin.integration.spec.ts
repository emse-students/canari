/**
 * A COMMUNITY KEEPS AN ADMIN WHILE IT HAS MEMBERS, AGAINST A REAL POSTGRESQL - whatever two exits
 * from the admin set interleave.
 *
 * Leaving, being kicked and being demoted each answer an early last-admin check, then write. Two
 * of them that both passed the early check must not both commit: each writes under the community
 * removal lock and asks the check again there, with a plain read the lock makes current. A revoke
 * of `workspace.manage` on a role is asked the same question under the same lock; an erasure
 * promotes its successor under it, in the transaction that deletes the account's row; and an
 * admission asks there that the community still has members. Each race runs the second operation
 * to its commit from inside the first one's early read of the members, so the interleaving is
 * deterministic - never a sleep.
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
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
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
type ReadOptions = { where?: Record<string, unknown> } | undefined;

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

  /** Who still holds the administrator role. */
  const adminsOf = async (ws: string, adminRole: string): Promise<string[]> =>
    (await members.find({ where: { workspaceId: ws }, order: { userId: 'ASC' } }))
      .filter((r) => r.roleIds.includes(adminRole))
      .map((r) => r.userId);

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
    // chat-delivery, as a departure sees it: no community here has a key-distribution group.
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

  it('two demotions that each passed the early check: the second is refused', async () => {
    const { ws, roles } = await community();
    const ran = afterMembersRead(ws, 1, () =>
      service.updateWorkspaceMemberRole(ws, 'a1', 'Membre', 'a2')
    );
    const outcome = await settle(service.updateWorkspaceMemberRole(ws, 'a2', 'Membre', 'a1'));
    expect(ran()).toBe(true);
    expect(outcome).toBe(NO_ADMIN);
    expect(await adminsOf(ws, roles.admin)).toEqual(['a2']);
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

  it('a revoke of workspace.manage that would leave no admin is refused, and the role keeps it', async () => {
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
    const steward = crypto.randomUUID();
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions)
       VALUES ($1, $2, 'Intendance', 50, 'workspace.manage')`,
      [steward, ws]
    );
    await q(
      `UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = 'm1'`,
      [steward, ws]
    );
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
    let ran = false;
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      global.fetch = answer;
      ran = true;
      await service.leaveWorkspace(ws, 'a2');
      return answer(...args);
    }) as typeof fetch;
    try {
      await service.removeAccountFromWorkspaces(erased);
    } finally {
      global.fetch = answer;
    }
    expect(ran).toBe(true);
    expect(await adminsOf(ws, roles.admin)).toEqual(['m1']);
  });

  it('an invite accepted while the last member leaves is refused', async () => {
    const { ws } = await community();
    await q(`DELETE FROM channel_members WHERE "workspaceId" = $1 AND "userId" <> 'a1'`, [ws]);
    const { token } = await service.createWorkspaceInvite(ws, 'a1');
    // Reads #1 is the accept's preview; #2-#3 the leave's early check, #4 its count of who is left,
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
        await leaveDeparted;
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
      await leave;
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
