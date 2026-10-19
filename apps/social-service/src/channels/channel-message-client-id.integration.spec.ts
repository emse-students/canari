/**
 * A SALON SEND REPEATED AFTER A LOST ANSWER, AGAINST A REAL POSTGRESQL - migration 090 included.
 *
 * `channel.service.spec.ts` asserts the decisions over mocks; this file runs them over the real
 * partial unique index, which is where they can be wrong without any mock noticing: two repeats
 * racing past the lookup must leave ONE row, and the loser must be answered with the winner's row,
 * never a 409. It also pins the entity declaration of `clientMessageId` (`select`/`update: false`):
 * a history read and a pin must not name the column, because the deploy runs them BEFORE 090 exists.
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
import { ChannelService, clientIdLockSql } from './channel.service';
import { ChannelRetentionScheduler } from './channel-retention.scheduler';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';
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
  join(__dirname, '..', 'migrations', '090_channel_message_client_id.sql'),
  'utf8'
);

const fanoutMigration = readFileSync(
  join(__dirname, '..', 'migrations', '093_channel_message_fanout.sql'),
  'utf8'
);

const WS = '00000000-0000-4000-8000-0000000000a8';
const SALON = '00000000-0000-4000-8000-0000000000c8';
const ME = 'author';
const OTHER = 'someone-else';
/** An account being erased while one of its messages is deleted. */
const ERASED = 'erased-author';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const CLIENT_ID = '7b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';

maybe('a repeated salon send against PostgreSQL (migration 090)', () => {
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
    // The outbox table (migration 093) must exist for every send below.
    await ds.query(fanoutMigration);
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
    await members.save(members.create({ workspaceId: WS, userId: ERASED }));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  /**
   * The first send's broadcast is fire-and-forget (its audience is read first): resolves on the
   * call itself - at once when it was already made - rather than after some wait.
   */
  const published = async () => {
    if (publish.mock.calls.length === 0) {
      await new Promise<void>((resolve) =>
        publish.mockImplementationOnce(() => {
          resolve();
          return Promise.resolve();
        })
      );
    }
    expect(publish).toHaveBeenCalledTimes(1);
  };

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
  /** The backend pid of a raw client, the holder `blockedBy` waits on. */
  const pidOf = async (client: Client): Promise<number> =>
    Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

  it('migration 090 applies over the schema the entity built, twice', async () => {
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

  it('migration 093 (the fan-out outbox) applies twice and goes with its message', async () => {
    await q(fanoutMigration);
    await q(fanoutMigration);
    const sent = await send(ME);
    await q(
      `INSERT INTO channel_message_fanout ("messageId", payload) VALUES ($1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [sent.id]
    );
    await q(`DELETE FROM channel_messages WHERE id = $1`, [sent.id]);
    const left: unknown[] = await q(`SELECT 1 FROM channel_message_fanout WHERE "messageId" = $1`, [
      sent.id,
    ]);
    expect(left).toHaveLength(0);
    // The send above published and pushed: later tests count calls from a clean slate.
    await published();
    publish.mockClear();
    pushes.mockClear();
  });

  /** The outbox entries still in the table: what a dead process would have left. */
  const entries = async (): Promise<string[]> =>
    (await q(`SELECT "messageId" FROM channel_message_fanout`)).map(
      (r: { messageId: string }) => r.messageId
    );
  /** Resolves once the fan-out of a send has finished: its entry is gone. */
  const settled = async () => {
    for (let round = 0; round < 200 && (await entries()).length > 0; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('a send whose fan-out never completed leaves its entry, and the boot drain finishes it', async () => {
    await settled();
    publish.mockClear();
    pushes.mockClear();
    // The fan-out does not complete (the production RedisService swallows publish errors, so it is
    // the push step that fails here): nothing is handed off, the entry stays.
    pushes.mockRejectedValueOnce(new Error('the fan-out did not complete'));
    const lost = await send(ME);
    await new Promise((resolve) => setImmediate(resolve));
    await settled();
    expect(await entries()).toEqual([lost.id]);

    publish.mockClear();
    pushes.mockClear();
    expect(await service.drainPendingFanouts()).toBe(1);
    expect(publish).toHaveBeenCalledWith(
      'channel.message.created',
      expect.objectContaining({ messageId: lost.id, channelId: SALON }),
      expect.anything()
    );
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(await entries()).toEqual([]);
    // A second drain finds nothing to do.
    publish.mockClear();
    pushes.mockClear();
    expect(await service.drainPendingFanouts()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    // Leave the table as the later tests expect it: their counts are of THEIR rows.
    await q(`DELETE FROM channel_messages WHERE id = $1`, [lost.id]);
  });

  it('a send whose outbox entry cannot be written leaves no row at all', async () => {
    await settled();
    const before = await rows();
    await q(`ALTER TABLE channel_message_fanout RENAME TO channel_message_fanout_away`);
    try {
      await expect(send(ME)).rejects.toBeDefined();
    } finally {
      await q(`ALTER TABLE channel_message_fanout_away RENAME TO channel_message_fanout`);
    }
    expect(await rows()).toBe(before);
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

  it('a repeat of a DELETED message is refused, never posted again (the tombstone)', async () => {
    const gone = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const first = await send(ME, gone);
    await service.deleteChannelMessage(SALON, first.id, ME);
    const before = await rows();
    const error = await send(ME, gone).catch((e: unknown) => e);
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(410);
    expect(await rows()).toBe(before);
    // Another author's message under the same id is untouched by this author's tombstone.
    await expect(send(OTHER, gone)).resolves.toBeDefined();
  });

  it('a delete that falls between a repeat lookup and its insert still wins: no re-post', async () => {
    // The interleaving the lock closes, made deterministic: a delete holds the client id's lock
    // and has written its tombstone but not committed when the repeat reaches its insert. The
    // repeat must WAIT for it and then read the committed tombstone - never insert past it.
    const racing = '2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182';
    const deleter = new Client({ connectionString: URL });
    await deleter.connect();
    try {
      await deleter.query(`SET search_path TO ${schema}`);
      await deleter.query('BEGIN');
      await deleter.query(`SELECT ${clientIdLockSql('$1', '$2', '$3')}`, [ME, SALON, racing]);
      await deleter.query(
        `INSERT INTO channel_message_client_tombstones ("authorId", "channelId", "clientMessageId")
         VALUES ($1, $2, $3)`,
        [ME, SALON, racing]
      );
      const before = await rows();
      const repeat = send(ME, racing).catch((e: unknown) => e);
      // The repeat is parked on the lock, not past it: nothing landed while the delete is open.
      await blockedBy(await pidOf(deleter));
      expect(await rows()).toBe(before);
      await deleter.query('COMMIT');
      const error = await repeat;
      expect((error as { getStatus?: () => number }).getStatus?.()).toBe(410);
      expect(await rows()).toBe(before);
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      await deleter.end();
    }
  });

  it('a delete racing an account erasure leaves NO tombstone of the erased account', async () => {
    // The interleaving that left one, made deterministic: the erasure has deleted the author's
    // messages and not committed when a delete of one of them (here its author's other device; a
    // moderator's is the same path) starts. Before the row lock the delete read the still-committed
    // row, wrote its tombstone - invisible to the erasure's own tombstone statement - and committed
    // after it. It must now wait on the row, find it gone, and write nothing.
    const doomed = '3c4d5e6f-7081-4a92-8b3c-4d5e6f708192';
    const sent = await send(ERASED, doomed);
    const statement = (label: string) => ERASURE_STATEMENTS.find((s) => s.label === label)!.sql;
    const eraser = new Client({ connectionString: URL });
    await eraser.connect();
    try {
      await eraser.query(`SET search_path TO ${schema}`);
      await eraser.query('BEGIN');
      await eraser.query(statement('channel_messages'), [ERASED]);
      const deleting = service.deleteChannelMessage(SALON, sent.id, ERASED);
      await blockedBy(await pidOf(eraser));
      await eraser.query(statement('channel_message_client_tombstones'), [ERASED]);
      await eraser.query('COMMIT');
      await deleting;
      const left: unknown[] = await q(
        `SELECT 1 FROM channel_message_client_tombstones WHERE "authorId" = $1`,
        [ERASED]
      );
      expect(left).toHaveLength(0);
    } finally {
      await eraser.query('ROLLBACK').catch(() => undefined);
      await eraser.end();
    }
  });

  it('tombstones are purged 30 days after the delete, at a FIXED instant, idempotently', async () => {
    const now = new Date('2026-10-18T03:50:00.000Z');
    const day = 24 * 3600 * 1000;
    const tombstone = (clientId: string, deletedAt: Date) =>
      q(
        `INSERT INTO channel_message_client_tombstones
           ("authorId", "channelId", "clientMessageId", "deletedAt") VALUES ($1, $2, $3, $4)`,
        [OTHER, SALON, clientId, deletedAt.toISOString()]
      );
    const expired = '4d5e6f70-8192-4aa3-8c4d-5e6f708192a3';
    const kept = '5e6f7081-92a3-4bb4-8d5e-6f708192a3b4';
    await tombstone(expired, new Date(now.getTime() - 30 * day - 1000));
    await tombstone(kept, new Date(now.getTime() - 30 * day + 1000));
    const gc = new ChannelRetentionScheduler(ds.getRepository(ChannelMessage));

    expect(await gc.purgeTombstonesOnce(now)).toBe(1);
    expect(await gc.purgeTombstonesOnce(now)).toBe(0);
    const left: { clientMessageId: string }[] = await q(
      `SELECT "clientMessageId" FROM channel_message_client_tombstones WHERE "authorId" = $1`,
      [OTHER]
    );
    expect(left.map((r) => r.clientMessageId)).toEqual([kept]);
    // The purged id is a message again: its repeat is posted, the kept one is still refused.
    await expect(send(OTHER, expired)).resolves.toBeDefined();
    const refused = await send(OTHER, kept).catch((e: unknown) => e);
    expect((refused as { getStatus?: () => number }).getStatus?.()).toBe(410);
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

  it('a history read and a pin never name the column: the deploy runs them before 090', async () => {
    await q(`DROP INDEX IF EXISTS "UQ_channel_messages_author_client_id"`);
    await q(`ALTER TABLE channel_messages DROP COLUMN "clientMessageId"`);
    try {
      const messages = ds.getRepository(ChannelMessage);
      const row = await messages.findOneOrFail({ where: { channelId: SALON, authorId: OTHER } });
      row.pinned = true;
      await expect(messages.save(row)).resolves.toBeDefined();
      await expect(messages.find({ where: { channelId: SALON } })).resolves.not.toHaveLength(0);
      // But EVERY insert names it - TypeORM lists each insertable column, DEFAULT for an absent
      // value - so even a send with no client id fails whole in this window and stores nothing.
      const before = await rows();
      await expect(send(ME)).rejects.toThrow('clientMessageId');
      expect(await rows()).toBe(before);
    } finally {
      await q(migration);
    }
  });
});
