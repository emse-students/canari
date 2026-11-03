/// <reference types="jest" />

import { BadRequestException } from '@nestjs/common';
import type { ModerationService } from '../moderation/moderation.service';
import { MemberRepostsController, REPOSTER_ID_INVALID } from './member-reposts.controller';
import type { MemberRepostsService } from './member-reposts.service';

/**
 * The author's removal names a reposter in the URL: an id no user could have is a 400 before any
 * query (`PERSON_KEY`), and an id minted before the ASCII rule still reaches the service.
 */
describe('MemberRepostsController.removeRepost', () => {
  const removeRepostAsAuthor = jest.fn(async () => ({ ok: true as const }));
  const controller = new MemberRepostsController(
    { removeRepostAsAuthor } as unknown as MemberRepostsService,
    {} as ModerationService
  );
  const POST = '00000000-0000-4000-8000-000000000001';

  afterEach(() => removeRepostAsAuthor.mockClear());

  it.each([
    ['a control character', 'a\u0000b'],
    ['an overlong id', 'x'.repeat(256)],
  ])('refuses %s with a 400 REPOSTER_ID_INVALID, asking nothing', async (_label, id) => {
    let thrown: unknown;
    try {
      await controller.removeRepost('au', POST, id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: REPOSTER_ID_INVALID,
    });
    expect(removeRepostAsAuthor).not.toHaveBeenCalled();
  });

  it.each(['a1'.repeat(32), 'legacy:id'])('passes the id %s to the service', async (id) => {
    await expect(controller.removeRepost('au', POST, id)).resolves.toEqual({ ok: true });
    expect(removeRepostAsAuthor).toHaveBeenCalledWith(POST, 'au', id);
  });
});
