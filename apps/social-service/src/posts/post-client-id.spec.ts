import { ConflictException, GoneException } from '@nestjs/common';
import { clientIdVerdict } from './post-client-id';

describe('clientIdVerdict - a resend of a queued post is one post', () => {
  it('creates when no row holds the id and no deleted post did', () => {
    expect(clientIdVerdict(null, false, 'alice')).toBe('create');
  });

  it("replays the author's own row, so the second request makes no second post", () => {
    expect(clientIdVerdict({ authorId: 'alice' }, false, 'alice')).toBe('replay');
  });

  it("refuses (409) an id that names another author's post", () => {
    expect(() => clientIdVerdict({ authorId: 'bob' }, false, 'alice')).toThrow(ConflictException);
  });

  it('refuses (410) the id of a deleted post: a resend never brings it back', () => {
    expect(() => clientIdVerdict(null, true, 'alice')).toThrow(GoneException);
  });
});
