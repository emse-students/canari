import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import { ASSOCIATIONS_FEED_AT_SQL, IN_ASSOCIATIONS_FEED_SQL } from './associations-feed-sql';

/**
 * THE "ASSOCIATIONS" FEED HOLDS WHAT ASSOCIATIONS REPUBLISH, AT THE REPUBLICATION'S DATE (user,
 * 2026-10-24). The arm read `posts."associationId" IS NOT NULL` alone, so a member's post the BDE
 * republished never entered it. What the two clauses SELECT is proven against PostgreSQL in
 * `associations-feed-sql.integration.spec.ts`; this proves the arm is built from them, on the SQL
 * text, as the neighbouring list specs do - the filtering happens inside the query.
 */
describe('PostsService associations feed', () => {
  function makeService() {
    const calls: string[] = [];
    const query = jest.fn((sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    });
    const service = new PostsService(
      { manager: { query }, findOne: jest.fn() } as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      {
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
        isContentModerator: jest.fn(() => Promise.resolve(false)),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    const feedSql = () => calls.find((sql) => sql.includes('FROM posts')) ?? '';
    return { service, feedSql };
  }

  it('takes a republished post, not only an association one', async () => {
    const { service, feedSql } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'associations', viewerUserId: 'v1' });

    const sql = feedSql();
    expect(sql).toContain(IN_ASSOCIATIONS_FEED_SQL);
    expect(sql).not.toMatch(/WHERE posts\."associationId" IS NOT NULL\s+AND/);
  });

  it('places each row at its latest republication, pinned posts still first', async () => {
    const { service, feedSql } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'associations', viewerUserId: 'v1' });

    expect(feedSql()).toContain(
      `ORDER BY posts.pinned DESC, ${ASSOCIATIONS_FEED_AT_SQL} DESC, posts.id DESC`
    );
  });

  it('the CanaReels list of this feed keeps the same date, with no pin', async () => {
    const { service, feedSql } = makeService();
    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'associations',
      viewerUserId: 'v1',
      kind: 'reel',
    });

    expect(feedSql()).toContain(`ORDER BY ${ASSOCIATIONS_FEED_AT_SQL} DESC, posts.id DESC`);
  });

  it('leaves the other feeds at their publication date', async () => {
    const { service, feedSql } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'v1' });

    const sql = feedSql();
    expect(sql).not.toContain(IN_ASSOCIATIONS_FEED_SQL);
    expect(sql).toContain('ORDER BY posts.pinned DESC, posts."publishedAt" DESC, posts.id DESC');
  });
});
