import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * THE FEED AND THE SEARCH KEEP A REVIEW ACCOUNT'S POSTS FROM A MEMBER BY AUTHOR (review-cohort.ts,
 * `reviewCohortAuthorFilterSql`), and never from the cohort itself or from an admin opening them.
 * The clause's SQL is proven against PostgreSQL in `review-cohort.integration.spec.ts`; these
 * assert it reaches the query text of both paths, for the right readers.
 */
describe('PostsService feed and search and the review cohort', () => {
  const REVIEWER = 'reviewer-1';
  const CLAUSE = /AND NOT \(posts\."authorId" = ANY \(string_to_array\(convert_from\(decode\('/;
  const saved = process.env.SERVICE_ACCOUNT_USER_ID;
  beforeEach(() => {
    process.env.SERVICE_ACCOUNT_USER_ID = REVIEWER;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
    else process.env.SERVICE_ACCOUNT_USER_ID = saved;
  });

  function makeService() {
    const calls: string[] = [];
    const query = jest.fn((sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    });
    const service = new PostsService(
      { manager: { query }, findOne: jest.fn() } as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {
        getFollowedAssociationIdsForUser: jest.fn(() => Promise.resolve([])),
        getFollowedUserIdsForUser: jest.fn(() => Promise.resolve([])),
      } as unknown as FollowsService,
      {
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
        isContentModerator: jest.fn(() => Promise.resolve(false)),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    const postsSql = () => calls.filter((sql) => sql.includes('FROM posts')).join('\n');
    return { service, postsSql };
  }

  it.each([
    ['a member', 'member-1', false, true],
    ['an admin', 'admin-1', true, false],
    ['a review account', REVIEWER, false, false],
  ])('the feed of %s carries the clause: %s', async (_who, viewerUserId, isAdmin, carries) => {
    const { service, postsSql } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId, isAdmin });
    expect(CLAUSE.test(postsSql())).toBe(carries);
  });

  it.each([
    ['a member', 'member-1', false, true],
    ['an admin', 'admin-1', true, false],
    ['a review account', REVIEWER, false, false],
  ])('the search of %s carries the clause: %s', async (_who, viewerUserId, isAdmin, carries) => {
    const { service, postsSql } = makeService();
    await service.searchPosts('test', 20, 0, { viewerUserId, isAdmin });
    expect(CLAUSE.test(postsSql())).toBe(carries);
  });

  it('writes no clause at all with no cohort configured', async () => {
    delete process.env.SERVICE_ACCOUNT_USER_ID;
    const { service, postsSql } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'member-1' });
    expect(postsSql()).not.toMatch(/convert_from\(decode\(/);
  });
});
