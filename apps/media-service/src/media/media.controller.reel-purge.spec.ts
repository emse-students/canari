/// <reference types="jest" />

/**
 * `POST media/internal/reel-purge` REQUIRES its reason (reels-in-chat 15.4): `moderation` purges a
 * shared file with every hold, `author` and `retention` release the post's hold alone. A body that
 * forgot the reason must get neither by default - it is a 400, and the service is never reached.
 * `POST media/internal/chat-reel-purge` forwards the salon moderator's items as they came.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaController } from './media.controller';
import type { MediaService } from './media.service';

const SECRET = 'reel-purge-secret';
const ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

function build() {
  const svc = {
    purgeReels: jest.fn(async () => ({ [ID]: 'released' })),
    purgeChatReels: jest.fn(async () => ({ [ID]: 'deleted' })),
  };
  const controller = new MediaController(svc as unknown as MediaService, {} as never, {} as never);
  return { controller, svc };
}

const prev = process.env.INTERNAL_SECRET;
beforeAll(() => {
  process.env.INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (prev === undefined) delete process.env.INTERNAL_SECRET;
  else process.env.INTERNAL_SECRET = prev;
});

describe('POST media/internal/reel-purge', () => {
  it('passes the named reason through and answers the outcomes', async () => {
    const { controller, svc } = build();
    const items = [{ mediaId: ID, ownerId: 'alice' }];
    await expect(controller.purgeReels({ items, reason: 'author' }, SECRET)).resolves.toEqual({
      results: { [ID]: 'released' },
    });
    expect(svc.purgeReels).toHaveBeenCalledWith(items, 'author');
  });

  it.each([undefined, '', 'purge', 'MODERATION'])(
    'refuses a body whose reason is %p, before touching anything',
    async (reason) => {
      const { controller, svc } = build();
      await expect(
        controller.purgeReels({ items: [{ mediaId: ID, ownerId: 'alice' }], reason }, SECRET)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.purgeReels).not.toHaveBeenCalled();
    }
  );
});

describe('POST media/internal/chat-reel-purge', () => {
  it('forwards the items and answers the outcomes', async () => {
    const { controller, svc } = build();
    const items = [{ mediaId: ID, ownerId: 'alice' }];
    await expect(controller.purgeChatReels({ items }, SECRET)).resolves.toEqual({
      results: { [ID]: 'deleted' },
    });
    expect(svc.purgeChatReels).toHaveBeenCalledWith(items);
  });

  it('refuses a malformed body', async () => {
    const { controller, svc } = build();
    await expect(
      controller.purgeChatReels({ items: [{ mediaId: ID }] }, SECRET)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.purgeChatReels).not.toHaveBeenCalled();
  });
});
