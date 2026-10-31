import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import {
  inAssociationsFeedSql,
  republishedFeedAtSql,
  republishedForViewerSql,
} from './republished-feed-sql';

/**
 * "ASSOCIATIONS" AND "SUIVIS" HOLD WHAT ASSOCIATIONS REPUBLISH, AT THE REPUBLICATION'S DATE (user,
 * 2026-10-24). Both arms read `posts."associationId"` alone, so a member's post the BDE republished
 * entered neither. What the clauses SELECT is proven against PostgreSQL in
 * `republished-feed-sql.integration.spec.ts`; this proves each arm is built from them, with the
 * viewer's own placeholder, on the SQL text - the filtering happens inside the query.
 *
 * Nobody is blocked and no promo cutoff applies here, so the viewer is the first free placeholder:
 * `$3` in "Associations", `$5` in "Suivis" (whose `$3` is the followed associations).
 */
describe('PostsService feeds of what associations republish', () => {
  function makeService() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve([]);
    });
    const service = new PostsService(
      { manager: { query }, findOne: jest.fn() } as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {
        getFollowedAssociationIdsForUser: jest.fn(() => Promise.resolve(['bde'])),
        getFollowedUserIdsForUser: jest.fn(() => Promise.resolve(['member-1'])),
      } as unknown as FollowsService,
      {
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
        isContentModerator: jest.fn(() => Promise.resolve(false)),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    const feed = () => calls.find((c) => c.sql.includes('LIMIT $1 OFFSET $2'))!;
    return { service, feed };
  }

  describe('Associations', () => {
    it('takes a post republished by an association the reader sees, not only an association one', async () => {
      const { service, feed } = makeService();
      await service.listPosts({ limit: 10, offset: 0, feed: 'associations', viewerUserId: 'v1' });

      const { sql, params } = feed();
      expect(sql).toContain(inAssociationsFeedSql('$3'));
      expect(sql).not.toMatch(/WHERE posts\."associationId" IS NOT NULL\s+AND/);
      expect(params[2]).toBe('v1');
    });

    it('places each row at its latest counted republication, pinned posts still first', async () => {
      const { service, feed } = makeService();
      await service.listPosts({ limit: 10, offset: 0, feed: 'associations', viewerUserId: 'v1' });

      expect(feed().sql).toContain(
        `ORDER BY posts.pinned DESC, ${republishedFeedAtSql('$3')} DESC, posts.id DESC`
      );
    });

    it('the CanaReels list of this feed keeps the same date, with no pin', async () => {
      const { service, feed } = makeService();
      await service.listPosts({
        limit: 10,
        offset: 0,
        feed: 'associations',
        viewerUserId: 'v1',
        kind: 'reel',
      });

      expect(feed().sql).toContain(`ORDER BY ${republishedFeedAtSql('$3')} DESC, posts.id DESC`);
    });
  });

  describe('Suivis', () => {
    it('takes what a FOLLOWED association republished, never an anonymous post', async () => {
      const { service, feed } = makeService();
      await service.listPosts({ limit: 10, offset: 0, feed: 'followed', viewerUserId: 'v1' });

      const { sql, params } = feed();
      expect(sql).toContain(
        `OR (NOT COALESCE(posts.anonymous, false)
             AND ${republishedForViewerSql('$5', '$3')})`
      );
      expect(params[2]).toEqual(['bde']);
      expect(params[4]).toBe('v1');
    });

    it('places a row at the latest republication by a followed association', async () => {
      const { service, feed } = makeService();
      await service.listPosts({ limit: 10, offset: 0, feed: 'followed', viewerUserId: 'v1' });

      expect(feed().sql).toContain(
        `ORDER BY posts.pinned DESC, ${republishedFeedAtSql('$5', '$3')} DESC, posts.id DESC`
      );
    });
  });

  it('leaves "Tout" at its publication date and out of the republication clauses', async () => {
    const { service, feed } = makeService();
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'v1' });

    const { sql } = feed();
    expect(sql).not.toContain('post_republications rf_');
    expect(sql).toContain('ORDER BY posts.pinned DESC, posts."publishedAt" DESC, posts.id DESC');
  });
});
