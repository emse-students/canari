/**
 * A SALON SEND REPEATED AFTER A LOST ANSWER, AGAINST A REAL POSTGRESQL - migration 088 included.
 *
 * `channel.service.spec.ts` asserts the decisions over mocks; this file runs them over the real
 * partial unique index, which is where they can be wrong without any mock noticing: two repeats
 * racing past the lookup must leave ONE row, and the loser must be answered with the winner's row,
 * never a 409. It also pins the entity declaration of `clientMessageId` (`select`/`update: false`):
 * a history read and a pin must not name the column, because the deploy runs them BEFORE 088 exists.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- channel-message-client-id.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
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

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '088_channel_message_client_id.sql'),
  'utf8'
);

const WS = '00000000-0000-4000-8000-0000000000a8';
const SALON = '00000000-0000-4000-8000-0000000000c8';
const ME = 'author';
const OTHER = 'someone-else';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const CLIENT_ID = '7b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';

maybe('a repeated salon send against PostgreSQL (migration 088)', () => {
  const schema = `clientid_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let publish: jest.Mock;
  let pushes: jest.SpyInstance;
  let index = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const rows = async (): Promise<number> =>
    Number((await q(`SELECT count(*)::int AS n FROM channel_messages`))[0].n);
  /** One send as a client makes it: a fresh key index every time, as a re-seal would take. */
  const send = (senderId: string, messageId?: string) =>
    service.sendMessage(SALON, {
      senderId,
      ciphertext: 'c2VhbGVk',
      nonce: 'bm9uY2U=',
      senderSessionId: `session-${senderId}`,
      messageIndex: index++,
      signature: SIGNATURE,
      ...(messageId === undefined ? {} : { messageId }),
    } as never);

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
    publish = jest.fn().mockResolvedValue(undefined);
    const members = ds.getRepository(ChannelMember);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      members,
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: publish } as unknown as RedisService
    );
    // The push fan-out calls another service; what is asserted is only WHETHER it was asked.
    pushes = jest
      .spyOn(service as never, 'notifyChannelRecipients')
      .mockResolvedValue(undefined as never);
    await q(
      `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, 'W', 'w', 'owner')`,
      [WS]
    );
    await q(
      `INSERT INTO channels (id, "workspaceId", name, "isPrivate", "allowedUsers")
       VALUES ($1, $2, 'general', false, '')`,
      [SALON, WS]
    );
    await members.save(members.create({ workspaceId: WS, userId: ME }));
    await members.save(members.create({ workspaceId: WS, userId: OTHER }));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  /** The first send's broadcast is fire-and-forget (its audience is read first): wait for it. */
  const published = async () => {
    for (let i = 0; i < 200 && publish.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(publish).toHaveBeenCalledTimes(1);
  };

  it('migration 088 applies over the schema the entity built, twice', async () => {
    await q(migration);
    await q(migration);
    const index: { indexdef: string }[] = await q(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'UQ_channel_messages_author_client_id'`
    );
    expect(index).toHaveLength(1);
    expect(index[0].indexdef).toContain('UNIQUE');
    expect(index[0].indexdef).toContain('IS NOT NULL');
  });

  it('a repeat is answered with the stored row: one row, one broadcast, one push', async () => {
    const first = await send(ME, CLIENT_ID);
    await published();
    expect(pushes).toHaveBeenCalledTimes(1);
    publish.mockClear();
    pushes.mockClear();
    // A repeat returns before anything is scheduled, so nothing can be published after it either.
    const repeat = await send(ME, CLIENT_ID.toUpperCase());
    expect(repeat.id).toBe(first.id);
    expect(await rows()).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(pushes).not.toHaveBeenCalled();
    const [stored]: { clientMessageId: string }[] = await q(
      `SELECT "clientMessageId" FROM channel_messages WHERE id = $1`,
      [first.id]
    );
    expect(stored.clientMessageId).toBe(CLIENT_ID);
  });

  it('two repeats racing past the lookup leave ONE row and both get it', async () => {
    const racing = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const before = await rows();
    const [a, b] = await Promise.all([send(ME, racing), send(ME, racing)]);
    expect(a.id).toBe(b.id);
    expect(await rows()).toBe(before + 1);
  });

  it('the same client id from ANOTHER author is another message', async () => {
    const before = await rows();
    const theirs = await send(OTHER, CLIENT_ID);
    expect(await rows()).toBe(before + 1);
    const [{ authorId }]: { authorId: string }[] = await q(
      `SELECT "authorId" FROM channel_messages WHERE id = $1`,
      [theirs.id]
    );
    expect(authorId).toBe(OTHER);
  });

  it('rows with no client id never collide with each other', async () => {
    const before = await rows();
    await send(ME);
    await send(ME);
    expect(await rows()).toBe(before + 2);
  });

  it('a history read and a pin never name the column: the deploy runs them before 088', async () => {
    await q(`DROP INDEX IF EXISTS "UQ_channel_messages_author_client_id"`);
    await q(`ALTER TABLE channel_messages DROP COLUMN "clientMessageId"`);
    try {
      const messages = ds.getRepository(ChannelMessage);
      const row = await messages.findOneOrFail({ where: { channelId: SALON, authorId: OTHER } });
      row.pinned = true;
      await expect(messages.save(row)).resolves.toBeDefined();
      await expect(messages.find({ where: { channelId: SALON } })).resolves.not.toHaveLength(0);
    } finally {
      await q(migration);
    }
  });
});
