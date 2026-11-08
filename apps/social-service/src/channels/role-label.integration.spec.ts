/**
 * A COMMUNITY NAMES ITS THREE ROLES, AGAINST A REAL POSTGRESQL (owner, 2026-11-08).
 *
 * `channel_roles.displayLabel` (migration 150) is a LABEL beside the role's identity (`name`), which
 * every permission decision and every client of `minClientVersion` 1.6.6 still reads. What this
 * proves, on the real rows:
 *
 *  - an administrator renames a role, and a blank / null name resets it;
 *  - a moderator or a plain member is refused with the typed 403 `ROLE_RENAME_REQUIRES_ADMIN`, and
 *    nothing is written;
 *  - a name that is too long or holds a control character is refused with the typed 400
 *    `ROLE_LABEL_INVALID`;
 *  - the rename is a LABEL: `name`, the permissions and the canonical role of every roster row are
 *    exactly what they were, so an old client (which reads `name` and ignores the field it does not
 *    know) shows the same thing as before;
 *  - the rename is announced once, to the whole membership, carrying the name.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files. Locally, against a throwaway
 * PostgreSQL: `SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- role-label.integration`.
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes, dropped at the end.
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

/** The migration as production runs it, so the column the entity maps is the one CD creates. */
const MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '150_channel_roles_display_label.sql'),
  'utf8'
);

/** A refusal's typed code and status; the exception itself when it carries none. */
const refusal = (e: unknown): { status?: number; code?: unknown } =>
  e instanceof HttpException
    ? { status: e.getStatus(), code: (e.getResponse() as { code?: unknown }).code }
    : {};
const settle = (call: Promise<unknown>) =>
  call.then(
    () => ({ status: 200 }) as { status?: number; code?: unknown },
    (e: unknown) => refusal(e)
  );

maybe('role display names against PostgreSQL', () => {
  const schema = `role_label_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let roles: Repository<ChannelRole>;
  let members: Repository<ChannelMember>;
  let publish: jest.Mock;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** One community seeded the way `createWorkspace` seeds it: three roles, one holder each. */
  const community = async () => {
    const ws = crypto.randomUUID();
    const ids = {
      admin: crypto.randomUUID(),
      moderator: crypto.randomUUID(),
      member: crypto.randomUUID(),
    };
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', $2, 'a1')`,
      [ws, `w-${ws.slice(0, 8)}`]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES
         ($1, $4, 'Administrateur', 100, 'workspace.manage,role.manage'),
         ($2, $4, 'Modérateur', 50, 'channel.moderate'),
         ($3, $4, 'Membre', 10, '')`,
      [ids.admin, ids.moderator, ids.member, ws]
    );
    for (const [userId, roleId] of [
      ['a1', ids.admin],
      ['mod1', ids.moderator],
      ['m1', ids.member],
    ]) {
      await members.save(members.create({ workspaceId: ws, userId, roleIds: [roleId] }));
    }
    return { ws, ids };
  };

  const rowOf = (id: string) =>
    q(`SELECT name, priority, permissions, "displayLabel" FROM channel_roles WHERE id = $1`, [
      id,
    ]).then((r: Record<string, unknown>[]) => r[0]);

  beforeAll(async () => {
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
    // Production adds the column by migration; running it on top of the synchronized table also
    // proves it is idempotent where the column already exists.
    await q(MIGRATION);
    await q(MIGRATION);
    roles = ds.getRepository(ChannelRole);
    members = ds.getRepository(ChannelMember);
    publish = jest.fn().mockResolvedValue(undefined);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      roles,
      members,
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: publish } as unknown as RedisService
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(() => publish.mockClear());

  it('lets an administrator name a role, and a blank name resets it', async () => {
    const { ids } = await community();
    expect(await service.setRoleDisplayLabel(ids.admin, 'a1', '  Présidence ')).toEqual({
      roleId: ids.admin,
      roleName: 'Administrateur',
      label: 'Présidence',
    });
    expect((await rowOf(ids.admin)).displayLabel).toBe('Présidence');

    expect((await service.setRoleDisplayLabel(ids.admin, 'a1', '   ')).label).toBeNull();
    expect((await rowOf(ids.admin)).displayLabel).toBeNull();

    await service.setRoleDisplayLabel(ids.member, 'a1', 'Musicien');
    await service.setRoleDisplayLabel(ids.member, 'a1', null);
    expect((await rowOf(ids.member)).displayLabel).toBeNull();
  });

  it('refuses a moderator and a plain member with the typed 403, and writes nothing', async () => {
    const { ids } = await community();
    for (const actor of ['mod1', 'm1']) {
      expect(await settle(service.setRoleDisplayLabel(ids.member, actor, 'Pirate'))).toEqual({
        status: 403,
        code: 'ROLE_RENAME_REQUIRES_ADMIN',
      });
    }
    expect((await rowOf(ids.member)).displayLabel).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a stranger to the community with the same typed 403', async () => {
    const { ids } = await community();
    expect(await settle(service.setRoleDisplayLabel(ids.member, 'nobody', 'X'))).toEqual({
      status: 403,
      code: 'ROLE_RENAME_REQUIRES_ADMIN',
    });
  });

  it('refuses a name that is too long or holds a control character, typed 400', async () => {
    const { ids } = await community();
    for (const bad of ['x'.repeat(41), 'a\nb', 'a‮b', 42]) {
      expect(await settle(service.setRoleDisplayLabel(ids.member, 'a1', bad))).toEqual({
        status: 400,
        code: 'ROLE_LABEL_INVALID',
      });
    }
    // The limit is in characters a person sees: 40 emoji are 40, not 80.
    expect(
      (await service.setRoleDisplayLabel(ids.member, 'a1', '\u{1F3B5}'.repeat(40))).label
    ).toHaveLength(80);
    expect((await rowOf(ids.member)).displayLabel).not.toBeNull();
  });

  it('is a LABEL: identity, permissions and canonical roster roles are untouched', async () => {
    const { ws, ids } = await community();
    const before = await Promise.all(Object.values(ids).map(rowOf));

    await service.setRoleDisplayLabel(ids.admin, 'a1', 'Membre');
    await service.setRoleDisplayLabel(ids.member, 'a1', 'Administrateur');
    await service.setRoleDisplayLabel(ids.moderator, 'a1', 'Bureau');

    const after = await Promise.all(Object.values(ids).map(rowOf));
    expect(after.map(({ displayLabel: _l, ...rest }) => rest)).toEqual(
      before.map(({ displayLabel: _l, ...rest }) => rest)
    );
    // An old client reads `name` from the listing and the canonical `role` from the roster: a role
    // labelled "Membre" is still the administrator there, and the one labelled "Administrateur"
    // is still a member - the label folds into nothing.
    const roster = await service.listWorkspaceMembers(ws, 'a1');
    expect(Object.fromEntries(roster.map((r) => [r.userId, r.role]))).toEqual({
      a1: 'admin',
      mod1: 'moderator',
      m1: 'member',
    });
    const listed = await service.getWorkspaceBySlug(`w-${ws.slice(0, 8)}`, 'a1');
    expect(listed.roles.map((r) => r.name).sort((a, b) => a.localeCompare(b))).toEqual(
      ['Administrateur', 'Membre', 'Modérateur'].sort((a, b) => a.localeCompare(b))
    );
    // And the new client reads the label from the same listing.
    expect(listed.roles.find((r) => r.id === ids.moderator)?.displayLabel).toBe('Bureau');
    // Standing is the permissions' alone.
    expect(listed.workspace.viewerCanManage).toBe(true);
    const asMember = await service.getWorkspaceBySlug(`w-${ws.slice(0, 8)}`, 'm1');
    expect(asMember.workspace.viewerCanManage).toBe(false);
  });

  it('announces the name once, to the whole membership, with what the role grants', async () => {
    const { ws, ids } = await community();
    await service.setRoleDisplayLabel(ids.moderator, 'a1', 'Bureau');

    expect(publish).toHaveBeenCalledTimes(1);
    const [type, payload, audience] = publish.mock.calls[0];
    expect(type).toBe('workspace.role.permissions');
    expect(payload).toEqual({
      workspaceId: ws,
      roleId: ids.moderator,
      permissions: ['channel.moderate'],
      label: 'Bureau',
    });
    expect([...audience].sort((a, b) => a.localeCompare(b))).toEqual(['a1', 'm1', 'mod1']);

    publish.mockClear();
    await service.setRoleDisplayLabel(ids.moderator, 'a1', '');
    expect(publish.mock.calls[0][1].label).toBeNull();
  });

  it('a demotion that committed before the write is honoured: the former admin is refused', async () => {
    const { ws, ids } = await community();
    await members.save(members.create({ workspaceId: ws, userId: 'a2', roleIds: [ids.admin] }));
    await q(
      `UPDATE channel_members SET "roleIds" = $1 WHERE "workspaceId" = $2 AND "userId" = 'a2'`,
      [ids.member, ws]
    );
    expect(await settle(service.setRoleDisplayLabel(ids.member, 'a2', 'Coup'))).toEqual({
      status: 403,
      code: 'ROLE_RENAME_REQUIRES_ADMIN',
    });
  });
});
