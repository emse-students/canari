/**
 * ACCEPTING A COMMUNITY INVITE LINK, AGAINST A REAL POSTGRESQL - where a use is counted.
 *
 * A link's `maxUses` is a bound only if counting a use and checking the bound are ONE statement.
 * `acceptWorkspaceInvite` claims a use with a conditional
 * `UPDATE ... WHERE uses < maxUses RETURNING`, in the transaction that adds the member, and an
 * accept whose claim matched no row is refused with nothing written. A mock cannot judge a row lock,
 * so the interleaving is made deterministic here: a raw client claims the last use and holds its
 * transaction open, and the test waits until the server reports the accept PARKED on that lock
 * (never a sleep) before committing.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- workspace-invite.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import { NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ChannelService } from './channel.service';
import { ReviewCohortBoundaryException } from '../review-cohort';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import type { RedisService } from '../common/redis';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const WS = '00000000-0000-4000-8000-0000000000e1';
const BASE_ROLE = '00000000-0000-4000-8000-0000000000e2';
const ADMIN_ROLE = '00000000-0000-4000-8000-0000000000e3';

maybe('accepting a community invite link against PostgreSQL', () => {
  const schema = `invite_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let tokenSeq = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** A fresh link with the given cap, so every test counts its own uses. */
  const link = async (maxUses: number | null): Promise<{ id: string; token: string }> => {
    const token = `token-${tokenSeq++}`;
    const [row]: { id: string }[] = await q(
      `INSERT INTO workspace_invites ("workspaceId", token, "createdBy", "maxUses", uses, revoked)
       VALUES ($1, $2, 'owner', $3, 0, false) RETURNING id`,
      [WS, token, maxUses]
    );
    return { id: row.id, token };
  };
  const usesOf = async (id: string): Promise<number> =>
    Number((await q(`SELECT uses FROM workspace_invites WHERE id = $1`, [id]))[0].uses);
  const isMember = async (userId: string): Promise<boolean> =>
    (
      await q(`SELECT 1 FROM channel_members WHERE "workspaceId" = $1 AND "userId" = $2`, [
        WS,
        userId,
      ])
    ).length > 0;

  beforeAll(async () => {
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
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w-invite', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channel_roles (id, "workspaceId", name, priority, permissions)
       VALUES ($1, $3, 'Administrateur', 100, 'workspace.manage'), ($2, $3, 'Membre', 10, '')`,
      [ADMIN_ROLE, BASE_ROLE, WS]
    );
    const members = ds.getRepository(ChannelMember);
    await members.save(members.create({ workspaceId: WS, userId: 'owner', roleIds: [ADMIN_ROLE] }));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  /**
   * Resolves once some backend is WAITING on a lock `holder` (a backend pid) holds - read from the
   * server's own lock table, so the test knows the other side is parked rather than hoping a pause
   * was long enough. Each round is a real query, never a sleep; jest's timeout bounds it.
   */
  const blockedBy = async (holder: number) => {
    for (;;) {
      const waiting: unknown[] = await q(
        `SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))`,
        [holder]
      );
      if (waiting.length > 0) return;
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

  it('grants the base role and counts the use', async () => {
    const { id, token } = await link(3);
    await expect(service.acceptWorkspaceInvite(token, 'joiner-a')).resolves.toEqual({
      workspaceSlug: 'w-invite',
      alreadyMember: false,
    });
    const [row]: { roleIds: string }[] = await q(
      `SELECT "roleIds" FROM channel_members WHERE "workspaceId" = $1 AND "userId" = 'joiner-a'`,
      [WS]
    );
    expect(row.roleIds).toBe(BASE_ROLE);
    expect(await usesOf(id)).toBe(1);
  });

  it('concurrent accepts never exceed the cap: one waiting on the last use is refused', async () => {
    // Another accept has claimed the last use and not committed when this one starts. This one
    // waits on the claim, finds the cap reached once it commits, and writes nothing.
    const { id, token } = await link(1);
    const other = await holder();
    try {
      await other.client.query('BEGIN');
      await other.client.query(`UPDATE workspace_invites SET uses = uses + 1 WHERE id = $1`, [id]);
      const late = service.acceptWorkspaceInvite(token, 'joiner-late').catch((e: unknown) => e);
      await blockedBy(other.pid);
      await other.client.query('COMMIT');
      expect(await late).toBeInstanceOf(NotFoundException);
      expect(await isMember('joiner-late')).toBe(false);
      expect(await usesOf(id)).toBe(1);
    } finally {
      await other.client.query('ROLLBACK').catch(() => undefined);
      await other.client.end();
    }
  });

  it('an accept concurrent with a rotation that revoked the link is refused', async () => {
    const { token, id } = await link(null);
    const rotation = await holder();
    try {
      await rotation.client.query('BEGIN');
      await rotation.client.query(`UPDATE workspace_invites SET revoked = true WHERE id = $1`, [
        id,
      ]);
      const late = service.acceptWorkspaceInvite(token, 'joiner-revoked').catch((e: unknown) => e);
      await blockedBy(rotation.pid);
      await rotation.client.query('COMMIT');
      expect(await late).toBeInstanceOf(NotFoundException);
      expect(await isMember('joiner-revoked')).toBe(false);
      expect(await usesOf(id)).toBe(0);
    } finally {
      await rotation.client.query('ROLLBACK').catch(() => undefined);
      await rotation.client.end();
    }
  });

  it('four concurrent accepts on a cap of two admit exactly two', async () => {
    const { id, token } = await link(2);
    const joiners = ['many-1', 'many-2', 'many-3', 'many-4'];
    const outcomes = await Promise.all(
      joiners.map((u) => service.acceptWorkspaceInvite(token, u).catch((e: unknown) => e))
    );
    expect(outcomes.filter((o) => o instanceof NotFoundException)).toHaveLength(2);
    expect(await usesOf(id)).toBe(2);
    const joined = await Promise.all(joiners.map(isMember));
    expect(joined.filter(Boolean)).toHaveLength(2);
  });

  /**
   * THE REVIEW COHORT (review-cohort.ts): a link never seats one side among the other, and a roster
   * row across the boundary from the community's creator - one written before the rule - entitles
   * nothing in its key group.
   */
  describe('the review cohort', () => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    afterEach(async () => {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
      await q(`DELETE FROM channel_members WHERE "userId" LIKE 'rev-%'`);
    });

    it('refuses a review account a link into a community of members, typed, writing nothing', async () => {
      process.env.SERVICE_ACCOUNT_USER_ID = 'rev-1';
      const { id, token } = await link(null);
      const err = await service.acceptWorkspaceInvite(token, 'rev-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewCohortBoundaryException);
      expect(await isMember('rev-1')).toBe(false);
      expect(await usesOf(id)).toBe(0);
    });

    it('refuses a member a link into a community holding a review account', async () => {
      process.env.SERVICE_ACCOUNT_USER_ID = 'rev-2';
      const members = ds.getRepository(ChannelMember);
      await members.save(members.create({ workspaceId: WS, userId: 'rev-2', roleIds: [] }));
      const { token } = await link(null);
      const err = await service.acceptWorkspaceInvite(token, 'member-x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewCohortBoundaryException);
      expect(await isMember('member-x')).toBe(false);
    });

    it("entitles nobody across the creator's side to the key group, and keeps the creator's side entitled", async () => {
      // A review account's row written before the rule, in a community a member created.
      const members = ds.getRepository(ChannelMember);
      await members.save(members.create({ workspaceId: WS, userId: 'rev-3', roleIds: [] }));
      process.env.SERVICE_ACCOUNT_USER_ID = 'rev-3';
      expect(await service.isDistributionGroupEntitled('workspace', WS, 'rev-3')).toBe(false);
      expect(await service.isDistributionGroupEntitled('workspace', WS, 'owner')).toBe(true);
      // The other way: the creator a review account, a member's row written before the rule.
      process.env.SERVICE_ACCOUNT_USER_ID = 'owner';
      expect(await service.isDistributionGroupEntitled('workspace', WS, 'rev-3')).toBe(false);
      expect(await service.isDistributionGroupEntitled('workspace', WS, 'owner')).toBe(true);
    });
  });
});
