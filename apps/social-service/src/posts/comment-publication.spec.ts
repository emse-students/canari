import { ConflictException } from '@nestjs/common';
import { COMMENT_POST_NOT_PUBLISHED, assertPostAcceptsComments } from './comment-publication';

const NOW = new Date('2026-11-20T10:00:00Z');

describe('assertPostAcceptsComments', () => {
  it('refuses a post published in the future with a typed code', () => {
    const post = { id: 'aaaaaaaa-1', publishedAt: new Date('2026-11-21T10:00:00Z') };
    let caught: unknown;
    try {
      assertPostAcceptsComments(post, NOW);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: COMMENT_POST_NOT_PUBLISHED,
    });
  });

  it('accepts a post published now, in the past, or without a date', () => {
    expect(() => assertPostAcceptsComments({ id: 'a', publishedAt: NOW }, NOW)).not.toThrow();
    expect(() =>
      assertPostAcceptsComments({ id: 'a', publishedAt: '2026-01-01T00:00:00Z' }, NOW)
    ).not.toThrow();
    expect(() => assertPostAcceptsComments({ id: 'a' }, NOW)).not.toThrow();
  });
});
