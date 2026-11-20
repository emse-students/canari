import { ConflictException } from '@nestjs/common';
import { COMMENT_POST_NOT_PUBLISHED, refuseUnpublishedPost } from './comment-publication';

describe('refuseUnpublishedPost', () => {
  it('throws a 409 carrying the typed code', () => {
    let caught: unknown;
    try {
      refuseUnpublishedPost('aaaaaaaa-1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: COMMENT_POST_NOT_PUBLISHED,
    });
  });
});
