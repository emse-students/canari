import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';

/**
 * THE REVERSE OF `linkedCalendarEventId`: GIVEN AN EVENT, FIND THE POST THAT NAMES IT.
 *
 * Reported by a user: linking an event on a post only ever showed the event ON the post, never
 * the post on the event's own card - because there is no `linkedPostId` column on the event to
 * read forward from. `findPostLinkedToCalendarEvent` answers the question the other way, against
 * the same `posts` table `linkedCalendarEventId` already lives in, rather than inventing a second
 * pointer that could drift from the first.
 */
describe('PostsService.findPostLinkedToCalendarEvent', () => {
  function makeService(rows: unknown[]) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const postRepo = {
      manager: {
        query: jest.fn((sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          return Promise.resolve(rows);
        }),
      },
    };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService
    );
    return { service, calls };
  }

  const ROW = {
    id: 'p1',
    authorId: 'officer-1',
    anonymous: false,
    markdown: 'Le bureau organise...',
    createdAt: new Date('2026-09-01'),
    associationId: 'asso-1',
    linkedCalendarEventId: 'event-1',
    hiddenByModeration: false,
    assocJoinId: 'asso-1',
    assocName: 'BDE',
    assocSlug: 'bde',
    assocLogoUrl: null,
  };

  it('returns null when nothing links to the event', async () => {
    const { service } = makeService([]);
    await expect(
      service.findPostLinkedToCalendarEvent('event-1', undefined, false)
    ).resolves.toBeNull();
  });

  it('returns the post, shaped with the association identity', async () => {
    const { service } = makeService([ROW]);
    const result = await service.findPostLinkedToCalendarEvent('event-1', undefined, false);

    expect(result).toMatchObject({
      id: 'p1',
      markdown: 'Le bureau organise...',
      association: { id: 'asso-1', name: 'BDE', slug: 'bde' },
    });
    // A personal post's authorId would be masked by mustHideAnonymousAuthor; an association
    // post's is stripped unconditionally by the same branch of shapeListRow either way.
    expect(result).not.toHaveProperty('authorId');
  });

  it('queries by the event id, excludes moderation-hidden posts, and takes only the latest', async () => {
    const { service, calls } = makeService([ROW]);
    await service.findPostLinkedToCalendarEvent('event-1', undefined, false);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/"linkedCalendarEventId"\s*=\s*\$1/);
    expect(calls[0].sql).toMatch(/NOT COALESCE\(posts\."hiddenByModeration", false\)/);
    expect(calls[0].sql).toMatch(/ORDER BY posts\."createdAt" DESC/);
    expect(calls[0].sql).toMatch(/LIMIT 1/);
    expect(calls[0].params).toEqual(['event-1']);
  });
});
