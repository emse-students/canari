/**
 * A MEMBER WRITE NEVER INSERTS A ROW, AGAINST A REAL POSTGRESQL.
 *
 * A path that reads a membership and later writes it must write the COLUMNS it changes, keyed by the
 * row it read, and treat 0 rows updated as "the membership is gone". A TypeORM `save` of the entity
 * read is not that: it inserts the row again when it is missing, with every column it held. Each case
 * here lets a removal commit between the read and the write - the removal runs from inside the
 * service's own read, so the interleaving is deterministic (never a sleep) - and asserts that no
 * membership row is left for the removed user.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- member-write-gone.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { MEMBER_CHANGED_MEANWHILE } from './permissions';
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

maybe('a member write against PostgreSQL', () => {
  const schema = `member_write_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let members: Repository<ChannelMember>;
  let workspaces: Repository<Workspace>;
  let previousFetch: typeof fetch;
  let previousSecret: string | undefined;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** One fresh community per case: its three roles, and the members named with their role. */
  const community = async (seats: Record<string, 'admin' | 'mod' | 'base' | 'mgr'>) => {
    const ws = crypto.randomUUID();
    const roles = {
      admin: crypto.randomUUID(),
      mod: crypto.randomUUID(),
      base: crypto.randomUUID(),
      mgr: crypto.randomUUID(),
    };
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', $2, 'x')`,
      [ws, `w-${ws.slice(0, 8)}`]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES
         ($1, $4, 'Administrateur', 100, 'workspace.manage'),
         ($2, $4, 'Modérateur', 50, 'member.kick,member.invite'),
         ($3, $4, 'Membre', 10, ''),
         ($5, $4, 'Gestion', 20, 'role.manage')`,
      [roles.admin, roles.mod, roles.base, ws, roles.mgr]
    );
    for (const [userId, seat] of Object.entries(seats)) {
      await members.save(members.create({ workspaceId: ws, userId, roleIds: [roles[seat]] }));
    }
    const channel = await ds
      .getRepository(Channel)
      .save(
        ds.getRepository(Channel).create({ workspaceId: ws, name: 'general', isPrivate: false })
      );
    return { ws, roles, channelId: channel.id };
  };

  /** A refusal's typed code; the exception itself when it carries none. */
  const codeOf = (e: unknown): unknown =>
    (e instanceof HttpException ? (e.getResponse() as { code?: unknown }).code : undefined) ?? e;

  const rowOf = (ws: string, userId: string) =>
    members.findOne({ where: { workspaceId: ws, userId } });

  /**
   * Runs `hook` right after the service's next `method` read whose `where` satisfies `matches` has
   * answered - so `hook` commits between that read and whatever the service writes next. Answers
   * whether it ran, so a case proves its interleaving happened rather than assuming it.
   */
  const afterNextRead = (
    method: 'findOne' | 'find',
    matches: (where: Record<string, unknown>) => boolean,
    hook: () => Promise<unknown>,
    repo: Repository<ChannelMember> | Repository<Workspace> = members
  ): (() => boolean) => {
    let ran = false;
    const target = repo as Repository<ChannelMember>;
    const original = target[method].bind(target) as (o: ReadOptions) => Promise<unknown>;
    const spy = jest.spyOn(target, method).mockImplementation((async (o: ReadOptions) => {
      const answer = await original(o);
      if (matches(o?.where ?? {})) {
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
    workspaces = ds.getRepository(Workspace);
    service = new ChannelService(
      workspaces,
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

  it('a notification level set across a removal leaves no membership row', async () => {
    const { ws, channelId } = await community({ owner: 'admin', target: 'base' });
    const ran = afterNextRead(
      'findOne',
      (w) => w.userId === 'target',
      () => service.kickFromWorkspace(ws, 'target', 'owner')
    );
    const outcome = await service.setNotificationLevel(channelId, 'target', 'none').then(
      () => 'set',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(ForbiddenException);
    expect(await rowOf(ws, 'target')).toBeNull();
  });

  it('two devices setting two salons keep both levels', async () => {
    const { ws, channelId } = await community({ owner: 'admin', target: 'base' });
    const second = await ds
      .getRepository(Channel)
      .save(
        ds.getRepository(Channel).create({ workspaceId: ws, name: 'second', isPrivate: false })
      );
    const ran = afterNextRead(
      'findOne',
      (w) => w.userId === 'target',
      () => service.setNotificationLevel(second.id, 'target', 'mentions')
    );
    await service.setNotificationLevel(channelId, 'target', 'none');
    expect(ran()).toBe(true);
    expect((await rowOf(ws, 'target'))?.notifLevels).toEqual({
      [channelId]: 'none',
      [second.id]: 'mentions',
    });
  });

  // The role it names resolves: the case after this one writes it when nothing is removed.
  it('a role change across a removal leaves no membership row', async () => {
    const { ws } = await community({ owner: 'admin', target: 'base' });
    const ran = afterNextRead(
      'findOne',
      (w) => w.userId === 'target',
      () => service.kickFromWorkspace(ws, 'target', 'owner')
    );
    const outcome = await service
      .updateWorkspaceMemberRole(ws, 'target', 'Moderateur', 'owner')
      .then(
        () => 'set',
        (e: unknown) => e
      );
    expect(ran()).toBe(true);
    expect(codeOf(outcome)).toBe(MEMBER_CHANGED_MEANWHILE);
    expect(await rowOf(ws, 'target')).toBeNull();
  });

  it('a role change judged against roles changed since its read writes nothing', async () => {
    // The role manager may re-role a plain member, never a moderator. An administrator makes the
    // target a moderator after the manager's read and before its write.
    const { ws, roles } = await community({ owner: 'admin', mgr: 'mgr', target: 'base' });
    const ran = afterNextRead(
      'findOne',
      (w) => w.userId === 'target',
      () =>
        q(
          `UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = 'target'`,
          [roles.mod, ws]
        )
    );
    const outcome = await service.updateWorkspaceMemberRole(ws, 'target', 'Gestion', 'mgr').then(
      () => 'set',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(codeOf(outcome)).toBe(MEMBER_CHANGED_MEANWHILE);
    expect((await rowOf(ws, 'target'))?.roleIds).toEqual([roles.mod]);
  });

  it('a community image set across a history change keeps the history change', async () => {
    const { ws } = await community({ owner: 'admin' });
    const ran = afterNextRead(
      'findOne',
      (w) => w.id === ws,
      () => q(`UPDATE channel_workspaces SET "historyVisibility" = 'joined' WHERE id = $1`, [ws]),
      workspaces
    );
    await service.updateWorkspaceImage(ws, 'owner', 'media-1');
    expect(ran()).toBe(true);
    expect(await workspaces.findOneBy({ id: ws })).toMatchObject({
      imageMediaId: 'media-1',
      historyVisibility: 'joined',
    });
  });

  it('a history change across the community deletion does not bring the community back', async () => {
    const { ws } = await community({ owner: 'admin' });
    const ran = afterNextRead(
      'findOne',
      (w) => w.id === ws,
      () => q(`DELETE FROM channel_workspaces WHERE id = $1`, [ws]),
      workspaces
    );
    const outcome = await service.updateWorkspaceHistoryVisibility(ws, 'owner', 'joined').then(
      () => 'set',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(await workspaces.findOneBy({ id: ws })).toBeNull();
  });

  it('a role change with no removal still writes the role', async () => {
    const { ws, roles } = await community({ owner: 'admin', target: 'base' });
    await service.updateWorkspaceMemberRole(ws, 'target', 'Moderateur', 'owner');
    expect((await rowOf(ws, 'target'))?.roleIds).toEqual([roles.mod]);
  });

  it("an erasure's successor removed meanwhile is not written back; the next one is promoted", async () => {
    // Both candidates rank alike, so the user id decides: 'a-heir' first. 'a-heir' is removed to
    // its commit from inside the erasure's first call to chat-delivery (its eviction) - after the
    // erasure found other members, before its departure chooses the successor under the lock.
    const { ws, roles } = await community({ boss: 'admin', 'a-heir': 'mod', 'b-next': 'mod' });
    const answer = global.fetch;
    let ran = false;
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      global.fetch = answer;
      ran = true;
      await service.kickFromWorkspace(ws, 'a-heir', 'b-next');
      return answer(...args);
    }) as typeof fetch;
    try {
      expect(await service.removeAccountFromWorkspaces('boss')).toBe(1);
    } finally {
      global.fetch = answer;
    }
    expect(ran).toBe(true);
    expect(await rowOf(ws, 'a-heir')).toBeNull();
    expect((await rowOf(ws, 'b-next'))?.roleIds).toEqual([roles.admin]);
    expect(await rowOf(ws, 'boss')).toBeNull();
  });
});
