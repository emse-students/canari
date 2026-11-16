/**
 * A SALON HANDED TO A MEMBER COUNTS ONLY WHAT ARRIVES AFTER IT, AGAINST A REAL POSTGRESQL.
 *
 * The owner's decision of 2026-11-16 (principle 3 of `docs/principes.md`, "your attention is not for
 * sale"): a private salon granted to a long-standing member badged its whole past as unread, because
 * nothing recorded WHEN access was given and the count's floor was the member's arrival in the
 * community. Every grant now raises the grantee's private `clearedMarks[salon]` to the grant
 * (`floorUnreadAtGrant`), in the grant's transaction, and `listUnreadCounts` already reads it. A mock
 * proves the write is made; only the real SQL proves the count that follows is 1 and not 11, and that
 * the database's clock - the one `createdAt` comes from - is what the floor is taken on.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- channel-grant-unread-floor.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import * as crypto from 'crypto';
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
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** `distribution_departures`, as production gets it: an access rewrite's roster write records into it. */
const DEPARTURES_MIGRATION = readFileSync(
  join(__dirname, '..', 'migrations', '108_distribution_departures.sql'),
  'utf8'
);

/** Fresh per run: the community removal lock is a database-wide advisory key. */
const WS = crypto.randomUUID();
const SALONS_ROLE = '00000000-0000-4000-8000-0000000000e4';
const BASE_ROLE = '00000000-0000-4000-8000-0000000000e5';
/** Ten rows of the salon's past, all before any grant here. */
const PAST = 10;

maybe('a salon granted late badges only what arrives after the grant (PostgreSQL)', () => {
  const schema = `grant_floor_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let previousFetch: typeof fetch;
  let previousSecret: string | undefined;
  let salonSeq = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** A member who joined the community long ago, so the arrival floor hides nothing posted here. */
  const member = async (userId: string, roleId = BASE_ROLE) => {
    const members = ds.getRepository(ChannelMember);
    await members.save(members.create({ workspaceId: WS, userId, roleIds: [roleId] }));
    await q(
      `UPDATE channel_members SET "createdAt" = '2026-01-01' WHERE "workspaceId" = $1 AND "userId" = $2`,
      [WS, userId]
    );
  };
  /** A private salon listing `allowed`, with {@link PAST} rows from `author` in its past. */
  const salonWithPast = async (allowed: string[], author = 'salons'): Promise<string> => {
    const channels = ds.getRepository(Channel);
    const row = await channels.save(
      channels.create({
        workspaceId: WS,
        name: `prive-${salonSeq++}`,
        isPrivate: true,
        allowedUsers: allowed,
      })
    );
    for (let i = 0; i < PAST; i += 1) {
      await q(
        `INSERT INTO channel_messages ("workspaceId", "channelId", "authorId", content, "createdAt")
         VALUES ($1, $2, $3, 'x', $4)`,
        [WS, row.id, author, `2026-11-01 10:00:${String(i).padStart(2, '0')}.123456`]
      );
    }
    return row.id;
  };
  /** The private floor the grant stored for `userId` on `channelId`, or null. */
  const floorOf = async (userId: string, channelId: string): Promise<number | null> => {
    const [row]: { at: string | null }[] = await q(
      `SELECT ("clearedMarks" ->> $3::text) AS at FROM channel_members
        WHERE "workspaceId" = $1 AND "userId" = $2`,
      [WS, userId, channelId]
    );
    return row?.at == null ? null : Number(row.at);
  };
  /**
   * One row from a peer, stamped `offsetMs` after the floor of `userId` - a position relative to the
   * stored mark, never a wall clock.
   */
  const postAfterFloor = async (channelId: string, userId: string, offsetMs: number) => {
    const floor = await floorOf(userId, channelId);
    if (floor === null) throw new Error(`no floor for ${userId} on ${channelId}`);
    await q(
      `INSERT INTO channel_messages ("workspaceId", "channelId", "authorId", content, "createdAt")
       VALUES ($1, $2, 'peer', 'x', to_timestamp($3::bigint / 1000.0) AT TIME ZONE 'UTC')`,
      [WS, channelId, floor + offsetMs]
    );
  };
  const countOf = async (userId: string, channelId: string): Promise<number | undefined> =>
    (await service.listUnreadCounts(userId)).counts[channelId];
  const grant = (channelId: string, userId: string) =>
    (
      service as unknown as {
        grantPrivateChannelAccess: (c: string, u: string) => Promise<{ outcome: string }>;
      }
    ).grantPrivateChannelAccess(channelId, userId);
  const revisionOf = async (channelId: string): Promise<number> =>
    (await ds.getRepository(Channel).findOneByOrFail({ id: channelId })).accessRevision;

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
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      ds.getRepository(ChannelMember),
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    // chat-delivery, as an access rewrite sees it: a group create answers one id per scope, an
    // eviction finds no group. The announcements are not what this file judges.
    const groups = new Map<string, string>();
    global.fetch = jest.fn(async (_url: unknown, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const { scopeId } = JSON.parse(init.body) as { scopeId: string };
        if (!groups.has(scopeId)) groups.set(scopeId, crypto.randomUUID());
        return new Response(JSON.stringify({ groupId: groups.get(scopeId) }), { status: 200 });
      }
      return new Response(JSON.stringify({ evicted: false }), { status: 200 });
    }) as unknown as typeof fetch;
    jest
      .spyOn(service as never, 'announceChannelAccessGranted' as never)
      .mockResolvedValue(undefined as never);
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w-grant-floor', 'salons')`,
      [WS]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions) VALUES
         ($1, $3, 'Salons', 30, 'channel.manage'),
         ($2, $3, 'Membre', 10, '')`,
      [SALONS_ROLE, BASE_ROLE, WS]
    );
    await member('salons', SALONS_ROLE);
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

  it('a grant floors the count: ten rows of past and one after the grant count 1, not 11', async () => {
    await member('late');
    const salon = await salonWithPast(['salons']);

    expect(await grant(salon, 'late')).toMatchObject({ outcome: 'granted' });
    // The past is not unread, and the read mark - the "Lu par" receipt - did not move.
    expect(await countOf('late', salon)).toBeUndefined();
    const [row]: { readMarks: object }[] = await q(
      `SELECT "readMarks" FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'late'`,
      [WS]
    );
    expect(row.readMarks).toEqual({});

    // A row stamped AT the floor is the grant's own millisecond; one after it is news.
    await postAfterFloor(salon, 'late', 0);
    await postAfterFloor(salon, 'late', 1);
    expect(await countOf('late', salon)).toBe(1);
  });

  it('never lowers a floor the member had already cleared past', async () => {
    await member('ahead');
    const salon = await salonWithPast(['salons']);
    const ahead = Date.parse('2099-01-01T00:00:00Z');
    await q(
      `UPDATE channel_members SET "clearedMarks" = jsonb_build_object($3::text, $4::bigint)
        WHERE "workspaceId" = $1 AND "userId" = $2`,
      [WS, 'ahead', salon, ahead]
    );

    expect(await grant(salon, 'ahead')).toMatchObject({ outcome: 'granted' });
    expect(await floorOf('ahead', salon)).toBe(ahead);
  });

  it('an access rewrite that adds a member floors theirs, and nobody else', async () => {
    await member('added');
    const salon = await salonWithPast(['salons'], 'peer');

    await service.updateChannelAccess(
      salon,
      'salons',
      true,
      ['salons', 'added'],
      undefined,
      await revisionOf(salon)
    );

    expect(await countOf('added', salon)).toBeUndefined();
    // The member who already read the salon keeps their own count of its past.
    expect(await floorOf('salons', salon)).toBeNull();
    expect(await countOf('salons', salon)).toBe(PAST);
    await postAfterFloor(salon, 'added', 1);
    expect(await countOf('added', salon)).toBe(1);
  });

  it('a private salon made public floors every member it did not name', async () => {
    await member('outsider');
    const salon = await salonWithPast(['salons'], 'peer');

    await service.updateChannelAccess(
      salon,
      'salons',
      false,
      [],
      undefined,
      await revisionOf(salon)
    );

    expect(await countOf('outsider', salon)).toBeUndefined();
    expect(await floorOf('salons', salon)).toBeNull();
    await postAfterFloor(salon, 'outsider', 1);
    expect(await countOf('outsider', salon)).toBe(1);
  });
});
