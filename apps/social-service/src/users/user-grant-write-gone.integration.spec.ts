/**
 * A WRITE TO A USER'S TAG, MODERATION RECORD, REPORT OR ROLE HISTORY NEVER SAVES THE ROW IT READ,
 * AGAINST A REAL POSTGRESQL.
 *
 * A grant or renewal of a tag and a mute are ONE `INSERT ... ON CONFLICT` statement; an unmute, a
 * report review and a role history edit write the COLUMNS they own, keyed by the row. A TypeORM
 * `save` of the entity read earlier is not that - it writes back every column changed since the
 * read, and inserts the row again when it was deleted meanwhile; and a read then an insert lets two
 * first writes both insert. Each case lets a concurrent writer commit between the service's read and
 * its write - the writer runs from inside the service's own repository call, so the interleaving is
 * deterministic (never a sleep).
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
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { UserTag } from './entities/user-tag.entity';
import { UserTagService } from './user-tag.service';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { ModerationService } from '../moderation/moderation.service';
import { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';
import { UserProfileService } from '../associations/user-profile.service';
import type { AssociationMember } from '../associations/entities/association-member.entity';
import type { Association } from '../associations/entities/association.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('a tag, moderation, report or role history write against PostgreSQL', () => {
  const schema = `grant_write_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let tags: Repository<UserTag>;
  let mutes: Repository<UserModeration>;
  let tagService: UserTagService;
  let moderation: ModerationService;
  let reports: Repository<ContentReport>;
  let history: Repository<AssociationRoleHistory>;
  let profiles: UserProfileService;

  /**
   * Runs `hook` once, at the first moment a concurrent writer can land between the service's read
   * of `repo` and its write: right after its next `findOne` has answered, or right before its
   * next `update`/`save`/`query` when it reads nothing first. Every spy is gone before `hook` runs, so
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
    for (const m of ['update', 'save', 'query'] as const) {
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

  // ONE issuer for every grant: a renewal is a grant by the association that issued the row (a
  // grant never renews a row another association issued).
  const ISSUER = crypto.randomUUID();
  const grant = (userId: string, grantedBy: string, metadata: Record<string, unknown>) =>
    tagService.grantOrRenew({
      userId,
      tagName: 'cotisant:it-2026-2027',
      issuingAssocId: ISSUER,
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
      entities: [UserTag, UserModeration, ContentReport, AssociationRoleHistory],
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
    reports = ds.getRepository(ContentReport);
    moderation = new ModerationService(reports, mutes);
    history = ds.getRepository(AssociationRoleHistory);
    // The association reads only LABEL a role history row and check an id exists; the rows judged
    // here are the role history's, so those two answer from a stub.
    const assoStub = {
      exists: async () => true,
      createQueryBuilder: () => ({ where: () => ({ getMany: async () => [] }) }),
    } as unknown as Repository<Association>;
    profiles = new UserProfileService({} as Repository<AssociationMember>, assoStub, history);
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
    const ran = interleave(tags, () => tagService.revokeByName(userId, first.tagName, ISSUER));
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

  it('two first grants of one tag leave ONE row and neither fails', async () => {
    const userId = crypto.randomUUID();
    const ran = interleave(tags, () => grant(userId, 'inner', { inner: 1 }));
    await grant(userId, 'outer', { outer: 2 });
    expect(ran()).toBe(true);
    expect(await tags.count({ where: { userId } })).toBe(1);
    expect((await tagOf(userId))?.metadata).toEqual({ inner: 1, outer: 2 });
  });

  it('two first mutes of one user leave ONE record holding the later mute', async () => {
    const userId = crypto.randomUUID();
    const ran = interleave(mutes, () => moderation.muteUser(userId, 'inner', 'first'));
    await moderation.muteUser(userId, 'outer', 'second');
    expect(ran()).toBe(true);
    expect(await mutes.count({ where: { userId } })).toBe(1);
    expect(await mutes.findOne({ where: { userId } })).toMatchObject({
      isMuted: true,
      mutedBy: 'outer',
      mutedReason: 'second',
    });
  });

  const report = (): Promise<ContentReport> =>
    reports.save(
      reports.create({
        reporterId: crypto.randomUUID(),
        contentType: 'post',
        contentId: crypto.randomUUID(),
        reason: 'spam',
        reportedUserId: crypto.randomUUID(),
      })
    );

  it('a review writes its three columns and keeps a party rewritten since its read', async () => {
    const filed = await report();
    const ran = interleave(reports, () =>
      reports.update({ id: filed.id }, { reporterId: '[deleted]', reportedUserId: '[deleted]' })
    );
    const reviewed = await moderation.reviewReport(filed.id, 'moderator', 'reviewed');
    expect(ran()).toBe(true);
    expect(await reports.findOne({ where: { id: filed.id } })).toMatchObject({
      status: 'reviewed',
      reviewedBy: 'moderator',
      reporterId: '[deleted]',
      reportedUserId: '[deleted]',
    });
    expect(reviewed.reporterId).toBe('[deleted]');
  });

  it('a review of a report deleted since is refused and leaves no report', async () => {
    const filed = await report();
    const ran = interleave(reports, () => reports.delete({ id: filed.id }));
    const outcome = await moderation.reviewReport(filed.id, 'moderator', 'dismissed').then(
      () => 'reviewed',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(await reports.findOne({ where: { id: filed.id } })).toBeNull();
  });

  const entry = (userId: string): Promise<AssociationRoleHistory> =>
    history.save(
      history.create({
        userId,
        associationId: crypto.randomUUID(),
        roleTitle: 'Tresorier',
        startYear: 2022,
        endYear: 2023,
      })
    );

  it('a role history edit of an entry deleted since is refused and leaves no entry', async () => {
    const userId = crypto.randomUUID();
    const row = await entry(userId);
    const ran = interleave(history, () => history.delete({ id: row.id }));
    const outcome = await profiles
      .updateRoleHistory(userId, row.id, { roleTitle: 'President' })
      .then(
        () => 'updated',
        (e: unknown) => e
      );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(await history.findOne({ where: { id: row.id } })).toBeNull();
  });

  it('a role history edit judged against years changed since is refused and keeps them', async () => {
    const userId = crypto.randomUUID();
    const row = await entry(userId);
    const ran = interleave(history, () =>
      history.update({ id: row.id }, { startYear: 2024, endYear: 2025 })
    );
    // Judged against the years it read (2022-2023), an end of 2023 is a valid range; against the
    // years now held (from 2024) it is not.
    const outcome = await profiles.updateRoleHistory(userId, row.id, { endYear: 2023 }).then(
      () => 'updated',
      (e: unknown) => e
    );
    expect(ran()).toBe(true);
    expect(outcome).toBeInstanceOf(ConflictException);
    expect(await history.findOne({ where: { id: row.id } })).toMatchObject({
      startYear: 2024,
      endYear: 2025,
    });
  });

  it('a title-only edit across years moved since writes its title and keeps the years', async () => {
    const userId = crypto.randomUUID();
    const row = await entry(userId);
    const ran = interleave(history, () =>
      history.update({ id: row.id }, { startYear: 2024, endYear: 2025 })
    );
    const updated = await profiles.updateRoleHistory(userId, row.id, { roleTitle: 'President' });
    expect(ran()).toBe(true);
    expect(updated).toMatchObject({ roleTitle: 'President', startYear: 2024, endYear: 2025 });
  });

  it('an edit setting both years across years moved since writes its own range', async () => {
    const userId = crypto.randomUUID();
    const row = await entry(userId);
    const ran = interleave(history, () =>
      history.update({ id: row.id }, { startYear: 2024, endYear: 2025 })
    );
    const updated = await profiles.updateRoleHistory(userId, row.id, {
      startYear: 2019,
      endYear: 2020,
    });
    expect(ran()).toBe(true);
    expect(updated).toMatchObject({ startYear: 2019, endYear: 2020 });
  });

  it('a role history edit with nobody racing it writes its columns', async () => {
    const userId = crypto.randomUUID();
    const row = await entry(userId);
    const updated = await profiles.updateRoleHistory(userId, row.id, {
      roleTitle: 'President',
      endYear: 2024,
    });
    expect(updated).toMatchObject({ roleTitle: 'President', startYear: 2022, endYear: 2024 });
  });
});
