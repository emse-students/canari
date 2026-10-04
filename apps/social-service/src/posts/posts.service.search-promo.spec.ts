import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * THE SEARCH STOPS WHERE THE FEED STOPS: THE VIEWER'S PROMO CUTOFF.
 *
 * Reported by the user on 2026-08-23 - *"la recherche dans les posts permet d'acceder a des posts
 * apres notre arrivee a l'EMSE (la recherche desactive les filtres ?)"*. `listPosts` cuts its
 * history at the August the viewer's promo opens on (`promo-visibility.ts`); `searchPosts` carried
 * every other feed exclusion and not that one. Asserted on the SQL text and on the parameter the
 * placeholder names, like the blocked-list spec next door, because the filtering is in the query.
 */
describe('PostsService.searchPosts applies the promo cutoff', () => {
  function makeService(promo: number | null, blocks: string[] = []) {
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT promo FROM users')) return Promise.resolve([{ promo }]);
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve(blocks.map((otherId) => ({ otherId })));
      }
      return Promise.resolve([]);
    });
    const service = new PostsService(
      { manager: { query } } as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      {
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
        isContentModerator: jest.fn(() => Promise.resolve(false)),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, query };
  }

  /** The search query itself, and the parameters it was run with. */
  const searchCall = (query: jest.Mock): [string, unknown[]] =>
    query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('FROM posts')
    ) as [string, unknown[]];

  it('cuts at the August the viewer promo opens on, at the placeholder it names', async () => {
    const { service, query } = makeService(2024, ['blocked-1']);

    await service.searchPosts('gala', 20, 0, { viewerUserId: 'viewer-1' });

    const [sql, params] = searchCall(query);
    const cutoff =
      /COALESCE\(posts\."scheduledAt", posts\."createdAt"\) >= \$(\d+)::timestamptz/.exec(sql);
    expect(cutoff).not.toBeNull();
    expect(params[Number(cutoff![1]) - 1]).toBe('2024-08-01');
    // The block list still lands at the placeholder ITS clause names, after the cutoff.
    const blocked = /<> ALL\(\$(\d+)::text\[\]\)/.exec(sql);
    expect(params[Number(blocked![1]) - 1]).toEqual(['blocked-1']);
  });

  it('applies no cutoff to a global admin', async () => {
    const { service, query } = makeService(2024);

    await service.searchPosts('gala', 20, 0, { viewerUserId: 'admin-1', isAdmin: true });

    expect(searchCall(query)[0]).not.toMatch(/::timestamptz/);
  });

  it('applies no cutoff to a viewer whose row carries no promo', async () => {
    const { service, query } = makeService(null);

    await service.searchPosts('gala', 20, 0, { viewerUserId: 'viewer-1' });

    expect(searchCall(query)[0]).not.toMatch(/::timestamptz/);
  });
});
