import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import { hasPostSearchCriteria, postSearchFilterSql } from './post-search-filters';

/** The binder `searchPosts` hands the clause builder: pushes the value, returns its placeholder. */
function binder(start = 2) {
  const params: unknown[] = Array.from({ length: start }, () => null);
  return { params, bind: (value: unknown) => params.push(value) };
}

describe('postSearchFilterSql', () => {
  it('reads the words alone as before: one ILIKE over the text and the association name', () => {
    const { params, bind } = binder();
    const sql = postSearchFilterSql('gala', {}, bind);
    expect(sql).toContain('posts.markdown ILIKE $3 OR assoc.name ILIKE $3');
    expect(params[2]).toBe('%gala%');
  });

  it("a person is their PERSONAL, non-anonymous posts: never the officer behind an association's post", () => {
    const { params, bind } = binder();
    const sql = postSearchFilterSql('', { authorId: 'user-1' }, bind);
    expect(sql).toContain('posts."associationId" IS NULL');
    expect(sql).toContain('NOT COALESCE(posts.anonymous, false)');
    expect(sql).toContain('posts."authorId" = $3');
    expect(params[2]).toBe('user-1');
    expect(sql).not.toContain('ILIKE');
  });

  it('an association is the posts published as it', () => {
    const { params, bind } = binder();
    const assoc = '3c1d57de-1c93-4d63-8f66-5b6c1a7d0a11';
    const sql = postSearchFilterSql('', { associationId: assoc }, bind);
    expect(sql).toContain('posts."associationId" = $3::uuid');
    expect(params[2]).toBe(assoc);
  });

  it('combines the words and both filters, each at the placeholder its clause names', () => {
    const { params, bind } = binder();
    const sql = postSearchFilterSql('gala', { authorId: 'u', associationId: 'a' }, bind);
    expect(sql).toContain('ILIKE $3');
    expect(sql).toContain('"authorId" = $4');
    expect(sql).toContain('"associationId" = $5::uuid');
    expect(params.slice(2)).toEqual(['%gala%', 'u', 'a']);
  });

  it('names something to look for only with words or a filter', () => {
    expect(hasPostSearchCriteria('', {})).toBe(false);
    expect(hasPostSearchCriteria('', { authorId: '  ' })).toBe(false);
    expect(hasPostSearchCriteria('x', {})).toBe(true);
    expect(hasPostSearchCriteria('', { authorId: 'u' })).toBe(true);
    expect(hasPostSearchCriteria('', { associationId: 'a' })).toBe(true);
  });
});

describe('PostsService.searchPosts with a filter keeps every audience rule', () => {
  function makeService() {
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT promo FROM users')) return Promise.resolve([{ promo: null }]);
      return Promise.resolve([]);
    });
    const service = new PostsService(
      { manager: { query } } as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      {
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
        isContentModerator: jest.fn(() => Promise.resolve(false)),
        moderatedPostIds: () => Promise.resolve(new Set<string>()),
        mayModeratePost: () => Promise.resolve(false),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, query };
  }

  const searchCall = (query: jest.Mock): [string, unknown[]] =>
    query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('FROM posts')
    ) as [string, unknown[]];

  it('a filter with no words still runs the search, and keeps the audience, block and hidden clauses', async () => {
    const { service, query } = makeService();

    await service.searchPosts('', 20, 0, { viewerUserId: 'viewer-1' }, { authorId: 'user-1' });

    const [sql, params] = searchCall(query);
    // The filter is one more AND; the audience predicate of the feed is still in the query.
    expect(sql).toContain('"authorId" = $');
    expect(sql).toMatch(/"scheduledAt" IS NULL/);
    expect(sql).toMatch(/viewer|reach|audience|space/i);
    const bound = /"authorId" = \$(\d+)/.exec(sql);
    expect(params[Number(bound![1]) - 1]).toBe('user-1');
  });

  it('answers nothing, and asks nothing, when there are no words and no filter', async () => {
    const { service, query } = makeService();

    await expect(service.searchPosts('  ', 20, 0, { viewerUserId: 'v' }, {})).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
