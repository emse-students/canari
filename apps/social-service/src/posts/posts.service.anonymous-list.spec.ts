import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * `listPosts` AND `searchPosts` NEVER SELECTED `posts.anonymous`, SO THE MASK NEVER FIRED.
 *
 * `mustHideAnonymousAuthor` (now `viewerSeesWriter`) and `shapeListRow` were both correct - reported by a user who posted
 * anonymously and watched a second account read the real name straight off the feed. The two raw
 * SQL queries that actually populate the feed (`listPosts`'s shared `selectBody`, `searchPosts`'s
 * own copy) built their row from a fixed column list that named `authorId` but never `anonymous`,
 * so every row arrived with `anonymous: undefined` - and `mustHideAnonymousAuthor`'s first line,
 * `if (!post.anonymous) return false`, read that as "not anonymous" for every post, moderator or
 * not, self or not. The masking logic downstream was never wrong; it was never being asked the
 * right question, because the column carrying the answer never reached it.
 *
 * These assert on the actual SQL text alongside the shaped output, on purpose: a unit test that
 * builds its own `{ anonymous: true }` fixture object and calls `shapeListRow` directly would have
 * passed every day this bug shipped, for the same reason the cache-invalidation tests warn about
 * asserting on the call instead of on what a real query returns.
 */
describe('PostsService feed queries mask an anonymous personal post', () => {
  const ANON_POST = {
    id: 'p1',
    authorId: 'author-1',
    anonymous: true,
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

  const NAME_ROW = {
    id: 'author-1',
    displayName: 'Real Name',
    firstName: 'Real',
    lastName: 'Name',
  };

  /** A `manager.query` that answers each of `listPosts`'s three shapes by matching on the SQL text. */
  function makeQueryMock(post: Record<string, unknown> = ANON_POST) {
    const calls: string[] = [];
    const query = jest.fn((sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM posts')) return Promise.resolve([{ ...post }]);
      if (sql.includes('FROM users WHERE id = ANY')) return Promise.resolve([NAME_ROW]);
      if (sql.includes('SELECT promo FROM users')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    return { query, calls };
  }

  function makeService(query: jest.Mock, moderators: string[] = []) {
    const postRepo = { manager: { query } };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn((userId: string) => Promise.resolve(moderators.includes(userId))),
      moderatedPostIds: jest.fn((userId: string, ids: string[]) =>
        Promise.resolve(new Set(moderators.includes(userId) ? ids : []))
      ),
    };
    const follows = {
      getFollowedAssociationIdsForUser: jest.fn(() => Promise.resolve([])),
      getFollowedUserIdsForUser: jest.fn(() => Promise.resolve(['author-1'])),
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

  it('selects posts.anonymous, so the raw row can answer the question the mask asks', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'someone-else' });

    const feedQuery = calls.find((sql) => sql.includes('FROM posts'));
    expect(feedQuery).toMatch(/posts\.anonymous\b/);
  });

  it('strips the real name and id from an unrelated, non-moderator viewer', async () => {
    const { query } = makeQueryMock();
    const service = makeService(query);

    const [row] = await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      viewerUserId: 'someone-else',
    });

    expect(row.authorId).toBeUndefined();
    expect(row.authorDisplayName).toBeUndefined();
    expect(row.authorFirstName).toBeUndefined();
    expect(row.authorLastName).toBeUndefined();
  });

  it('still hides it from a signed-out reader', async () => {
    const { query } = makeQueryMock();
    const service = makeService(query);

    const [row] = await service.listPosts({ limit: 10, offset: 0, feed: 'all' });

    expect(row.authorId).toBeUndefined();
  });

  it("reveals the real name to the post's own author", async () => {
    const { query } = makeQueryMock();
    const service = makeService(query);

    const [row] = await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      viewerUserId: 'author-1',
    });

    expect(row.authorId).toBe('author-1');
    expect(row.authorDisplayName).toBe('Real Name');
  });

  it('reveals the real name to a content moderator', async () => {
    const { query } = makeQueryMock();
    const service = makeService(query, ['mod-1']);

    const [row] = await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      viewerUserId: 'mod-1',
    });

    expect(row.authorId).toBe('author-1');
  });

  it('withholds its form from the readers it hides the author from (a form names its manager)', async () => {
    // Stored before an anonymous post was refused a form: no row is rewritten, the read masks it.
    const FORM = '00000000-0000-4000-8000-00000000f0c3';
    const withForm = { ...ANON_POST, attachedFormId: FORM, forms: [{ id: FORM, title: 'Gala' }] };
    const read = async (viewerUserId: string | undefined, moderators: string[] = []) => {
      const { query } = makeQueryMock(withForm);
      const [row] = await makeService(query, moderators).listPosts({
        limit: 10,
        offset: 0,
        feed: 'all',
        viewerUserId,
      });
      return row;
    };

    const stranger = await read('someone-else');
    expect(stranger.attachedFormId).toBeUndefined();
    expect(stranger.forms).toEqual([]);
    expect((await read(undefined)).attachedFormId).toBeUndefined();
    expect((await read('author-1')).attachedFormId).toBe(FORM);
    expect((await read('mod-1', ['mod-1'])).attachedFormId).toBe(FORM);
  });

  it('excludes an anonymous post from the followed feed - membership itself is the leak', async () => {
    // Reported by a user: masking the author's name is not enough here, because appearing in the
    // "followed" feed at all already says "written by someone in the small, known set you follow" -
    // a leak the WHERE clause has to close, not a rendering choice.
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'followed',
      viewerUserId: 'someone-else',
    });

    const feedQuery = calls.find((sql) => sql.includes('FROM posts'));
    expect(feedQuery).toMatch(
      /"authorId"\s*=\s*ANY\(\$4::text\[\]\)\s*\n?\s*AND NOT posts\.anonymous/
    );
  });

  it('searchPosts selects posts.anonymous and masks it the same way', async () => {
    const { query, calls } = makeQueryMock();
    const service = makeService(query);

    const [row] = await service.searchPosts('test', 20, 0, { viewerUserId: 'someone-else' });

    const searchQuery = calls.find((sql) => sql.includes('FROM posts'));
    expect(searchQuery).toMatch(/posts\.anonymous\b/);
    expect(row.authorId).toBeUndefined();
  });
});
