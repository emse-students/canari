/**
 * AN INSTITUTION'S REACH AT THE WRITE (owner, 2026-11-10): mandatory on an institution's post and
 * refused, TYPED, on any other; changed after publication both ways; every change drops the whole
 * feed cache; served to every reader as one `reach` field; and the composer's options asked of a
 * publisher only. Who READS such a post is the predicate's, proven on PostgreSQL in
 * `institution-reach.integration.spec.ts`, which also judges the ceiling against a real audience.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
import {
  INSTITUTION_REACH_ASSOCIATION_TYPES,
  INSTITUTION_REACH_CODES,
  INSTITUTION_REACH_PUBLICS,
  foldServedReach,
} from './institution-reach';

/** Association ids by type, as `associationTypeOf` reads them. */
const TYPES: Record<string, string> = {
  'asso-1': 'association',
  'inst-1': 'institution',
};
const ICM_SE = { formation: 'ICM', campus: 'saint-etienne' };
const ISMIN_SE = { formation: 'ISMIN', campus: 'saint-etienne' };
const ICM_GA = { formation: 'ICM', campus: 'gardanne' };

function makeService(existing?: Partial<Post>, opts: { canPost?: boolean } = {}) {
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
        // The institution's audience: the two Saint-Etienne spaces of the cases.
        if (sql.includes('FROM spaces ro_space')) return Promise.resolve([ICM_SE, ISMIN_SE]);
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
      mayAct: () => Promise.resolve(true),
      canPostAs: () => Promise.resolve(opts.canPost ?? true),
      resolvePostCalendarEventLink: () => Promise.resolve(null),
      findValidatedCalendarEventSummary: () => Promise.resolve(null),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    { release: jest.fn(), assertOwnMedia: jest.fn() } as unknown as PostMediaRetentionService
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

const expectCode = (e: unknown, code: string) => {
  expect(e).toBeInstanceOf(BadRequestException);
  expect((e as BadRequestException).getResponse()).toMatchObject({ code });
};

describe('the contract of the reach', () => {
  it('equals libs/contracts/institution-reach.json, which the composers read too', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'institution-reach.json'),
        'utf8'
      )
    );
    expect([...INSTITUTION_REACH_ASSOCIATION_TYPES]).toEqual(contract.types);
    expect([...INSTITUTION_REACH_PUBLICS]).toEqual(contract.publics);
    expect(INSTITUTION_REACH_CODES).toEqual(contract.codes);
  });
});

describe('createPost and the reach', () => {
  it("stores an institution's reach, its spaces sorted and folded", async () => {
    const { service, saved } = makeService();
    await service.createPost(
      {
        markdown: 'x',
        authorId: 'a',
        associationId: 'inst-1',
        reach: { spaces: [ISMIN_SE, ICM_SE, ICM_SE], public: 'students' },
      },
      false
    );
    expect(saved[0]).toMatchObject({ reachPublic: 'students', reachSpaces: [ICM_SE, ISMIN_SE] });
    expect(saved[0]).not.toHaveProperty('reach');
  });

  it("refuses an institution's post with no reach: there is no default", async () => {
    const { service, saved } = makeService();
    expectCode(
      await refusal(
        service.createPost({ markdown: 'x', authorId: 'a', associationId: 'inst-1' }, false)
      ),
      INSTITUTION_REACH_CODES.required
    );
    expect(saved).toHaveLength(0);
  });

  it('refuses a space outside the institution audience', async () => {
    const { service, saved } = makeService();
    expectCode(
      await refusal(
        service.createPost(
          {
            markdown: 'x',
            authorId: 'a',
            associationId: 'inst-1',
            reach: { spaces: [ICM_SE, ICM_GA], public: 'all' },
          },
          false
        )
      ),
      INSTITUTION_REACH_CODES.outsideAudience
    );
    expect(saved).toHaveLength(0);
  });

  it.each([
    ['an association', 'asso-1'],
    ['a personal post', undefined],
  ])('refuses a reach on %s, and stores none without one', async (_label, associationId) => {
    const refused = makeService();
    expectCode(
      await refusal(
        refused.service.createPost(
          {
            markdown: 'x',
            authorId: 'a',
            associationId,
            reach: { spaces: [ICM_SE], public: 'all' },
          },
          false
        )
      ),
      INSTITUTION_REACH_CODES.notOffered
    );
    const plain = makeService();
    await plain.service.createPost({ markdown: 'x', authorId: 'a', associationId }, false);
    expect(plain.saved[0]).toMatchObject({ reachPublic: null, reachSpaces: null });
  });
});

describe('updatePost and the reach (both ways, after publication)', () => {
  const stored = (over: Partial<Post> = {}): Partial<Post> => ({
    id: 'p1',
    authorId: 'a',
    associationId: 'inst-1',
    markdown: 'x',
    media: [],
    kind: 'post',
    studentsOnly: false,
    reachPublic: 'all',
    reachSpaces: [ICM_SE, ISMIN_SE],
    createdAt: new Date(),
    publishedAt: new Date(),
    ...over,
  });

  it('narrows, and drops every cached feed page in the same request', async () => {
    const { service, saved, deleteByPattern, incr } = makeService(stored());
    await service.updatePost('p1', 'a', {
      markdown: 'x',
      reach: { spaces: [ICM_SE], public: 'staff' },
    });
    expect(saved[0]).toMatchObject({ reachPublic: 'staff', reachSpaces: [ICM_SE] });
    expect(incr).toHaveBeenCalledWith('posts:list:generation');
    expect(deleteByPattern).toHaveBeenCalledWith('posts:list:v3:*');
  });

  it('widens back', async () => {
    const { service, saved } = makeService(stored({ reachPublic: 'staff', reachSpaces: [ICM_SE] }));
    await service.updatePost('p1', 'a', {
      markdown: 'x',
      reach: { spaces: [ICM_SE, ISMIN_SE], public: 'all' },
    });
    expect(saved[0]).toMatchObject({ reachPublic: 'all', reachSpaces: [ICM_SE, ISMIN_SE] });
  });

  it('leaves it alone when the edit does not name it, a post written before the reach included', async () => {
    const kept = makeService(stored());
    await kept.service.updatePost('p1', 'a', { markdown: 'y' });
    expect(kept.saved[0]).toMatchObject({ reachPublic: 'all', reachSpaces: [ICM_SE, ISMIN_SE] });
    const legacy = makeService(stored({ reachPublic: null, reachSpaces: null }));
    await legacy.service.updatePost('p1', 'a', { markdown: 'y' });
    expect(legacy.saved[0]).toMatchObject({ reachPublic: null, reachSpaces: null });
  });

  it("refuses a reach on an association's post and on a live replay", async () => {
    const asso = makeService(
      stored({ associationId: 'asso-1', reachPublic: null, reachSpaces: null })
    );
    expectCode(
      await refusal(
        asso.service.updatePost('p1', 'a', {
          markdown: 'x',
          reach: { spaces: [ICM_SE], public: 'all' },
        })
      ),
      INSTITUTION_REACH_CODES.notOffered
    );
    const replay = makeService(stored({ kind: 'replay' }));
    expectCode(
      await refusal(
        replay.service.updatePost('p1', 'a', {
          markdown: 'x',
          reach: { spaces: [ICM_SE], public: 'all' },
        })
      ),
      INSTITUTION_REACH_CODES.notOffered
    );
    expect([...asso.saved, ...replay.saved]).toHaveLength(0);
  });
});

describe('the options and the served field', () => {
  it("answers a publisher the institution's spaces, and refuses anyone else", async () => {
    expect(await makeService().service.listInstitutionReachOptions('inst-1', 'a', false)).toEqual({
      spaces: [ICM_SE, ISMIN_SE],
    });
    await expect(
      makeService(undefined, { canPost: false }).service.listInstitutionReachOptions(
        'inst-1',
        'a',
        false
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    expectCode(
      await refusal(makeService().service.listInstitutionReachOptions('asso-1', 'a', false)),
      INSTITUTION_REACH_CODES.notOffered
    );
  });

  it('serves ONE field, `reach`, and never the two columns', () => {
    const row: Record<string, unknown> = { reachPublic: 'students', reachSpaces: [ICM_SE] };
    foldServedReach(row);
    expect(row).toEqual({ reach: { spaces: [ICM_SE], public: 'students' } });
    const none: Record<string, unknown> = { reachPublic: null, reachSpaces: null };
    foldServedReach(none);
    expect(none).toEqual({ reach: null });
  });
});
