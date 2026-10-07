import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * WHICH POSTS A READER GETS (WP6b), as `PostsService` wires it.
 *
 * WHO the predicate admits is proven against PostgreSQL in `reader-spaces.integration.spec.ts`.
 * What this file pins is the wiring a fake can see: every read hands the predicate THE READER, at
 * the placeholder the SQL names (an off-by-one would filter on the promo cutoff or the block list
 * instead, silently), and a post the reader may not see is a 404 even when it is also hidden.
 */

const VIEWER = 'viewer-1';
const ASSO = 'asso-1';

function makeService(opts: {
  visible?: boolean;
  promo?: number | null;
  blocks?: string[];
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
    return Promise.resolve([]);
  });
  const postRepo = {
    findOne: jest.fn(() => Promise.resolve(opts.existing ?? null)),
    manager: { query },
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
  return { service, calls };
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
