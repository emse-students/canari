import { NotFoundException } from '@nestjs/common';
import { PostsController } from './posts.controller';

/**
 * AN ID IS NOT A PERMISSION (WP6b): every route that reads a post, or ADDS to one, asks the per-post
 * visibility first and answers its 404 - so a reader outside a post's audience can neither open it
 * nor vote, react, comment or like on it with an id lifted from a link. Who is visible is proven in
 * `reader-spaces.integration.spec.ts`; this pins that the routes ask, and ask about the caller.
 */
describe('PostsController - the routes ask the per-post visibility first', () => {
  const POST = '00000000-0000-4000-8000-000000000001';

  function make() {
    const assertVisible = jest.fn(() => Promise.reject(new NotFoundException('Post not found')));
    // The vote asks the whole open-the-post gate, whose visibility half is `assertVisible`.
    const assertMayVote = jest.fn(() => Promise.reject(new NotFoundException('Post not found')));
    const interactions = {
      votePoll: jest.fn(),
      addReaction: jest.fn(),
      addComment: jest.fn(),
      likeComment: jest.fn(),
    };
    const associations = { findCalendarEventByLinkedPost: jest.fn() };
    const controller = new PostsController(
      { assertVisible, assertMayVote } as never,
      interactions as never,
      {} as never,
      associations as never,
      { isUserMuted: jest.fn(() => Promise.resolve(false)) } as never
    );
    return { controller, assertVisible, assertMayVote, interactions, associations };
  }

  it.each([
    [
      'votePoll',
      (c: PostsController) => c.votePoll('reader', POST, 'poll', { optionIds: [] } as never),
    ],
    [
      'addReaction',
      (c: PostsController) => c.addReaction('reader', POST, { reactionType: 'like' } as never),
    ],
    [
      'addComment',
      (c: PostsController) => c.addComment('reader', undefined, POST, { text: 'x' } as never),
    ],
    ['likeComment', (c: PostsController) => c.likeComment('reader', undefined, POST, 'comment')],
  ] as const)('%s answers 404 and writes nothing', async (name, call) => {
    const { controller, assertVisible, assertMayVote, interactions } = make();
    await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
    const [gate, args] =
      name === 'votePoll'
        ? [assertMayVote, [POST, 'reader']]
        : name === 'addReaction'
          ? [assertVisible, [POST, 'reader', 'READ_OR_REACT']]
          : // A comment and a comment like ask the comments' gate (owner, 2026-11-04).
            [assertVisible, [POST, 'reader', 'COMMENT']];
    expect(gate).toHaveBeenCalledWith(...args);
    expect(interactions[name]).not.toHaveBeenCalled();
  });

  it('a reaction, added or taken back, answers with the reactions served to its reader', async () => {
    // The stored map names who reacted: both routes hand it to `serveReactionsTo` (owner,
    // 2026-11-04), the removal included, which is not gated and must not list reactors to an id.
    const stored = { ok: true, reactions: { me: 'like', other: 'love' } };
    const served = { ok: true, reactions: { me: 'like' }, otherReactionCounts: { love: 1 } };
    const serveReactionsTo = jest.fn(() => Promise.resolve(served));
    const interactions = {
      addReaction: jest.fn(() => Promise.resolve(stored)),
      removeReaction: jest.fn(() => Promise.resolve(stored)),
    };
    const controller = new PostsController(
      { assertVisible: jest.fn(() => Promise.resolve({ post: {} })), serveReactionsTo } as never,
      interactions as never,
      {} as never,
      {} as never,
      { isUserMuted: jest.fn(() => Promise.resolve(false)) } as never
    );
    await expect(
      controller.addReaction('me', POST, { reactionType: 'like' } as never)
    ).resolves.toBe(served);
    await expect(controller.removeReaction('me', POST)).resolves.toBe(served);
    expect(serveReactionsTo).toHaveBeenNthCalledWith(1, POST, 'me', stored);
    expect(serveReactionsTo).toHaveBeenNthCalledWith(2, POST, 'me', stored);
  });

  it("the post's calendar link answers 404 without reading the event", async () => {
    const { controller, associations } = make();
    await expect(controller.getPostCalendarLink(POST, 'reader')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(associations.findCalendarEventByLinkedPost).not.toHaveBeenCalled();
  });
});
