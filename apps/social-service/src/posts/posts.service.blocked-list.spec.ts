import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * A BLOCK HIDES WHAT THE VIEWER COULD ALREADY ATTRIBUTE, AND NOTHING MORE.
 *
 * The rule has two halves and the second is the one a later change is likely to "fix" by mistake:
 *
 * - a blocked account's PERSONAL post, and its comments anywhere, leave the viewer's feed, search,
 *   single-post read and the card attached to an agenda event, in BOTH directions;
 * - an ASSOCIATION post and an ANONYMOUS post are EXEMPT, because filtering either on `authorId`
 *   would make a block a de-anonymisation oracle - block a suspect, watch whether the post leaves
 *   the feed, unblock, and repeat. Nobody is notified of a block and lifting one costs a click, so
 *   that probe is free and repeatable until it names the author of every anonymous post.
 *
 * These assert on the SQL TEXT for the feed and search paths, like the anonymous-list spec next
 * door and for the same reason: the filtering happens inside the query, so a test that built its
 * own row fixture and called the shaping helpers would pass on the day the clause went missing.
 * The single-post path filters in JS, so that one is asserted on the value it returns.
 */
describe('PostsService hides a blocked account, and only where the author was visible', () => {
  const BLOCKED = 'blocked-1';

  const POST = {
    id: 'p1',
    authorId: BLOCKED,
    anonymous: false,
    associationId: null,
    markdown: 'test',
    mentions: [],
    links: null,
    attachedFormId: null,
    images: [],
    polls: [],
    forms: [],
    reactions: [],
    pinned: false,
    scheduledAt: null,
    hiddenByModeration: false,
    commentCount: 0,
    comments: [],
    assocJoinId: null,
    assocName: null,
    assocSlug: null,
    assocLogoUrl: null,
  };

  /**
   * A `manager.query` that answers each shape by matching on the SQL text.
   *
   * `blocks` is what the `user_blocks` read returns - the branch has to come first, because that
   * query names no table the other branches match on.
   */
  function makeQueryMock(blocks: string[] = [BLOCKED]) {
    const calls: string[] = [];
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve(blocks.map((otherId) => ({ otherId })));
      }
      if (sql.includes('FROM posts')) return Promise.resolve([{ ...POST }]);
      if (sql.includes('FROM users WHERE id = ANY')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    return { query, calls };
  }

  function makeService(query: jest.Mock, findOne?: jest.Mock) {
    const postRepo = { manager: { query }, findOne: findOne ?? jest.fn() };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
    };
    const follows = {
      getFollowedAssociationIdsForUser: jest.fn(() => Promise.resolve([])),
      getFollowedUserIdsForUser: jest.fn(() => Promise.resolve([BLOCKED])),
    };
    return new PostsService(
      postRepo as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      follows as unknown as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
  }

  /** The feed query, which is the one naming `FROM posts` rather than `FROM user_blocks`. */
  const feedSql = (calls: string[]) =>
    calls.find((sql) => sql.includes('FROM posts') && !sql.includes('FROM user_blocks')) ?? '';

  it('reads the block list in BOTH directions, so it hides the blocker from the blocked too', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    const blocksQuery = calls.find((sql) => sql.includes('FROM user_blocks')) ?? '';
    expect(blocksQuery).toMatch(/"blockerId" = \$1/);
    expect(blocksQuery).toMatch(/"blockedId" = \$1/);
    expect(blocksQuery).toMatch(/UNION/);
  });

  it('excludes a blocked account from the feed by author', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    expect(feedSql(calls)).toMatch(/posts\."authorId" <> ALL\(\$\d+::text\[\]\)/);
  });

  it('EXEMPTS an association post and an anonymous one - the oracle this must not become', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    // Both arms sit in front of the author test, so a post whose author the viewer could not read
    // in the first place is never weighed against the block list.
    expect(feedSql(calls)).toMatch(
      /posts\."associationId" IS NOT NULL\s*\n?\s*OR COALESCE\(posts\.anonymous, false\)\s*\n?\s*OR posts\."authorId" <> ALL/
    );
  });

  it('filters the comment WINDOW and the comment COUNT together', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    const sql = feedSql(calls);
    // The count stops being jsonb_array_length: that reads the WHOLE stored array, so it would
    // promise comments the window below is never going to hand over.
    expect(sql).not.toMatch(/jsonb_array_length/);
    expect(sql).toMatch(/SELECT COUNT\(\*\)::integer/);
    const guards = sql.match(/COALESCE\(elem->>'userId', ''\) <> ALL/g) ?? [];
    expect(guards).toHaveLength(2);
  });

  it('emits no clause at all when the viewer has blocked nobody', async () => {
    const { query, calls } = makeQueryMock([]);
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    const sql = feedSql(calls);
    expect(sql).not.toMatch(/<> ALL/);
    expect(sql).toMatch(/jsonb_array_length/);
  });

  it('filters the associations feed on comments only - every row there is already exempt', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'associations',
      viewerUserId: 'viewer-1',
    });

    const sql = feedSql(calls);
    expect(sql).toMatch(/COALESCE\(elem->>'userId', ''\) <> ALL/);
    expect(sql).not.toMatch(/posts\."authorId" <> ALL/);
  });

  it('filters the followed feed too - severing the two follows is best-effort', async () => {
    // `UserBlocksService.severFollows` is a cross-service call that logs and carries on when it
    // fails, so "they no longer follow each other" is not a fact this query may rest on.
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'followed', viewerUserId: 'viewer-1' });

    expect(feedSql(calls)).toMatch(/posts\."authorId" <> ALL\(\$\d+::text\[\]\)/);
  });

  it('carries the same clause into search', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.searchPosts('test', 20, 0, { viewerUserId: 'viewer-1' });

    expect(feedSql(calls)).toMatch(/posts\."authorId" <> ALL\(\$\d+::text\[\]\)/);
  });

  /**
   * THE PLACEHOLDER THE CLAUSE NAMES MUST BE THE POSITION THE ARRAY WAS ACTUALLY PASSED AT.
   *
   * Every arm appends the block list last, so its index is whatever that arm's own parameters
   * leave free - and two of the four shift by one when a promo cutoff applies. Asserting a literal
   * `$5` would only pin the shape this mock happens to produce; reading the number back out of the
   * SQL and indexing the parameters with it is the invariant itself, and an off-by-one in any arm
   * fails here rather than at a reader's feed, where it would silently filter on the WRONG value.
   */
  it.each(['all', 'followed', 'custom', 'associations'] as const)(
    'passes the block list at exactly the placeholder the %s query names',
    async (feed) => {
      const { query } = makeQueryMock();
      const service = makeService(query);

      await service.listPosts({ limit: 10, offset: 0, feed, viewerUserId: 'viewer-1' });

      const call = query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('FROM posts') &&
          !(c[0] as string).includes('FROM user_blocks')
      );
      const [sql, params = []] = call;
      const placeholder = /<> ALL\(\$(\d+)::text\[\]\)/.exec(sql);
      expect(placeholder).not.toBeNull();
      expect(params[Number(placeholder![1]) - 1]).toEqual([BLOCKED]);
    }
  );

  it('search also stopped serving moderation-hidden posts and the store-review account', async () => {
    // Found while adding the block filter: a search result renders the same card as a feed row,
    // and this query carried NONE of the feed's exclusions - a post auto-hidden by the report
    // threshold was reachable by anyone who typed a word of it.
    const { query, calls } = makeQueryMock([]);
    const service = makeService(query);

    await service.searchPosts('test', 20, 0, { viewerUserId: 'viewer-1' });

    expect(feedSql(calls)).toMatch(/NOT COALESCE\(posts\."hiddenByModeration", false\)/);
  });

  it('still serves a moderation-hidden post to a platform admin searching for it', async () => {
    const { query, calls } = makeQueryMock([]);
    const service = makeService(query);

    await service.searchPosts('test', 20, 0, { viewerUserId: 'admin-1', isAdmin: true });

    expect(feedSql(calls)).not.toMatch(/hiddenByModeration/);
  });

  describe('a single post read by id', () => {
    const entity = (over: Partial<typeof POST> = {}) =>
      ({ ...POST, ...over, media: [], scheduledAt: null }) as unknown as Post;

    it('refuses a blocked account personal post', async () => {
      const findOne = jest.fn(() => Promise.resolve(entity()));
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      await expect(service.getById('p1', { viewerId: 'viewer-1' })).rejects.toThrow(
        'Post not found'
      );
    });

    it('still serves their ANONYMOUS post - a 404 here would name its author', async () => {
      const findOne = jest.fn(() => Promise.resolve(entity({ anonymous: true })));
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      const shaped = await service.getById('p1', { viewerId: 'viewer-1' });

      expect(shaped.id).toBe('p1');
      expect(shaped.authorId).toBeUndefined();
    });

    it('still serves their ASSOCIATION post, whose publisher nobody can read anyway', async () => {
      const findOne = jest.fn(() => Promise.resolve(entity({ associationId: 'assoc-1' })));
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      const shaped = await service.getById('p1', { viewerId: 'viewer-1' });

      expect(shaped.id).toBe('p1');
      expect(shaped.authorId).toBeUndefined();
    });

    it('drops a blocked account comments from a post written by somebody else', async () => {
      const comments = [
        { id: 'c1', userId: 'someone-else', text: 'kept' },
        { id: 'c2', userId: BLOCKED, text: 'hidden' },
      ];
      const findOne = jest.fn(() =>
        Promise.resolve(entity({ authorId: 'someone-else', comments } as Partial<typeof POST>))
      );
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      const shaped = (await service.getById('p1', { viewerId: 'viewer-1' })) as {
        comments: { id: string }[];
      };

      expect(shaped.comments.map((c) => c.id)).toEqual(['c1']);
    });

    it('lets a platform admin open it anyway - the same flag that opens a hidden post', async () => {
      const findOne = jest.fn(() => Promise.resolve(entity()));
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      const shaped = await service.getById('p1', {
        viewerId: 'admin-1',
        allowHidden: true,
        isGlobalAdmin: true,
      });

      expect(shaped.id).toBe('p1');
    });
  });
});
