import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * EDITING A POST USED TO EMPTY ITS POLL, AND THE CODE SAID THE OPPOSITE.
 *
 * The edit form sends the poll's id back under a comment reading "preserved to maintain vote
 * history"; it preserved the id and nothing else. The tallies live in `option.votes` and
 * `votesByUser`, `updatePost` rebuilt each poll from the payload alone, and `whitelist: true`
 * strips any tally a client tries to send - so fixing one word of a question reset the poll to
 * zero, with the id intact to suggest nothing had been lost. Option ids were stripped too, so
 * even a payload carrying them could not have matched anything back up.
 *
 * What is pinned below is the matching rule: a vote was cast against an OPTION ID, so identity is
 * what decides whether it survives an edit - not position, and not the label.
 */
describe('PostsService keeps poll votes across an edit', () => {
  function makeService(stored: Record<string, unknown>[]) {
    const post = {
      id: 'post-1',
      authorId: 'author-1',
      associationId: null,
      markdown: 'avant',
      media: [],
      polls: stored,
      comments: [],
      reactions: {},
      mentions: [],
    } as unknown as Post;

    const postRepo = {
      findOne: () => Promise.resolve(post),
      save: (entity: Post) => Promise.resolve(entity),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {
        get: jest.fn(),
        setex: jest.fn(),
        // A stub missing this logs a `[CACHE] feed cache sweep failed` warning per test - a line
        // whose reader would learn to skip it, on the day it means something.
        deleteByPattern: jest.fn(() => Promise.resolve(0)),
      } as unknown as RedisService,
      {} as FollowsService,
      {} as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, post };
  }

  const STORED_POLL = () => ({
    id: 'poll-1',
    question: 'On y va ?',
    multipleChoice: false,
    maxSelections: null,
    endsAt: null,
    options: [
      { id: 'opt-a', label: 'Oui', votes: ['u1', 'u2'] },
      { id: 'opt-b', label: 'Non', votes: ['u3'] },
    ],
    votesByUser: { u1: ['opt-a'], u2: ['opt-a'], u3: ['opt-b'] },
  });

  it('keeps every vote when the question is corrected', async () => {
    const { service, post } = makeService([STORED_POLL()]);

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            id: 'poll-1',
            question: 'On y va vraiment ?',
            options: [
              { id: 'opt-a', label: 'Oui' },
              { id: 'opt-b', label: 'Non' },
            ],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(poll.question).toBe('On y va vraiment ?');
    expect(poll.options[0].votes).toEqual(['u1', 'u2']);
    expect(poll.options[1].votes).toEqual(['u3']);
    expect(poll.votesByUser).toEqual({ u1: ['opt-a'], u2: ['opt-a'], u3: ['opt-b'] });
  });

  it('keeps the votes of an option that was RENAMED, because the id is what was voted on', async () => {
    const { service, post } = makeService([STORED_POLL()]);

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            id: 'poll-1',
            question: 'On y va ?',
            options: [
              { id: 'opt-a', label: 'Oui, bien sur' },
              { id: 'opt-b', label: 'Non' },
            ],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(poll.options[0].label).toBe('Oui, bien sur');
    expect(poll.options[0].votes).toEqual(['u1', 'u2']);
  });

  it('drops the votes of an option the author deleted, and the voters with it', async () => {
    const { service, post } = makeService([STORED_POLL()]);

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            id: 'poll-1',
            question: 'On y va ?',
            options: [{ id: 'opt-a', label: 'Oui' }, { label: 'Peut-etre' }],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(poll.options[1].id).toBeTruthy();
    expect(poll.options[1].votes).toEqual([]);
    // u3 voted for the option that is gone, so u3 has no answer left - `votesByUser` is DERIVED
    // from the options rather than carried beside them, which is why it cannot disagree.
    expect(poll.votesByUser).toEqual({ u1: ['opt-a'], u2: ['opt-a'] });
  });

  it('starts a replacement poll empty, whatever ids it was handed', async () => {
    const { service, post } = makeService([STORED_POLL()]);

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            question: 'Autre chose ?',
            options: [
              { id: 'opt-a', label: 'Oui' },
              { id: 'opt-b', label: 'Non' },
            ],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(poll.id).not.toBe('poll-1');
    expect(poll.options.every((o: { votes: string[] }) => o.votes.length === 0)).toBe(true);
    expect(poll.votesByUser).toEqual({});
  });

  it('stores the cap and the deadline the composer sent', async () => {
    const { service, post } = makeService([]);
    const endsAt = new Date(Date.now() + 86_400_000).toISOString();

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            question: 'Deux parmi trois ?',
            multipleChoice: true,
            maxSelections: 2,
            endsAt,
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(poll.maxSelections).toBe(2);
    expect(poll.endsAt).toBe(endsAt);
  });

  it('drops a stored user id of a shape that must never become a property name', async () => {
    // `votePoll` has refused this shape only since 2026-09-23, so a poll written before it can
    // still carry one in its options - and rebuilding the map is where it would be handed on to
    // every reader of the poll.
    const stored = STORED_POLL();
    stored.options[0].votes = ['u1', '__proto__'];
    const { service, post } = makeService([stored]);

    await service.updatePost(
      'post-1',
      'author-1',
      {
        markdown: 'apres',
        polls: [
          {
            id: 'poll-1',
            question: 'On y va ?',
            options: [
              { id: 'opt-a', label: 'Oui' },
              { id: 'opt-b', label: 'Non' },
            ],
          },
        ],
      },
      true
    );

    const poll = (post.polls as Record<string, any>[])[0];
    expect(Object.keys(poll.votesByUser)).toEqual(['u1', 'u3']);
    expect(Object.getPrototypeOf(poll.votesByUser)).toBe(Object.prototype);
  });
});
