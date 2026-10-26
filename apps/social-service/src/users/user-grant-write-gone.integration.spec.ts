/**
 * A WRITE TO A USER'S TAG OR MODERATION RECORD NEVER SAVES THE ROW IT READ, AGAINST A REAL POSTGRESQL.
 *
 * A renewal of a tag and an unmute write the COLUMNS they own, keyed by the row; a TypeORM `save` of
 * the entity read earlier is not that - it writes back every column changed since the read, and
 * inserts the row again when it was deleted meanwhile. Each case lets a concurrent writer commit
 * between the service's read and its write - the writer runs from inside the service's own read, so
 * the interleaving is deterministic (never a sleep).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- user-grant-write-gone.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import * as crypto from 'crypto';
import { Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { UserTag } from './entities/user-tag.entity';
import { UserTagService } from './user-tag.service';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { ModerationService } from '../moderation/moderation.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('a tag or moderation write against PostgreSQL', () => {
  const schema = `grant_write_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let tags: Repository<UserTag>;
  let mutes: Repository<UserModeration>;
  let tagService: UserTagService;
  let moderation: ModerationService;

  /**
   * Runs `hook` once, at the first moment a concurrent writer can land between the service's read
   * of `repo` and its write: right after its next `findOne` has answered, or right before its
   * next `update`/`save` when it reads nothing first. Every spy is gone before `hook` runs, so
   * the hook's own calls are real. Answers whether it ran, so a case proves its interleaving.
   */
  const interleave = <T extends object>(
    repo: Repository<T>,
    hook: () => Promise<unknown>
  ): (() => boolean) => {
    let ran = false;
    const spies: jest.SpyInstance[] = [];
    const fire = async () => {
      for (const sp of spies) sp.mockRestore();
      ran = true;
      await hook();
    };
    const target = repo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const read = target.findOne.bind(repo);
    spies.push(
      jest.spyOn(repo, 'findOne').mockImplementation((async (...args: unknown[]) => {
        const answer = await read(...args);
        await fire();
        return answer;
      }) as never)
    );
    for (const m of ['update', 'save'] as const) {
      const write = target[m].bind(repo);
      spies.push(
        jest.spyOn(repo, m).mockImplementation((async (...args: unknown[]) => {
          await fire();
          return write(...args);
        }) as never)
      );
    }
    return () => ran;
  };

  const grant = (userId: string, grantedBy: string, metadata: Record<string, unknown>) =>
    tagService.grantOrRenew({
      userId,
      tagName: 'cotisant:it-2026-2027',
      issuingAssocId: crypto.randomUUID(),
      grantedBy,
      expiresAt: new Date('2027-09-01T00:00:00Z'),
      metadata,
    });
  const tagOf = (userId: string) =>
    tags.findOne({ where: { userId, tagName: 'cotisant:it-2026-2027' } });

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
      entities: [UserTag, UserModeration, ContentReport],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    tags = ds.getRepository(UserTag);
    mutes = ds.getRepository(UserModeration);
    tagService = new UserTagService(tags);
    moderation = new ModerationService(ds.getRepository(ContentReport), mutes);
    // No budget here: every integration spec has one, `jest-integration-budget.cjs`.
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a renewal across a revoke grants a NEW row, never the revoked one written back', async () => {
    const userId = crypto.randomUUID();
    const first = await grant(userId, 'first-grantor', { first: true });
    const ran = interleave(tags, () => tagService.revokeByName(userId, first.tagName));
    await grant(userId, 'second-grantor', { second: true });
    expect(ran()).toBe(true);
    const row = await tagOf(userId);
    expect(row?.id).not.toBe(first.id);
    expect(row).toMatchObject({ grantedBy: 'second-grantor', metadata: { second: true } });
  });

  it('two renewals of one tag keep both their metadata keys', async () => {
    const userId = crypto.randomUUID();
    await grant(userId, 'g', { origin: 1 });
    const ran = interleave(tags, () => grant(userId, 'g', { inner: 2 }));
    await grant(userId, 'g', { outer: 3 });
    expect(ran()).toBe(true);
    expect((await tagOf(userId))?.metadata).toEqual({ origin: 1, inner: 2, outer: 3 });
  });

  it('an unmute across a deletion of the record is refused and leaves no record', async () => {
    const userId = crypto.randomUUID();
    await moderation.muteUser(userId, 'moderator', 'reason');
    const ran = interleave(mutes, () => mutes.delete({ userId }));
    const outcome = await moderation.unmuteUser(userId).then(
      () => 'unmuted',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(await mutes.findOne({ where: { userId } })).toBeNull();
  });

  it('a mute and an unmute with nobody racing them write their columns', async () => {
    const userId = crypto.randomUUID();
    await moderation.muteUser(userId, 'moderator', 'reason');
    await moderation.muteUser(userId, 'moderator-2', 'again');
    expect(await mutes.findOne({ where: { userId } })).toMatchObject({
      isMuted: true,
      mutedBy: 'moderator-2',
      mutedReason: 'again',
    });
    await moderation.unmuteUser(userId);
    expect(await mutes.findOne({ where: { userId } })).toMatchObject({
      isMuted: false,
      mutedBy: null,
      mutedReason: null,
    });
  });
});
