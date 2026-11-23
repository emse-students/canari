import { ForbiddenException } from '@nestjs/common';
import { PostsController } from './posts.controller';

/**
 * THE MUTE COVERS A POLL VOTE AND A COMMENT LIKE (moderation-authority, decision 9).
 *
 * Driven through the real controller: a muted caller is refused before the post is even looked at,
 * an unmuted one reaches the write.
 */
describe('PostsController - the mute covers votes and comment likes', () => {
  function make(muted: boolean) {
    const service = {
      assertMayVote: jest.fn(() => Promise.resolve()),
      assertVisible: jest.fn(() => Promise.resolve({})),
      serveToReader: jest.fn((p: unknown) => Promise.resolve(p)),
    };
    const interactions = {
      votePoll: jest.fn(() => Promise.resolve({ id: 'p' })),
      likeComment: jest.fn(() => Promise.resolve({ ok: true })),
    };
    const controller = new PostsController(
      service as never,
      interactions as never,
      {} as never,
      {} as never,
      { isUserMuted: jest.fn(() => Promise.resolve(muted)) } as never
    );
    return { controller, service, interactions };
  }

  const routes = [
    [
      'votePoll',
      'assertMayVote',
      (c: PostsController) => c.votePoll('u', 'post', 'poll', {} as never),
    ],
    [
      'likeComment',
      'assertVisible',
      (c: PostsController) => c.likeComment('u', undefined, 'post', 'c1'),
    ],
  ] as const;

  describe.each(routes)('%s', (name, gate, call) => {
    it('refuses a muted caller before any read or write', async () => {
      const { controller, service, interactions } = make(true);
      await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
      expect(service[gate]).not.toHaveBeenCalled();
      expect(interactions[name]).not.toHaveBeenCalled();
    });

    it('lets an unmuted caller through', async () => {
      const { controller, interactions } = make(false);
      await expect(call(controller)).resolves.toBeDefined();
      expect(interactions[name]).toHaveBeenCalled();
    });
  });
});
