/**
 * COMMUNITY NICKNAMES AGAINST A REAL POSTGRESQL - migration 149 included ("Modifier les pseudos").
 *
 * What a mock cannot see: the migration on a table that predates it (and its re-run), the moderator
 * check read from the ROLE rows, the block read from `user_blocks`, the `UPDATE ... RETURNING` shape
 * node-postgres hands back, a clear that keeps its date, and the report of one VERSION of a nickname
 * - matched to the millisecond the client was handed against a `timestamptz` that keeps microseconds.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, created BEFORE the
 * DataSource initializes (see `channel-unread-clear.integration.spec.ts` for why), dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { HttpService } from '@nestjs/axios';
import { CommunityNicknamesService } from './community-nicknames.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ModerationService } from '../moderation/moderation.service';
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '149_community_nicknames.sql'),
  'utf8'
);

const WS = '00000000-0000-4000-8000-0000000001a1';
const MOD_ROLE = '00000000-0000-4000-8000-0000000001b1';
const MOD = 'moderator';
const MEMBER = 'member';
const TARGET = 'target';
const BLOCKER = 'blocker';
const OUTSIDER = 'outsider';

maybe('community nicknames against PostgreSQL (migration 149)', () => {
  const schema = `nick_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: CommunityNicknamesService;
  let moderation: ModerationService;
  const publishChannelEvent = jest.fn().mockResolvedValue(undefined);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

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
        ContentReport,
        UserModeration,
      ],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The table as production holds it BEFORE 149, then the migration - twice, as a deploy may.
    await q(`ALTER TABLE channel_members DROP COLUMN nickname, DROP COLUMN "nicknameSetBy",
             DROP COLUMN "nicknameSetAt"`);
    await q(migration);
    await q(migration);
    await q(`CREATE TABLE user_blocks ("blockerId" varchar(255), "blockedId" varchar(255))`);

    const members = ds.getRepository(ChannelMember);
    service = new CommunityNicknamesService(members, ds.getRepository(ChannelRole), {
      publishChannelEvent,
    } as unknown as RedisService);
    moderation = new ModerationService(
      ds.getRepository(ContentReport),
      ds.getRepository(UserModeration),
      {} as HttpService
    );

    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions)
       VALUES ($1, $2, 'Moderateur', 10, 'channel.moderate')`,
      [MOD_ROLE, WS]
    );
    for (const userId of [MOD, MEMBER, TARGET, BLOCKER]) {
      await members.save(
        members.create({ workspaceId: WS, userId, roleIds: userId === MOD ? [MOD_ROLE] : [] })
      );
    }
    await q(`INSERT INTO user_blocks ("blockerId", "blockedId") VALUES ($1, $2)`, [BLOCKER, MOD]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(() => publishChannelEvent.mockClear());

  it('adds three nullable columns, the length the contract states', async () => {
    const cols: { column_name: string; is_nullable: string; character_maximum_length: number }[] =
      await q(
        `SELECT column_name, is_nullable, character_maximum_length FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'channel_members'
            AND column_name IN ('nickname', 'nicknameSetBy', 'nicknameSetAt') ORDER BY column_name`,
        [schema]
      );
    expect(cols.map((c) => c.column_name)).toEqual(['nickname', 'nicknameSetAt', 'nicknameSetBy']);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
    expect(cols.find((c) => c.column_name === 'nickname')?.character_maximum_length).toBe(100);
  });

  it('lets a moderator name a member, announces it on workspace.updated, and lists it', async () => {
    const entry = await service.set(WS, MOD, TARGET, '  Capitaine ');
    expect(entry).toMatchObject({ userId: TARGET, nickname: 'Capitaine', setBy: MOD });
    expect(entry.at).toBeGreaterThan(0);
    expect(publishChannelEvent).toHaveBeenCalledWith(
      'workspace.updated',
      { workspaceId: WS, nickname: entry },
      expect.arrayContaining([MOD, MEMBER, TARGET, BLOCKER])
    );
    expect(await service.list(WS, MEMBER)).toEqual([entry]);
  });

  it('refuses a member who does not moderate, and lets the target clear their own - dated', async () => {
    await expect(service.set(WS, MEMBER, TARGET, 'Pirate')).rejects.toMatchObject({
      response: { code: 'NICKNAME_REQUIRES_MODERATION' },
    });
    await expect(service.set(WS, TARGET, TARGET, 'Self')).rejects.toMatchObject({
      response: { code: 'NICKNAME_REQUIRES_MODERATION' },
    });
    const cleared = await service.set(WS, TARGET, TARGET, '');
    expect(cleared).toMatchObject({ userId: TARGET, nickname: null, setBy: TARGET });
    // The clear stays listed with its date, so a client holding an older set drops it.
    expect(await service.list(WS, MOD)).toEqual([cleared]);
  });

  it('refuses a write across a block, either way round', async () => {
    await expect(service.set(WS, MOD, BLOCKER, 'X')).rejects.toMatchObject({
      response: { code: 'USER_BLOCKED' },
    });
  });

  it('refuses a target who is not a member, an actor who is not one, and a value too long', async () => {
    await expect(service.set(WS, MOD, OUTSIDER, 'X')).rejects.toMatchObject({
      response: { code: 'NICKNAME_TARGET_NOT_MEMBER' },
    });
    await expect(service.set(WS, OUTSIDER, TARGET, 'X')).rejects.toThrow(
      'Not a member of this workspace'
    );
    await expect(service.list(WS, OUTSIDER)).rejects.toThrow('Not a member of this workspace');
    await expect(service.set(WS, MOD, TARGET, 'x'.repeat(101))).rejects.toMatchObject({
      response: { code: 'nickname_too_long' },
    });
  });

  it('keeps the nickname out of every TypeORM read and save of a membership', async () => {
    await service.set(WS, MOD, MEMBER, 'Bosco');
    const members = ds.getRepository(ChannelMember);
    const row = await members.findOneOrFail({ where: { workspaceId: WS, userId: MEMBER } });
    expect(row.nickname).toBeUndefined();
    // A save of a row read earlier writes back what it read - and must not touch the nickname.
    row.readMarks = { any: 1 };
    await members.save(row);
    const [{ nickname }] = await q(
      `SELECT nickname FROM channel_members WHERE "workspaceId" = $1 AND "userId" = $2`,
      [WS, MEMBER]
    );
    expect(nickname).toBe('Bosco');
  });

  it('files a report on the version shown, names its setter, and refuses a changed one', async () => {
    const first = await service.set(WS, MOD, TARGET, 'Insulte');
    const report = await moderation.createReport({
      reporterId: MEMBER,
      contentType: 'nickname',
      contentId: first.reportSubject,
      reason: 'harassment',
      reportedUserId: 'forged',
    });
    expect(report.reportedUserId).toBe(MOD);

    // An outsider cannot report it - the route is no oracle for a community they are not in.
    await expect(
      moderation.createReport({
        reporterId: OUTSIDER,
        contentType: 'nickname',
        contentId: first.reportSubject,
        reason: 'harassment',
      })
    ).rejects.toMatchObject({ response: { code: 'CONTENT_NOT_FOUND' } });

    // Changed since: the version reported is gone, and the new one is a new subject.
    const second = await service.set(WS, MOD, TARGET, 'Autre');
    expect(second.reportSubject).not.toBe(first.reportSubject);
    await expect(
      moderation.createReport({
        reporterId: BLOCKER,
        contentType: 'nickname',
        contentId: first.reportSubject,
        reason: 'harassment',
      })
    ).rejects.toMatchObject({ response: { code: 'CONTENT_NOT_FOUND' } });
  });
});
