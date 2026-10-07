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
    const interactions = {
      votePoll: jest.fn(),
      addReaction: jest.fn(),
      addComment: jest.fn(),
      likeComment: jest.fn(),
    };
    const associations = { findCalendarEventByLinkedPost: jest.fn() };
    const controller = new PostsController(
      { assertVisible } as never,
      interactions as never,
      {} as never,
      associations as never,
      {} as never,
      { isUserMuted: jest.fn(() => Promise.resolve(false)) } as never
    );
    return { controller, assertVisible, interactions, associations };
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
    ['addComment', (c: PostsController) => c.addComment('reader', POST, { text: 'x' } as never)],
    ['likeComment', (c: PostsController) => c.likeComment('reader', POST, 'comment')],
  ] as const)('%s answers 404 and writes nothing', async (name, call) => {
    const { controller, assertVisible, interactions } = make();
    await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
    expect(assertVisible).toHaveBeenCalledWith(POST, 'reader');
    expect(interactions[name]).not.toHaveBeenCalled();
  });

  it("the post's calendar link answers 404 without reading the event", async () => {
    const { controller, associations } = make();
    await expect(controller.getPostCalendarLink(POST, 'reader')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(associations.findCalendarEventByLinkedPost).not.toHaveBeenCalled();
  });
});
