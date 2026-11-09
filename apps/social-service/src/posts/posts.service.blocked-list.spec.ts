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
  /**
   * What only the reader's own block lookup (`blockedUserIdsFor`) says: since WP-F5 the visibility
   * predicate of every feed query names `user_blocks` too (a follower's opening checks the block).
   */
  const BLOCK_READ = 'AS "otherId" FROM user_blocks';

  function makeQueryMock(blocks: string[] = [BLOCKED]) {
    const calls: string[] = [];
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes(BLOCK_READ)) {
        return Promise.resolve(blocks.map((otherId) => ({ otherId })));
      }
      // The one-row visibility read (WP6b): every reader here is inside the post's audience.
      if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
      // No reader here is a named reader: nothing is withheld (`commentsWithheldPostIds`).
      if (sql.includes('read_grant_readers')) return Promise.resolve([]);
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
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: () => Promise.resolve(false),
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

  /** The feed query, which is the one naming `FROM posts` rather than the block lookup. */
  const feedSql = (calls: string[]) =>
    calls.find((sql) => sql.includes('FROM posts') && !sql.includes(BLOCK_READ)) ?? '';

  it('reads the block list in BOTH directions, so it hides the blocker from the blocked too', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    const blocksQuery = calls.find((sql) => sql.includes(BLOCK_READ)) ?? '';
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
    // An anonymous or association comment is exempt, or a block would probe its writer.
    const exemptions = sql.match(/elem->>'anonymous' = 'true'/g) ?? [];
    expect(exemptions).toHaveLength(2);
    // So is a moderation tombstone, in the window AND the count: hiding it from whoever blocked its
    // real writer would name that writer (second review of #2999).
    const tombstones = sql.match(/elem->>'removedByModeration' = 'true'/g) ?? [];
    expect(tombstones).toHaveLength(2);
  });

  it('emits no clause at all when the viewer has blocked nobody', async () => {
    const { query, calls } = makeQueryMock([]);
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' });

    const sql = feedSql(calls);
    expect(sql).not.toMatch(/<> ALL/);
    // The count still leaves out the moderation tombstones (lead's review of #2999).
    expect(sql).toMatch(/elem->>'removedByModeration', ''\) <> 'true'/);
  });

  it('filters the associations feed like the others - a member post an association carries is in it', async () => {
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
    expect(sql).toMatch(/posts\."authorId" <> ALL\(\$\d+::text\[\]\)/);
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
          !(c[0] as string).includes(BLOCK_READ)
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

    // The FEED's filter on hidden posts is absent; the pin rank in the ORDER BY reads the column of
    // the PINNED post (`rk_post`) - a pin is never shown for a hidden post (WP-PIN).
    expect(feedSql(calls)).not.toMatch(/posts\."hiddenByModeration"/);
  });

  /**
   * The feed and search hand a page through `viewerContext` and `shapeListRow` - the SHIPPED path,
   * not the shaping helpers on a fixture: deleting the withholding call there must fail here.
   */
  describe('a page of posts, for a reader the comments predicate names (owner, 2026-11-04)', () => {
    const ROW = {
      ...POST,
      authorId: 'someone-else',
      commentCount: 1,
      comments: [{ id: 'c1', userId: 'someone-else', text: 'a student speaks', likes: [] }],
      reactions: { 'someone-else': 'like' },
    };
    /** `withheld`: what `commentsWithheldPostIds` answers. The page's post is never grant-free. */
    function pageMock(withheld: string[]) {
      return jest.fn((sql: string) => {
        if (sql.includes(BLOCK_READ)) return Promise.resolve([]);
        if (sql.includes('read_grant_readers'))
          return Promise.resolve(withheld.map((id) => ({ id })));
        if (sql.includes('AS "firstHand"')) return Promise.resolve([]);
        if (sql.includes('FROM posts')) return Promise.resolve([{ ...ROW }]);
        return Promise.resolve([]);
      });
    }
    const pages = {
      feed: (service: PostsService) =>
        service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'viewer-1' }),
      search: (service: PostsService) =>
        service.searchPosts('student', 20, 0, { viewerUserId: 'viewer-1' }),
    };

    it.each(Object.keys(pages) as (keyof typeof pages)[])(
      'the %s drops the comments, their count and who reacted',
      async (page) => {
        const rows = (await pages[page](makeService(pageMock(['p1'])))) as Record<string, any>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty('comments');
        expect(rows[0]).not.toHaveProperty('commentCount');
        expect(rows[0].canSeeComments).toBe(false);
        expect(rows[0].reactions).toEqual({});
        expect(rows[0].otherReactionCounts).toEqual({ like: 1 });
      }
    );

    it.each(Object.keys(pages) as (keyof typeof pages)[])(
      'the %s serves everything to a reader it names not',
      async (page) => {
        const rows = (await pages[page](makeService(pageMock([])))) as Record<string, any>[];
        expect(rows[0].commentCount).toBe(1);
        expect(rows[0].canSeeComments).toBe(true);
        expect(rows[0].reactions).toEqual({ 'someone-else': 'like' });
      }
    );

    it('asks the predicate nothing for an ordinary reader, whose page is grant-free', async () => {
      const { query, calls } = makeQueryMock([]);
      await makeService(query).listPosts({
        limit: 10,
        offset: 0,
        feed: 'all',
        viewerUserId: 'viewer-1',
      });
      expect(calls.some((sql) => sql.includes('read_grant_readers'))).toBe(false);
    });
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

    it('withholds the comments and the people from a reader the comments predicate names', async () => {
      // `commentsWithheldPostIds` answers p1 (owner, 2026-11-04): the served post carries no
      // comment, no count, and the reactions as the reader's own plus a tally.
      const comments = [{ id: 'c1', userId: 'someone-else', text: 'a student speaks' }];
      const findOne = jest.fn(() =>
        Promise.resolve(
          entity({
            authorId: 'someone-else',
            comments,
            reactions: { 'someone-else': 'like' },
          } as unknown as Partial<typeof POST>)
        )
      );
      const { query } = makeQueryMock([]);
      query.mockImplementation((sql: string) => {
        if (sql.includes('read_grant_readers')) return Promise.resolve([{ id: 'p1' }]);
        if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
        return Promise.resolve([]);
      });
      const service = makeService(query, findOne);

      const shaped = (await service.getById('p1', { viewerId: 'viewer-1' })) as Record<string, any>;

      expect(shaped).not.toHaveProperty('comments');
      expect(shaped).not.toHaveProperty('commentCount');
      expect(shaped.canSeeComments).toBe(false);
      expect(shaped.reactions).toEqual({});
      expect(shaped.otherReactionCounts).toEqual({ like: 1 });
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

    it('keeps a moderation tombstone whose writer the reader blocked, and the reply it holds', async () => {
      // A legacy tombstone still carries its writer's id; a new one carries none. Both stay.
      const comments = [
        { id: 't-old', userId: BLOCKED, text: '', removedByModeration: true },
        { id: 't-new', text: '', removedByModeration: true },
        { id: 'r', userId: 'officer', associationId: 'inst', parentId: 't-old', text: 'kept' },
      ];
      const findOne = jest.fn(() =>
        Promise.resolve(entity({ authorId: 'someone-else', comments } as Partial<typeof POST>))
      );
      const { query } = makeQueryMock();
      const service = makeService(query, findOne);

      const shaped = (await service.getById('p1', { viewerId: 'viewer-1' })) as {
        comments: { id: string }[];
      };

      expect(shaped.comments.map((c) => c.id)).toEqual(['t-old', 't-new', 'r']);
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
