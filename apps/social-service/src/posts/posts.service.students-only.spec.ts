/**
 * THE "ENTRE ÉTUDIANTS" SWITCH AT THE WRITE (owner, 2026-11-04): offered on an association's or a
 * list's post only, refused with a TYPED code anywhere else; changed after publication both ways; and
 * every change drops the whole feed cache, so no cached page keeps serving the old audience. Who
 * READS such a post is the predicate's, proven on PostgreSQL in `students-only.integration.spec.ts`.
 */
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';
import { STUDENTS_ONLY_ASSOCIATION_TYPES, STUDENTS_ONLY_NOT_OFFERED } from './students-only';

/** Association ids by type, as `associationTypeOf` reads them. */
const TYPES: Record<string, string> = {
  'asso-1': 'association',
  'list-1': 'list',
  'inst-1': 'institution',
};

function makeService(existing?: Partial<Post>) {
  const saved: Array<Record<string, unknown>> = [];
  const deleteByPattern = jest.fn(() => Promise.resolve(3));
  const incr = jest.fn(() => Promise.resolve(2));
  const postRepo = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn((post: Record<string, unknown>) => {
      saved.push({ ...post });
      return Promise.resolve({ id: 'p1', ...post });
    }),
    findOne: jest.fn(() => Promise.resolve(existing ? { ...existing } : existing)),
    manager: {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT type FROM associations')) {
          const type = TYPES[params[0] as string];
          return Promise.resolve(type ? [{ type }] : []);
        }
        return Promise.resolve(sql.includes('AS visible') ? [{ visible: true }] : []);
      }),
    },
  };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    { setex: jest.fn(), get: jest.fn(), incr, deleteByPattern } as unknown as RedisService,
    {} as FollowsService,
    {
      isContentModerator: () => Promise.resolve(false),
      moderatedPostIds: () => Promise.resolve(new Set()),
      mayModeratePost: () => Promise.resolve(false),
      mayActOnAny: () => Promise.resolve(new Set()),
      // The editor holds POST_AS_ASSO: what `assertMayEdit` asks of an association's post.
      mayAct: () => Promise.resolve(true),
      resolvePostCalendarEventLink: () => Promise.resolve(null),
      findValidatedCalendarEventSummary: () => Promise.resolve(null),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    { release: jest.fn() } as unknown as PostMediaRetentionService
  );
  return { service, saved, deleteByPattern, incr };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );

const expectNotOffered = (e: unknown) => {
  expect(e).toBeInstanceOf(BadRequestException);
  expect((e as BadRequestException).getResponse()).toMatchObject({
    code: STUDENTS_ONLY_NOT_OFFERED,
  });
};

describe('the contract of the switch', () => {
  it('equals libs/contracts/students-only.json, which the composers read too', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'students-only.json'),
        'utf8'
      )
    );
    expect([...STUDENTS_ONLY_ASSOCIATION_TYPES]).toEqual(contract.types);
    expect(STUDENTS_ONLY_NOT_OFFERED).toBe(contract.code);
  });
});

describe('createPost and "Entre étudiants"', () => {
  it.each(['asso-1', 'list-1'])('stores the switch on a post of %s', async (associationId) => {
    const { service, saved } = makeService();
    await service.createPost(
      { markdown: 'x', authorId: 'a', associationId, studentsOnly: true },
      false
    );
    expect(saved[0].studentsOnly).toBe(true);
  });

  it('is OFF when not asked, for every author', async () => {
    const { service, saved } = makeService();
    await service.createPost({ markdown: 'x', authorId: 'a', associationId: 'asso-1' }, false);
    expect(saved[0].studentsOnly).toBe(false);
  });

  it.each([
    ['an institution', 'inst-1'],
    ['a personal post', undefined],
    ['an association no row has', 'gone-1'],
  ])('refuses it on %s, typed, and writes nothing', async (_label, associationId) => {
    const { service, saved } = makeService();
    expectNotOffered(
      await refusal(
        service.createPost(
          { markdown: 'x', authorId: 'a', associationId, studentsOnly: true },
          false
        )
      )
    );
    expect(saved).toHaveLength(0);
  });
});

describe('updatePost and "Entre étudiants" (decision 5: both ways, after publication)', () => {
  const stored = (over: Partial<Post> = {}): Partial<Post> => ({
    id: 'p1',
    authorId: 'a',
    associationId: 'asso-1',
    markdown: 'x',
    media: [],
    kind: 'post',
    studentsOnly: false,
    createdAt: new Date(),
    publishedAt: new Date(),
    ...over,
  });

  it.each([true, false])(
    'turns it %s and drops every cached feed page in the same request',
    async (next) => {
      const { service, saved, deleteByPattern, incr } = makeService(
        stored({ studentsOnly: !next })
      );
      await service.updatePost('p1', 'a', { markdown: 'x', studentsOnly: next });
      expect(saved[0].studentsOnly).toBe(next);
      // The generation moves (what makes it deterministic), then the sweep reclaims the pages.
      expect(incr).toHaveBeenCalledWith('posts:list:generation');
      expect(deleteByPattern).toHaveBeenCalledWith('posts:list:v3:*');
    }
  );

  it('leaves it alone when the edit does not name it (a client older than the switch)', async () => {
    const { service, saved } = makeService(stored({ studentsOnly: true }));
    await service.updatePost('p1', 'a', { markdown: 'y' });
    expect(saved[0].studentsOnly).toBe(true);
  });

  it("changes a reel's switch with its caption", async () => {
    const { service, saved } = makeService(
      stored({ kind: 'reel', expiresAt: new Date(Date.now() + 86_400_000) })
    );
    await service.updatePost('p1', 'a', { markdown: 'caption', studentsOnly: true });
    expect(saved[0].studentsOnly).toBe(true);
  });

  it("refuses to turn it on for an institution's post, and always lets it be turned off", async () => {
    const on = makeService(stored({ associationId: 'inst-1' }));
    expectNotOffered(
      await refusal(on.service.updatePost('p1', 'a', { markdown: 'x', studentsOnly: true }))
    );
    expect(on.saved).toHaveLength(0);
    // A row carrying the switch on an entity that is no longer offered it can always be reopened.
    const off = makeService(stored({ associationId: 'inst-1', studentsOnly: true }));
    await off.service.updatePost('p1', 'a', { markdown: 'x', studentsOnly: false });
    expect(off.saved[0].studentsOnly).toBe(false);
  });
});
