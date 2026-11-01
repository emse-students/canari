/**
 * A SALON MODERATOR'S PURGE OF A REEL FILE, AGAINST A REAL POSTGRESQL - migration 122 included
 * (RC-14, docs/wiki/frontend/modules/reels-in-chat.md section 15.4).
 *
 * `channel.service.spec.ts` asserts the decisions over mocks; this file runs them over a real
 * schema, where they can be wrong without any mock noticing: the declaration is written by its own
 * UPDATE in the send's transaction and read by its own SELECT, keyed on the row AND its salon. What
 * is pinned:
 *  - a moderator of salon S cannot purge a file only salon T names: T's row is not found under S,
 *    and S's community role does not reach T's community;
 *  - the purge names the ROW's author, never the moderator - so a file whose owner is not that
 *    author is the media service's to refuse (its allowlist, `media.service.chat-holds.spec.ts`);
 *  - a send and a moderator's delete both work in the deploy's window BEFORE 122 exists (the entity
 *    names the column in no INSERT and no history read); only the declaring send needs the column;
 *  - 122 applies over the schema the entity built, twice.
 *
 * The media service is a recording fake that applies ITS allowlist (owner and chat hold) to a table
 * of files, so "a lying declaration of another member's id is refused" is read end to end.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- channel-reel-purge.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ChannelService } from './channel.service';
import type { ChatReelMediaClient } from './chat-reel-media.client';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import type { RedisService } from '../common/redis';
import type { ReelPurgeOutcome } from '../internal/reel-media';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const sql = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
const migration122 = sql('122_channel_message_reel_media_id.sql');
const clientIdMigration = sql('090_channel_message_client_id.sql');
const fanoutMigration = sql('093_channel_message_fanout.sql');

const WS_S = '00000000-0000-4000-8000-0000000000a1';
const WS_T = '00000000-0000-4000-8000-0000000000a2';
const SALON_S = '00000000-0000-4000-8000-0000000000c1';
const SALON_T = '00000000-0000-4000-8000-0000000000c2';
const ROLE_S = '00000000-0000-4000-8000-0000000000e1';
/** Moderates community S, is a plain member of nothing else. */
const MOD_S = 'moderator-of-s';
const ALICE = 'alice';
const BOB = 'bob';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

const ALICES_REEL = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const BOBS_REEL = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const T_ONLY_REEL = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';

maybe('a salon reel purge against PostgreSQL (migration 122)', () => {
  const schema = `reelpurge_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: ChannelService;
  let index = 0;
  /** The media service: files by id, with their uploader and whether a conversation holds them. */
  const files = new Map<string, { ownerId: string; chatHeld: boolean }>();
  const purgeCalls: Array<Array<{ mediaId: string; ownerId: string }>> = [];
  const media = {
    purge: jest.fn(async (items: Array<{ mediaId: string; ownerId: string }>) => {
      purgeCalls.push(items);
      const out: Record<string, ReelPurgeOutcome> = {};
      for (const { mediaId, ownerId } of items) {
        const file = files.get(mediaId);
        if (!file) out[mediaId] = 'absent';
        else if (file.ownerId !== ownerId || !file.chatHeld) out[mediaId] = 'refused';
        else {
          files.delete(mediaId);
          out[mediaId] = 'deleted';
        }
      }
      return out;
    }),
  };
  const q = (statement: string, params: unknown[] = []) => ds.query(statement, params);

  const send = (salon: string, senderId: string, reelMediaId?: string) =>
    service.sendMessage(salon, {
      senderId,
      ciphertext: 'c2VhbGVk',
      nonce: 'bm9uY2U=',
      senderSessionId: `session-${senderId}`,
      messageIndex: index++,
      signature: SIGNATURE,
      ...(reelMediaId === undefined ? {} : { reelMediaId }),
    } as never);
  const declared = async (messageId: string): Promise<string | null> =>
    (await q(`SELECT "reelMediaId" FROM channel_messages WHERE id = $1`, [messageId]))[0]
      ?.reelMediaId ?? null;

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
    // THE DEPLOY'S WINDOW: the services run before 122 is applied. The entity built the column
    // (synchronize), so it is dropped here, and the first tests run without it.
    await q(`ALTER TABLE channel_messages DROP COLUMN "reelMediaId"`);
    await q(clientIdMigration);
    await q(fanoutMigration);
    const members = ds.getRepository(ChannelMember);
    service = new ChannelService(
      ds.getRepository(Workspace),
      ds.getRepository(Channel),
      ds.getRepository(ChannelRole),
      members,
      ds.getRepository(ChannelMessage),
      ds.getRepository(WorkspaceInvite),
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService,
      media as unknown as ChatReelMediaClient
    );
    jest.spyOn(service as never, 'notifyChannelRecipients').mockResolvedValue(undefined as never);
    jest.spyOn(service as never, 'fanoutInBackground').mockReturnValue(undefined as never);
    for (const [ws, slug] of [
      [WS_S, 's'],
      [WS_T, 't'],
    ]) {
      await q(
        `INSERT INTO channel_workspaces (id, name, slug, "createdBy") VALUES ($1, $2, $2, 'owner')`,
        [ws, slug]
      );
    }
    await q(
      `INSERT INTO channels (id, "workspaceId", name, "isPrivate", "allowedUsers")
       VALUES ($1, $2, 'general', false, ''), ($3, $4, 'general', false, '')`,
      [SALON_S, WS_S, SALON_T, WS_T]
    );
    const roles = ds.getRepository(ChannelRole);
    await roles.save(
      roles.create({
        id: ROLE_S,
        workspaceId: WS_S,
        name: 'Moderateur',
        priority: 50,
        permissions: ['channel.moderate'],
      } as never)
    );
    await members.save(members.create({ workspaceId: WS_S, userId: MOD_S, roleIds: [ROLE_S] }));
    for (const user of [ALICE, BOB]) {
      await members.save(members.create({ workspaceId: WS_S, userId: user }));
      await members.save(members.create({ workspaceId: WS_T, userId: user }));
    }
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  beforeEach(() => {
    purgeCalls.length = 0;
    media.purge.mockClear();
  });

  it('BEFORE 122: a plain send and a moderator delete both work; only a declaring send needs the column', async () => {
    const plain = await send(SALON_S, ALICE);
    expect(plain.id).toBeDefined();
    // A history read names no column 122 adds.
    await expect(service.listMessages(SALON_S, ALICE, 50)).resolves.toBeDefined();

    // The moderator's delete reads the declaration best-effort: it fails, the delete goes on.
    await expect(service.deleteChannelMessage(SALON_S, plain.id, MOD_S)).resolves.toMatchObject({
      success: true,
    });
    expect(media.purge).not.toHaveBeenCalled();

    // A send that DECLARES fails whole and stores nothing - no reel writer is on before 122 ships.
    const before = Number((await q(`SELECT count(*)::int AS n FROM channel_messages`))[0].n);
    await expect(send(SALON_S, ALICE, ALICES_REEL)).rejects.toBeDefined();
    expect(Number((await q(`SELECT count(*)::int AS n FROM channel_messages`))[0].n)).toBe(before);
  });

  it('migration 122 applies over the schema, twice, as a nullable uuid', async () => {
    await q(migration122);
    await q(migration122);
    const column: Array<{ data_type: string; is_nullable: string }> = await q(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'channel_messages'
          AND column_name = 'reelMediaId'`
    );
    expect(column).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
  });

  it("a moderator's delete purges the declared file of THEIR salon, for the row's author", async () => {
    files.set(ALICES_REEL, { ownerId: ALICE, chatHeld: true });
    const sent = await send(SALON_S, ALICE, ALICES_REEL.toUpperCase());
    expect(await declared(sent.id)).toBe(ALICES_REEL);

    await service.deleteChannelMessage(SALON_S, sent.id, MOD_S);

    expect(purgeCalls).toEqual([[{ mediaId: ALICES_REEL, ownerId: ALICE }]]);
    expect(files.has(ALICES_REEL)).toBe(false);
  });

  it('a moderator of salon S cannot purge a file only salon T names', async () => {
    files.set(T_ONLY_REEL, { ownerId: BOB, chatHeld: true });
    const inT = await send(SALON_T, BOB, T_ONLY_REEL);

    // T's message asked for under S: no such row in S.
    await expect(service.deleteChannelMessage(SALON_S, inT.id, MOD_S)).rejects.toMatchObject({
      status: 404,
    });
    // Asked for under T: S's moderator is not even a member of T's community.
    await expect(service.deleteChannelMessage(SALON_T, inT.id, MOD_S)).rejects.toMatchObject({
      status: 403,
    });
    expect(media.purge).not.toHaveBeenCalled();
    expect(files.has(T_ONLY_REEL)).toBe(true);
    expect(await declared(inT.id)).toBe(T_ONLY_REEL);
  });

  it("a lying declaration of another member's file is refused: the purge names the row's author", async () => {
    files.set(BOBS_REEL, { ownerId: BOB, chatHeld: true });
    // Alice's row declares Bob's file.
    const lying = await send(SALON_S, ALICE, BOBS_REEL);

    await service.deleteChannelMessage(SALON_S, lying.id, MOD_S);

    expect(purgeCalls).toEqual([[{ mediaId: BOBS_REEL, ownerId: ALICE }]]);
    expect(files.has(BOBS_REEL)).toBe(true);
    // The message itself is gone: refusing the file never keeps a moderated message.
    expect((await q(`SELECT 1 FROM channel_messages WHERE id = $1`, [lying.id])).length).toBe(0);
  });

  it("the author's own delete purges nothing: the sender releases their hold themselves", async () => {
    files.set(ALICES_REEL, { ownerId: ALICE, chatHeld: true });
    const own = await send(SALON_S, ALICE, ALICES_REEL);

    await service.deleteChannelMessage(SALON_S, own.id, ALICE);

    expect(media.purge).not.toHaveBeenCalled();
    expect(files.has(ALICES_REEL)).toBe(true);
  });
});
