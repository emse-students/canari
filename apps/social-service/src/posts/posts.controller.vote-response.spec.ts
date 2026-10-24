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
 * A POLL VOTE ANSWERS WITH THE POST AS ITS VOTER MAY SEE IT, NEVER WITH THE STORED ROW.
 *
 * Every single-post response is shaped per reader (`PostsService.serveToReader`): what the stored
 * row carries and a reader may not know is withheld there. These drive the REAL controller route
 * and the REAL service shaping over a stored row holding everything that must be withheld, so the
 * assertion is on the response itself, per kind of reader.
 */
describe('PostsController.votePoll answers per reader', () => {
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
      createdAt: new Date('2026-10-01T00:00:00Z'),
    } as unknown as Post;
  }

  /** The association post variant: its publisher is withheld from everyone. */
  function storedAssociationPost(): Post {
    return {
      ...storedAnonymousPost(),
      anonymous: false,
      associationId: ASSO,
      authorId: OFFICER,
    } as unknown as Post;
  }

  function make(stored: Post, blockedPairs: Record<string, string[]> = {}) {
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
    const service = new PostsService(
      { manager: { query } } as unknown as Repository<Post>,
      {} as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      {} as PostNotificationsService,
      {} as PostMediaRetentionService
    );
    jest.spyOn(service, 'assertVisible').mockResolvedValue(undefined as never);
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
    return { vote };
  }

  const commentById = (res: Record<string, any>, id: string) =>
    (res.comments as Record<string, any>[]).find((c) => c.id === id);

  it('withholds the author, the masked commenters and the voter list from an ordinary member', async () => {
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
    expect('voters' in res.polls[0]).toBe(false);
  });

  it('drops the comments of an account blocked either way', async () => {
    const { vote } = make(storedAnonymousPost(), { [READER]: [BLOCKED] });
    const res = await vote(READER);

    expect(commentById(res, 'c3')).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
    expect(commentById(res, 'c4')?.userId).toBe('friend-1');
  });

  it('withholds the publisher of an association post from an ordinary member', async () => {
    const { vote } = make(storedAssociationPost());
    const res = await vote(READER);

    expect(res.authorId).toBeUndefined();
    expect(res.association).toEqual({ id: ASSO, name: 'BDE', slug: 'bde', logoUrl: null });
    expect(JSON.stringify(res)).not.toContain(OFFICER);
  });

  it("gives the post's own author their id back, and nobody else's", async () => {
    const { vote } = make(storedAnonymousPost());
    const res = await vote(AUTHOR);

    expect(res.authorId).toBe(AUTHOR);
    expect(commentById(res, 'c1')?.userId).toBeUndefined();
  });

  it('gives a content moderator the author and every masked commenter', async () => {
    const { vote } = make(storedAnonymousPost());
    const res = await vote(MODERATOR);

    expect(res.authorId).toBe(AUTHOR);
    expect(res.authorDisplayName).toBe('Real Name');
    expect(commentById(res, 'c1')?.userId).toBe(ANON_COMMENTER);
    expect(commentById(res, 'c2')?.userId).toBe(OFFICER);
  });

  it('gives a platform admin the author and every masked commenter', async () => {
    const { vote } = make(storedAnonymousPost());
    const res = await vote(ADMIN, true);

    expect(res.authorId).toBe(AUTHOR);
    expect(commentById(res, 'c1')?.userId).toBe(ANON_COMMENTER);
    expect(commentById(res, 'c2')?.userId).toBe(OFFICER);
  });
});
