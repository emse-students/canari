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
    /** The reader sees the post ONLY through a nominative read grant. */
    grantOnly?: boolean;
    /** The reader sees the post ONLY through a member's repost (WP-F6): grant-free, not first-hand. */
    repostOnly?: boolean;
    /** D38b: among `republishAs`, the associations of the kind that may ask an author. */
    personalAs?: string[];
    /** D38b: the server's requestable predicate holds for the post. */
    requestable?: boolean;
    /** D38b: the standing requests of the reader's associations for the post. */
    standing?: { fromAssociationId: string; associationName: string; id: string; status: string }[];
  }) {
    const query = jest.fn((sql: string) => {
      if (sql.startsWith('SELECT posts.id AS "requestableId"')) {
        return Promise.resolve(opts.requestable ? [{ requestableId: opts.post.id }] : []);
      }
      if (sql.includes('FROM proposals')) {
        return Promise.resolve(
          (opts.standing ?? []).map((s) => ({ ...s, subjectId: opts.post.id }))
        );
      }
      if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
      if (sql.startsWith('SELECT posts.id,') && sql.includes('AS "firstHand"')) {
        // The grant-free predicate: a grant-only post is absent from the answer; a post seen only
        // through a member repost is present, and not first-hand.
        return Promise.resolve(
          opts.grantOnly ? [] : [{ id: opts.post.id, firstHand: !opts.repostOnly }]
        );
      }
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
          [...new Set([...(opts.republishAs ?? []), ...(opts.personalAs ?? [])])].map(
            (associationId) => ({
              associationId,
              type: (opts.personalAs ?? []).includes(associationId) ? 'association' : 'institution',
              archived: false,
            })
          )
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

  it('offers neither "Republier" nor a vote on a post only a read grant shows', async () => {
    const service = makeService({ post: assoPost, republishAs: [A2], grantOnly: true });
    expect(await service.getById('p1', { viewerId: 'grantee' })).toMatchObject({
      canRepublish: false,
      canVote: false,
    });
  });

  it('NO CHAIN (WP-F6): offers no "Republier" on a post only a member repost shows, and still the vote', async () => {
    const service = makeService({ post: assoPost, republishAs: [A2], repostOnly: true });
    expect(await service.getById('p1', { viewerId: 'follower' })).toMatchObject({
      canRepublish: false,
      canVote: true,
    });
  });

  it('offers the vote to a reader who sees the post without a grant', async () => {
    const service = makeService({ post: assoPost });
    expect((await service.getById('p1', { viewerId: 'reader' })).canVote).toBe(true);
  });

  it('offers no vote to an anonymous reader', async () => {
    const service = makeService({ post: assoPost });
    expect((await service.getById('p1', {})).canVote).toBe(false);
  });

  it('offers neither on a personal post, which is never republished at once (D38b asks)', async () => {
    const personal = { ...assoPost, associationId: null } as unknown as Partial<Post>;
    const service = makeService({ post: personal, republishAs: [A2], publisherOf: [A1] });
    const shaped = await service.getById('p1', { viewerId: 'officer' });
    expect(shaped).toMatchObject({ canRepublish: false, canProposeRepublication: false });
    // Stamped like any post: an author may have let associations carry it.
    expect(shaped.republishedBy).toEqual([]);
  });

  describe('D38b: asking the author of a personal post', () => {
    const personalPost = {
      ...assoPost,
      authorId: 'author',
      associationId: null,
    } as unknown as Partial<Post>;

    it('offers the request when the server predicate holds and an association may still ask', async () => {
      const service = makeService({ post: personalPost, personalAs: [A2], requestable: true });
      expect(await service.getById('p1', { viewerId: 'reader' })).toMatchObject({
        canRequestRepublication: true,
        republicationRequests: [],
      });
    });

    it('does not offer it when the predicate fails (anonymous, blocked, unseen, own post)', async () => {
      const service = makeService({ post: personalPost, personalAs: [A2], requestable: false });
      expect((await service.getById('p1', { viewerId: 'reader' })).canRequestRepublication).toBe(
        false
      );
    });

    it('never offers it in the name of an association of a kind that may not ask', async () => {
      // A2 is an institution here: it republishes association posts, never a person's.
      const service = makeService({ post: personalPost, republishAs: [A2], requestable: true });
      expect((await service.getById('p1', { viewerId: 'reader' })).canRequestRepublication).toBe(
        false
      );
    });

    it('serves the pending and refused requests, and stops offering once every association asked', async () => {
      const service = makeService({
        post: personalPost,
        personalAs: [A2, 'asso-3'],
        requestable: true,
        standing: [
          { fromAssociationId: A2, associationName: 'ASSO-2', id: 'prop-1', status: 'pending' },
          {
            fromAssociationId: 'asso-3',
            associationName: 'ASSO-3',
            id: 'prop-2',
            status: 'refused',
          },
        ],
      });
      expect(await service.getById('p1', { viewerId: 'reader' })).toMatchObject({
        canRequestRepublication: false,
        republicationRequests: [
          { associationId: A2, associationName: 'ASSO-2', proposalId: 'prop-1', status: 'pending' },
          { associationId: 'asso-3', proposalId: 'prop-2', status: 'refused' },
        ],
      });
    });

    it('lets the AUTHOR withdraw every republication of their personal post', async () => {
      const service = makeService({ post: personalPost, republishers: [A2, 'asso-3'] });
      expect((await service.getById('p1', { viewerId: 'author' })).canUnrepublishAs).toEqual([
        A2,
        'asso-3',
      ]);
    });
  });

  it('offers neither to an anonymous reader', async () => {
    const service = makeService({ post: assoPost, republishAs: [A2] });
    expect(await service.getById('p1', {})).toMatchObject({
      canRepublish: false,
      canProposeRepublication: false,
    });
  });
});
