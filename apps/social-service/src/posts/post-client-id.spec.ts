import { ConflictException } from '@nestjs/common';
import { clientIdVerdict } from './post-client-id';

describe('clientIdVerdict - a resend of a queued post is one post', () => {
  it('creates when no row holds the id', () => {
    expect(clientIdVerdict(null, 'alice')).toBe('create');
  });

  it("replays the author's own row, so the second request makes no second post", () => {
    expect(clientIdVerdict({ authorId: 'alice' }, 'alice')).toBe('replay');
  });

  it("refuses (409) an id that names another author's post", () => {
    expect(() => clientIdVerdict({ authorId: 'bob' }, 'alice')).toThrow(ConflictException);
  });
});
