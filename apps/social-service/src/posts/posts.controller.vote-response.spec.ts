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
 * THE VOTE ROUTE OPENS A POST THE WAY A READ DOES, AND SERVES IT THE WAY A READ DOES.
 *
 * It goes through `getById`'s gate (`assertMayVote` -> `assertOpenable`) and answers through
 * `serveToReader`, like every route answering with one post. These drive the REAL controller route
 * and the REAL service over a stored row, so each assertion is on what the route itself answers.
 */
describe('PostsController.votePoll', () => {
  const POST_ID = '00000000-0000-4000-8000-0000000000aa';
  const AUTHOR = 'author-1';
  const ANON_COMMENTER = 'anon-commenter';
  const OFFICER = 'asso-officer';
  const BLOCKED = 'blocked-user';
  const READER = 'reader-1';
  const MODERATOR = 'mod-1';
  const ADMIN = 'admin-1';
  const ASSO = '00000000-0000-4000-8000-0000000000bb';

  /** A stored anonymous post: an anonymous poll, and comments of every identity kind. */
  function storedAnonymousPost(): Post {
    return {
      id: POST_ID,
      authorId: AUTHOR,
      anonymous: true,
      associationId: null,
      markdown: 'question',
      mentions: [],
      links: [],
      media: [],
      polls: [
        {
          id: 'poll-1',
          anonymous: true,
          multipleChoice: false,
          options: [{ id: 'a', label: 'A', votes: 2 }],
          voters: [READER, AUTHOR],
          votesByUser: {},
        },
      ],
      reactions: {},
      comments: [
        { id: 'c1', userId: ANON_COMMENTER, anonymous: true, text: 'masked' },
        { id: 'c2', userId: OFFICER, associationId: ASSO, text: 'as the association' },
        { id: 'c3', userId: BLOCKED, text: 'from a blocked account' },
        { id: 'c4', userId: 'friend-1', text: 'plain' },
      ],
      hiddenByModeration: false,
      pinned: false,
      scheduledAt: null,
      kind: 'post',
      expiresAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    } as unknown as Post;
  }

  /** The association post variant. */
  function storedAssociationPost(): Post {
    return {
      ...storedAnonymousPost(),
      anonymous: false,
      associationId: ASSO,
      authorId: OFFICER,
    } as unknown as Post;
  }

  /** A plain personal post, with `overrides` for the gate's cases. */
  function storedPersonalPost(overrides: Record<string, unknown> = {}): Post {
    return { ...storedAnonymousPost(), anonymous: false, ...overrides } as unknown as Post;
  }

  /**
   * `blockedPairs[viewer]` is what the symmetric `user_blocks` read answers for that viewer (it
   * already unions both directions, so one list states a block either way).
   */
  function make(
    stored: Post,
    blockedPairs: Record<string, string[]> = {},
    visible: () => Promise<void> = () => Promise.resolve()
  ) {
    const query = jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM user_blocks')) {
        const viewer = (params ?? [])[0] as string;
        return Promise.resolve((blockedPairs[viewer] ?? []).map((otherId) => ({ otherId })));
      }
      if (sql.includes('FROM associations')) {
        return Promise.resolve([{ id: ASSO, name: 'BDE', slug: 'bde', logoUrl: null }]);
      }
      if (sql.includes('FROM users WHERE id = $1')) {
        return Promise.resolve([{ displayName: 'Real Name', firstName: 'Real', lastName: 'Name' }]);
      }
      return Promise.resolve([]);
    });
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn((id: string) => Promise.resolve(id === MODERATOR)),
    };
    const postRepo = {
      manager: { query },
      findOne: jest.fn(() => Promise.resolve(stored)),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
    // The audience SQL is proven in `reader-spaces.integration.spec.ts`; here it is a switch.
    const assertVisible = jest.spyOn(service, 'assertVisible').mockImplementation(visible);
    const interactions = { votePoll: jest.fn(() => Promise.resolve(stored)) };
    const controller = new PostsController(
      service,
      interactions as never,
      {} as never,
      {} as never,
      {} as never,
      { isUserMuted: jest.fn(() => Promise.resolve(false)) } as never
    );
    const vote = (viewer: string, admin = false) =>
      controller.votePoll(
        viewer,
        POST_ID,
        'poll-1',
        { optionIds: ['a'] } as never,
        admin ? 'true' : undefined
      ) as Promise<Record<string, any>>;
    return { vote, interactions, assertVisible };
  }

  const commentById = (res: Record<string, any>, id: string) =>
    (res.comments as Record<string, any>[]).find((c) => c.id === id);

  describe('serves the post per reader', () => {
    it('member: anonymous post', async () => {
      const { vote } = make(storedAnonymousPost(), { [READER]: [BLOCKED] });
      const res = await vote(READER);
      const wire = JSON.stringify(res);

      expect(res.authorId).toBeUndefined();
      expect(res.authorDisplayName).toBeUndefined();
      expect(wire).not.toContain(AUTHOR);
      expect(commentById(res, 'c1')).toBeDefined();
      expect(commentById(res, 'c1')?.userId).toBeUndefined();
      expect(commentById(res, 'c2')?.userId).toBeUndefined();
      expect(wire).not.toContain(ANON_COMMENTER);
      expect(wire).not.toContain(OFFICER);
      expect(res.polls[0].voted).toBe(true);
    });

    it('member: comments of a blocked account', async () => {
      const { vote } = make(storedAnonymousPost(), { [READER]: [BLOCKED] });
      const res = await vote(READER);

      expect(commentById(res, 'c3')).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain(BLOCKED);
      expect(commentById(res, 'c4')?.userId).toBe('friend-1');
    });

    it('member: association post', async () => {
      const { vote } = make(storedAssociationPost());
      const res = await vote(READER);

      expect(res.authorId).toBeUndefined();
      expect(res.association).toEqual({ id: ASSO, name: 'BDE', slug: 'bde', logoUrl: null });
      expect(JSON.stringify(res)).not.toContain(OFFICER);
    });

    it('author', async () => {
      const { vote } = make(storedAnonymousPost());
      const res = await vote(AUTHOR);

      expect(res.authorId).toBe(AUTHOR);
      expect(commentById(res, 'c1')?.userId).toBeUndefined();
    });

    it('moderator', async () => {
      const { vote } = make(storedAnonymousPost());
      const res = await vote(MODERATOR);

      expect(res.authorId).toBe(AUTHOR);
      expect(res.authorDisplayName).toBe('Real Name');
      expect(commentById(res, 'c1')?.userId).toBe(ANON_COMMENTER);
      expect(commentById(res, 'c2')?.userId).toBe(OFFICER);
    });

    it('admin', async () => {
      const { vote } = make(storedAnonymousPost());
      const res = await vote(ADMIN, true);

      expect(res.authorId).toBe(AUTHOR);
      expect(commentById(res, 'c1')?.userId).toBe(ANON_COMMENTER);
      expect(commentById(res, 'c2')?.userId).toBe(OFFICER);
    });
  });

  describe('refuses where getById refuses, before recording anything', () => {
    it('a post outside the voter audience (asked with the vote intent)', async () => {
      const { vote, interactions, assertVisible } = make(storedPersonalPost(), {}, () =>
        Promise.reject(new NotFoundException('Post not found'))
      );
      await expect(vote(READER)).rejects.toBeInstanceOf(NotFoundException);
      expect(assertVisible).toHaveBeenCalledWith(POST_ID, READER, 'VOTE');
      expect(interactions.votePoll).not.toHaveBeenCalled();
    });

    it('a post hidden by moderation, a platform admin included', async () => {
      const { vote, interactions } = make(storedPersonalPost({ hiddenByModeration: true }));
      await expect(vote(ADMIN, true)).rejects.toBeInstanceOf(ForbiddenException);
      expect(interactions.votePoll).not.toHaveBeenCalled();
    });

    it('a post scheduled later, to anyone but its author', async () => {
      const later = new Date(Date.now() + 86_400_000);
      const { vote, interactions } = make(storedPersonalPost({ scheduledAt: later }));
      await expect(vote(READER)).rejects.toBeInstanceOf(NotFoundException);
      expect(interactions.votePoll).not.toHaveBeenCalled();
      await expect(vote(AUTHOR)).resolves.toBeDefined();
    });

    it('a post whose author and voter are blocked either way', async () => {
      const { vote, interactions } = make(storedPersonalPost(), { [READER]: [AUTHOR] });
      await expect(vote(READER)).rejects.toBeInstanceOf(NotFoundException);
      expect(interactions.votePoll).not.toHaveBeenCalled();
    });

    it('an expired reel', async () => {
      const { vote, interactions } = make(
        storedPersonalPost({ kind: 'reel', expiresAt: new Date(Date.now() - 1000) })
      );
      await expect(vote(READER)).rejects.toBeInstanceOf(NotFoundException);
      expect(interactions.votePoll).not.toHaveBeenCalled();
    });
  });
});
