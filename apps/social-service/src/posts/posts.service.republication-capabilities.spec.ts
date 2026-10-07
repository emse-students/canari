import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * WHAT A CARD SAYS ABOUT REPUBLICATION (D38), decided by the server like every other control:
 * the "Republie par" line (`republishedBy`), and whether this reader may republish (`canRepublish`)
 * or propose (`canProposeRepublication`). Who may actually WRITE one is proven against PostgreSQL
 * in `republications.integration.spec.ts`; this pins the stamping a fake can see.
 */
describe('PostsService republication fields', () => {
  const A1 = 'asso-1';
  const A2 = 'asso-2';

  function makeService(opts: {
    post: Partial<Post>;
    /** Associations the reader may publish as, of a kind that republishes. */
    republishAs?: string[];
    /** Associations holding a republication of the post. */
    republishers?: string[];
    /** Associations where the reader holds POST_AS_ASSO among the page's. */
    publisherOf?: string[];
  }) {
    const query = jest.fn((sql: string) => {
      if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
      if (sql.includes('FROM post_republications pr')) {
        return Promise.resolve(
          (opts.republishers ?? []).map((id) => ({
            postId: opts.post.id,
            id,
            name: id.toUpperCase(),
            slug: id,
            logoUrl: null,
          }))
        );
      }
      if (sql.includes('JOIN associations a ON a.id = am."associationId"')) {
        return Promise.resolve(
          (opts.republishAs ?? []).map((associationId) => ({ associationId }))
        );
      }
      return Promise.resolve([]);
    });
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(opts.post)),
      manager: { query },
    };
    const associations = {
      mayActOnAny: jest.fn((_u: string, ids: string[]) =>
        Promise.resolve(new Set(ids.filter((id) => (opts.publisherOf ?? []).includes(id))))
      ),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    };
    return new PostsService(
      postRepo as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
  }

  const assoPost = {
    id: 'p1',
    authorId: 'officer',
    associationId: A1,
    markdown: 'Gala',
    hiddenByModeration: false,
    kind: 'post',
  } as Partial<Post>;

  it('names the republishers, oldest first, on an association post', async () => {
    const service = makeService({ post: assoPost, republishers: [A2, 'asso-3'] });
    const shaped = await service.getById('p1', { viewerId: 'reader' });
    expect(shaped.republishedBy).toEqual([
      { id: A2, name: 'ASSO-2', slug: A2, logoUrl: null },
      { id: 'asso-3', name: 'ASSO-3', slug: 'asso-3', logoUrl: null },
    ]);
  });

  it('offers "Republier" to a reader who may publish as ANOTHER association', async () => {
    const service = makeService({ post: assoPost, republishAs: [A2] });
    expect(await service.getById('p1', { viewerId: 'reader' })).toMatchObject({
      canRepublish: true,
      canProposeRepublication: false,
    });
  });

  it('does not offer it for the post own association, nor once every candidate did it', async () => {
    const own = makeService({ post: assoPost, republishAs: [A1] });
    expect((await own.getById('p1', { viewerId: 'reader' })).canRepublish).toBe(false);
    const done = makeService({ post: assoPost, republishAs: [A2], republishers: [A2] });
    expect((await done.getById('p1', { viewerId: 'reader' })).canRepublish).toBe(false);
  });

  it('lets a reader withdraw only the republications of associations they publish as', async () => {
    const service = makeService({
      post: assoPost,
      republishAs: [A2],
      republishers: [A2, 'asso-3'],
    });
    expect((await service.getById('p1', { viewerId: 'reader' })).canUnrepublishAs).toEqual([A2]);
  });

  it('offers the proposal to the post own publishers', async () => {
    const service = makeService({ post: assoPost, publisherOf: [A1] });
    expect((await service.getById('p1', { viewerId: 'officer' })).canProposeRepublication).toBe(
      true
    );
  });

  it('offers neither on a personal post, which is never republished', async () => {
    const personal = { ...assoPost, associationId: null } as unknown as Partial<Post>;
    const service = makeService({ post: personal, republishAs: [A2], publisherOf: [A1] });
    const shaped = await service.getById('p1', { viewerId: 'officer' });
    expect(shaped).toMatchObject({ canRepublish: false, canProposeRepublication: false });
    expect(shaped.republishedBy).toBeUndefined();
  });

  it('offers neither to an anonymous reader', async () => {
    const service = makeService({ post: assoPost, republishAs: [A2] });
    expect(await service.getById('p1', {})).toMatchObject({
      canRepublish: false,
      canProposeRepublication: false,
    });
  });
});
