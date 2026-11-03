import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * THE WRITE ROUTES REFUSE WHAT THE READ REFUSES - driven through the REAL controller and the REAL
 * `PostsService` over a stored row, so each assertion is on what the route itself answers.
 *
 * A reaction, a comment, a comment like and the post's calendar link go through `assertVisible`,
 * which is `getById`'s gate (`readPostOpenVerdict`): a block either way with a personal post's
 * author, or a post scheduled later, is a 404 there as it is on the read, and nothing is written.
 * The audience term is proven against PostgreSQL in `post-openable.integration.spec.ts`; here it is
 * open, so what refuses is the term under test.
 */
describe('PostsController - the write routes ask the read gate', () => {
  const POST_ID = '00000000-0000-4000-8000-0000000000aa';
  const AUTHOR = 'author-1';
  const READER = 'reader-1';
  const ADMIN = 'admin-1';

  const stored = (overrides: Record<string, unknown> = {}): Post =>
    ({
      id: POST_ID,
      authorId: AUTHOR,
      anonymous: false,
      associationId: null,
      markdown: 'hello',
      mentions: [],
      reactions: {},
      comments: [{ id: 'c1', userId: 'friend', text: 'plain', likes: [] }],
      hiddenByModeration: false,
      scheduledAt: null,
      kind: 'post',
      expiresAt: null,
      polls: [],
      ...overrides,
    }) as unknown as Post;

  /** `blocks` is what the symmetric `user_blocks` read answers for the READER. */
  function make(post: Post, blocks: string[] = []) {
    const query = jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
      if (sql.includes('FROM user_blocks')) {
        const viewer = (params ?? [])[0];
        return Promise.resolve(viewer === READER ? blocks.map((otherId) => ({ otherId })) : []);
      }
      return Promise.resolve([]);
    });
    const postRepo = {
      manager: { query },
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      {
        isContentModerator: jest.fn(() => Promise.resolve(false)),
        mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      } as unknown as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
    // The writes themselves are `PostInteractionsService`'s; here they only must not be reached.
    const interactions = {
      addReaction: jest.fn(() => Promise.resolve({ ok: true })),
      addComment: jest.fn(() => Promise.resolve({ ok: true })),
      likeComment: jest.fn(() => Promise.resolve({ ok: true })),
    };
    const associations = {
      findCalendarEventByLinkedPost: jest.fn(() => Promise.resolve(null)),
      canPostAs: jest.fn(() => Promise.resolve(true)),
    };
    const controller = new PostsController(
      service,
      interactions as never,
      {} as never,
      associations as never,
      { isUserMuted: jest.fn(() => Promise.resolve(false)) } as never
    );
    return { controller, interactions, associations, postRepo };
  }

  const routes = [
    [
      'addReaction',
      (c: PostsController) => c.addReaction(READER, POST_ID, { reactionType: 'like' } as never),
    ],
    [
      'addComment',
      (c: PostsController) => c.addComment(READER, undefined, POST_ID, { text: 'x' } as never),
    ],
    ['likeComment', (c: PostsController) => c.likeComment(READER, undefined, POST_ID, 'c1')],
  ] as const;

  describe.each(routes)('%s', (name, call) => {
    it('writes for a reader the read opens the post to (the positive case)', async () => {
      const { controller, interactions } = make(stored());
      await expect(call(controller)).resolves.toBeDefined();
      expect(interactions[name]).toHaveBeenCalled();
    });

    it.each([
      ['the reader blocked the author, or was blocked by them', stored(), [AUTHOR]],
      ['scheduled later', stored({ scheduledAt: new Date(Date.now() + 86_400_000) }), []],
    ] as const)('404 on a post %s, writing nothing', async (_case, post, blocks) => {
      const { controller, interactions } = make(post, [...blocks]);
      await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
      expect(interactions[name]).not.toHaveBeenCalled();
    });

    it("403 on a post hidden by moderation, as the read answers - a platform admin's included", async () => {
      const { controller, interactions } = make(stored({ hiddenByModeration: true }));
      await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
      expect(interactions[name]).not.toHaveBeenCalled();
    });
  });

  it('a reaction reads the post once: the gate hands its row to the write', async () => {
    const post = stored();
    const { controller, interactions, postRepo } = make(post);
    await controller.addReaction(READER, POST_ID, { reactionType: 'like' } as never);
    expect(postRepo.findOne).toHaveBeenCalledTimes(1);
    expect(interactions.addReaction).toHaveBeenCalledWith(POST_ID, READER, 'like', post);
  });

  it.each([
    ['blocked', stored(), [AUTHOR]],
    ['scheduled later', stored({ scheduledAt: new Date(Date.now() + 86_400_000) }), []],
  ] as const)(
    'the calendar link of a %s post is a 404, the event never read',
    async (_case, post, blocks) => {
      const { controller, associations } = make(post, [...blocks]);
      await expect(controller.getPostCalendarLink(POST_ID, READER)).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(associations.findCalendarEventByLinkedPost).not.toHaveBeenCalled();
    }
  );

  describe('the comment page and `allowHidden`', () => {
    const list = (c: PostsController, viewer: string, admin: boolean) =>
      c.listComments(viewer, admin ? 'true' : undefined, POST_ID, {} as never);

    it('a platform admin reads the comments of a hidden post, as they read the post itself', async () => {
      const { controller } = make(stored({ hiddenByModeration: true }));
      await expect(list(controller, ADMIN, true)).resolves.toMatchObject({
        comments: [expect.objectContaining({ id: 'c1' })],
      });
    });

    it('anyone else meets the read 403 on a hidden post', async () => {
      const { controller } = make(stored({ hiddenByModeration: true }));
      await expect(list(controller, READER, false)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a block with the author is the read 404 there too', async () => {
      const { controller } = make(stored(), [AUTHOR]);
      await expect(list(controller, READER, false)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
