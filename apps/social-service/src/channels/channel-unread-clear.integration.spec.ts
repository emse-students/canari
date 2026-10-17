/**
 * "MARQUER TOUT COMME LU" AGAINST A REAL POSTGRESQL - migration 082 included.
 *
 * `channel-unread-clear.spec.ts` asserts WHO is told and that the SQL carries its bounds; this file
 * runs that SQL. The bounds are where it can be wrong without any mock noticing: `LEAST` ignores a
 * NULL, so an EMPTY salon took the client's `upTo` itself as its mark, and a future `upTo` hid that
 * salon's next messages (found here, 2026-10-13). It also pins the entity declaration of
 * `clearedMarks` (`select`/`update: false`): a membership read and a membership save must not name
 * the column, because the deploy runs them BEFORE migration 082 exists.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files: CI provides no database, and
 * the file reports as skipped rather than passing. Run it against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- channel-unread-clear.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. The schema is created BEFORE the
 * DataSource initializes: TypeORM reads `current_schema()` once, at `initialize()`, and keeps it as
 * the schema it introspects. Created afterwards, the search path named a schema that did not exist
 * yet, so TypeORM kept no schema; the first `synchronize` still built the tables (unqualified DDL
 * lands in the search path), but the SECOND one found none of them and tried to create
 * `channel_workspaces` again - "relation already exists", on every run (2026-10-15).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
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

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '082_channel_cleared_marks.sql'),
  'utf8'
);

const WS = '00000000-0000-4000-8000-0000000000a1';
const OPEN = '00000000-0000-4000-8000-0000000000c1'; // three messages from someone else
const EMPTY = '00000000-0000-4000-8000-0000000000c2'; // no message yet
const SECRET = '00000000-0000-4000-8000-0000000000c3'; // private, the caller is not in it
const ME = 'me';
const ms = (iso: string) => Date.parse(`${iso}Z`);

maybe('clearing a community unread against PostgreSQL (migration 082)', () => {
  const schema = `clear_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let members: Repository<ChannelMember>;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const counts = async () => (await service.listUnreadCounts(ME)).counts;
  const post = (channelId: string, at: string, authorId = 'other') =>
    q(
      `INSERT INTO channel_messages ("workspaceId", "channelId", "authorId", content, "createdAt")
       VALUES ($1, $2, $3, 'x', $4)`,
      [WS, channelId, authorId, at]
    );

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
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };
    members = ds.getRepository(ChannelMember);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      members,
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      redis as unknown as RedisService
    );
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channels (id, "workspaceId", name, "isPrivate", "allowedUsers") VALUES
         ($1, $4, 'general', false, ''), ($2, $4, 'empty', false, ''), ($3, $4, 'secret', true, 'someone')`,
      [OPEN, EMPTY, SECRET, WS]
    );
    await members.save(members.create({ workspaceId: WS, userId: ME }));
    // Joined long ago, so the arrival floor never hides what this file posts.
    await q(`UPDATE channel_members SET "createdAt" = '2026-01-01' WHERE "userId" = $1`, [ME]);
    // Microseconds kept, as production's rows are.
    await post(OPEN, '2026-10-13 10:00:00.123456');
    await post(OPEN, '2026-10-13 10:00:01.500999');
    await post(OPEN, '2026-10-13 10:00:02.999999');
    await post(SECRET, '2026-10-13 10:00:03');
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  // TypeORM introspects the schema it read at initialize: this file's, not none - see the header.
  it('introspects the throwaway schema, so a second synchronize sees the tables it built', () => {
    expect(ds.driver.schema).toBe(schema);
  });

  it('migration 082 applies over the schema the entity built, and a later synchronize keeps it', async () => {
    await q(migration);
    await q(migration);
    // Outside production every boot synchronizes: a column the entity did not declare was DROPPED
    // there, and the unread count names it.
    await ds.synchronize();
    const col: { is_nullable: string; column_default: string }[] = await q(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'channel_members'
          AND column_name = 'clearedMarks'`
    );
    expect(col).toEqual([{ is_nullable: 'NO', column_default: "'{}'::jsonb" }]);
  });

  it('counts, then clears up to upTo - a microsecond row included - and moves no read mark', async () => {
    expect(await counts()).toMatchObject({ [OPEN]: 3 });
    const answer = await service.clearWorkspaceUnread(WS, ME, ms('2026-10-13T10:00:01.500'));
    expect(answer.cleared).toEqual({ [OPEN]: ms('2026-10-13T10:00:01.500') });
    expect(await counts()).toMatchObject({ [OPEN]: 1 });
    const [row]: { readMarks: object }[] = await q(
      `SELECT "readMarks" FROM channel_members WHERE "userId" = $1`,
      [ME]
    );
    expect(row.readMarks).toEqual({});
  });

  it('never lowers a mark, and a repeat moves nothing', async () => {
    await expect(
      service.clearWorkspaceUnread(WS, ME, ms('2026-10-13T10:00:00.000'))
    ).resolves.toEqual({ cleared: {} });
    expect(await counts()).toMatchObject({ [OPEN]: 1 });
  });

  it('a future upTo is bounded by each salon newest row, and an EMPTY salon gets no mark', async () => {
    const future = ms('2027-01-01T00:00:00.000');
    const answer = await service.clearWorkspaceUnread(WS, ME, future);
    expect(answer.cleared).toEqual({ [OPEN]: ms('2026-10-13T10:00:02.999') });
    expect(await counts()).not.toHaveProperty(OPEN);
    // What arrives next, in either salon, is unread - before `future` as well.
    await post(OPEN, '2026-10-14 08:00:00.000001');
    await post(EMPTY, '2026-10-14 08:00:00.000001');
    expect(await counts()).toMatchObject({ [OPEN]: 1, [EMPTY]: 1 });
  });

  it('never names the private salon the caller is not in', async () => {
    const [row]: { clearedMarks: Record<string, number> }[] = await q(
      `SELECT "clearedMarks" FROM channel_members WHERE "userId" = $1`,
      [ME]
    );
    expect(Object.keys(row.clearedMarks)).not.toContain(SECRET);
  });

  it('a membership read and save never name the column: the deploy runs them before 082', async () => {
    await q(`ALTER TABLE channel_members DROP COLUMN "clearedMarks"`);
    try {
      const member = await members.findOneOrFail({ where: { workspaceId: WS, userId: ME } });
      member.sortOrder = 3;
      await expect(members.save(member)).resolves.toBeDefined();
    } finally {
      await q(migration);
    }
  });
});
