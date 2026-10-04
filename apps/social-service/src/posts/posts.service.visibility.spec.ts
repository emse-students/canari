import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import { PostAudience } from '../spaces/post-audience.entity';

/**
 * WHICH POSTS A READER GETS (WP6b), as `PostsService` wires it.
 *
 * WHO the predicate admits is proven against PostgreSQL in `reader-spaces.integration.spec.ts`.
 * What this file pins is the wiring a fake can see: every read hands the predicate THE READER, at
 * the placeholder the SQL names (an off-by-one would filter on the promo cutoff or the block list
 * instead, silently), a post the reader may not see is a 404 even when it is also hidden, and a
 * post's own rules are refused outside the association's ceiling before anything is written.
 */

const VIEWER = 'viewer-1';
const ASSO = 'asso-1';

/** Every pair the migration seeds. */
const ALL_SPACES = ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'].flatMap((formation) =>
  ['saint-etienne', 'gardanne'].map((campus) => ({ formation, campus }))
);

function makeService(opts: {
  visible?: boolean;
  promo?: number | null;
  blocks?: string[];
  ceiling?: { formation: string | null; campus: string | null }[];
  existing?: Partial<Post>;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('AS visible')) return Promise.resolve([{ visible: opts.visible ?? true }]);
    if (sql.includes('FROM user_blocks')) {
      return Promise.resolve((opts.blocks ?? []).map((otherId) => ({ otherId })));
    }
    if (sql.includes('SELECT promo FROM users'))
      return Promise.resolve([{ promo: opts.promo ?? null }]);
    if (sql.includes('FROM association_audiences')) return Promise.resolve(opts.ceiling ?? []);
    if (sql.includes('FROM spaces')) return Promise.resolve(ALL_SPACES);
    return Promise.resolve([]);
  });
  const tx = {
    save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
    insert: jest.fn(() => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
  };
  const postRepo = {
    create: jest.fn((data: Partial<Post>) => ({ ...data })),
    save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
    findOne: jest.fn(() => Promise.resolve(opts.existing ?? null)),
    manager: {
      query,
      transaction: jest.fn((fn: (m: typeof tx) => unknown) => fn(tx)),
    },
  };
  const associations = {
    mayAct: jest.fn(() => Promise.resolve(true)),
    mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
    isContentModerator: jest.fn(() => Promise.resolve(false)),
    findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
  };
  const follows = {
    getFollowedAssociationIdsForUser: jest.fn(() => Promise.resolve([ASSO])),
    getFollowedUserIdsForUser: jest.fn(() => Promise.resolve(['someone'])),
  };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    {
      get: jest.fn(),
      setex: jest.fn(),
      deleteByPattern: jest.fn(() => Promise.resolve(0)),
    } as unknown as RedisService,
    follows as unknown as FollowsService,
    associations as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    { release: jest.fn() } as unknown as PostMediaRetentionService
  );
  return { service, calls, postRepo, tx };
}

/** The placeholder the predicate names, read back out of the SQL, and the value passed there. */
function viewerAt(call: { sql: string; params: unknown[] }): unknown {
  const match = /vis_viewer\.id = \$(\d+)/.exec(call.sql);
  expect(match).not.toBeNull();
  return call.params[Number(match![1]) - 1];
}

const feedQuery = (calls: { sql: string; params: unknown[] }[]) =>
  calls.find((c) => c.sql.includes('FROM posts') && c.sql.includes('LIMIT $1 OFFSET $2'))!;

describe('every feed arm asks the predicate about the reader, at the placeholder it names', () => {
  it.each([
    ['all', null, []],
    ['all', 2023, ['b1']],
    ['associations', 2023, []],
    ['associations', null, ['b1']],
    ['followed', 2023, ['b1']],
    ['followed', null, []],
    ['custom', 2023, ['b1']],
    ['custom', null, []],
  ] as const)('%s (promo %s, blocks %j)', async (feed, promo, blocks) => {
    const { service, calls } = makeService({ promo, blocks: [...blocks] });
    await service.listPosts({ limit: 10, offset: 0, feed, viewerUserId: VIEWER });
    expect(viewerAt(feedQuery(calls))).toBe(VIEWER);
  });

  it('search too', async () => {
    for (const blocks of [[], ['b1']]) {
      const { service, calls } = makeService({ blocks });
      await service.searchPosts('gala', 10, 0, { viewerUserId: VIEWER });
      expect(viewerAt(feedQuery(calls))).toBe(VIEWER);
    }
  });

  it('a read with no reader passes NULL, which matches nobody, rather than skipping the clause', async () => {
    const { service, calls } = makeService({});
    await service.searchPosts('gala', 10, 0, {});
    expect(viewerAt(feedQuery(calls))).toBeNull();
  });
});

describe('one post the reader may not see', () => {
  const post = { id: 'p1', authorId: 'a1', associationId: ASSO, hiddenByModeration: false };

  it('is a 404', async () => {
    const { service, calls } = makeService({ visible: false, existing: post });
    await expect(service.getById('p1', { viewerId: VIEWER })).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(viewerAt(calls.find((c) => c.sql.includes('AS visible'))!)).toBe(VIEWER);
  });

  it('is a 404 even when it is ALSO moderation-hidden - a 403 would confirm the id', async () => {
    const { service } = makeService({
      visible: false,
      existing: { ...post, hiddenByModeration: true },
    });
    await expect(service.getById('p1', { viewerId: VIEWER })).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('is a 404 for the calendar-link read as well', async () => {
    const { service } = makeService({ visible: false });
    await expect(service.assertVisible('p1', VIEWER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("a post's own rules (D33), server side", () => {
  const icmSe = { formation: 'ICM', campus: 'saint-etienne' } as const;

  it('stores rules inside the ceiling with the post, in one transaction', async () => {
    const { service, tx, postRepo } = makeService({
      ceiling: [{ formation: null, campus: 'saint-etienne' }],
    });
    await service.createPost(
      { markdown: 'x', authorId: 'a1', associationId: ASSO, audiences: [icmSe] },
      false
    );
    expect(postRepo.save).not.toHaveBeenCalled();
    expect(tx.save).toHaveBeenCalledWith(
      expect.not.objectContaining({ audiences: expect.anything() })
    );
    expect(tx.insert).toHaveBeenCalledWith(PostAudience, [{ postId: 'p1', ...icmSe }]);
  });

  it('refuses a rule outside the ceiling with a 400, and writes nothing', async () => {
    const { service, tx, postRepo } = makeService({ ceiling: [icmSe] });
    await expect(
      service.createPost(
        {
          markdown: 'x',
          authorId: 'a1',
          associationId: ASSO,
          audiences: [{ campus: 'saint-etienne' }],
        },
        false
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.save).not.toHaveBeenCalled();
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('holds a global admin to the same ceiling', async () => {
    const { service } = makeService({ ceiling: [icmSe] });
    await expect(
      service.createPost(
        { markdown: 'x', authorId: 'a1', associationId: ASSO, audiences: [{}] },
        true
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses rules on a personal post, which inherits its author spaces', async () => {
    const { service } = makeService({});
    await expect(
      service.createPost({ markdown: 'x', authorId: 'a1', audiences: [icmSe] }, false)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves plainly when no rule is submitted', async () => {
    const { service, tx, postRepo } = makeService({});
    await service.createPost({ markdown: 'x', authorId: 'a1', associationId: ASSO }, false);
    expect(postRepo.save).toHaveBeenCalled();
    expect(tx.save).not.toHaveBeenCalled();
  });

  it('an edit with an empty list drops the rules: the post inherits again', async () => {
    const { service, tx } = makeService({
      existing: { id: 'p1', authorId: 'a1', associationId: ASSO, kind: 'post', markdown: 'x' },
    });
    await service.updatePost('p1', 'a1', { markdown: 'y', audiences: [] });
    expect(tx.delete).toHaveBeenCalledWith(PostAudience, { postId: 'p1' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('an edit without the field leaves the rules alone', async () => {
    const { service, tx, postRepo } = makeService({
      existing: { id: 'p1', authorId: 'a1', associationId: ASSO, kind: 'post', markdown: 'x' },
    });
    await service.updatePost('p1', 'a1', { markdown: 'y' });
    expect(tx.delete).not.toHaveBeenCalled();
    expect(postRepo.save).toHaveBeenCalled();
  });
});
