import { describe, expect, it, vi } from 'vitest';
import type { PostComment } from './api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `user ${id}`,
}));

import {
  commentAuthorHref,
  commentAuthorKind,
  commentAuthorName,
  commentRevealedAuthorId,
} from './commentAuthor';

const base: PostComment = {
  id: 'c',
  text: 't',
  likes: [],
  createdAt: '2026-10-21T00:00:00Z',
};
const card = { id: 'a1', name: 'BDE', slug: 'bde club', logoUrl: null };

describe('commentAuthorKind', () => {
  it('reads an association before an anonymous flag, as the server resolves them', () => {
    expect(commentAuthorKind({ association: card, anonymous: true })).toBe('association');
    expect(commentAuthorKind({ anonymous: true })).toBe('anonymous');
    expect(commentAuthorKind({})).toBe('personal');
  });
});

describe('commentAuthorName', () => {
  it('names a personal author first and last, then by display name, then by id', () => {
    expect(
      commentAuthorName({ ...base, userId: 'u', firstName: 'Ada', lastName: 'Lovelace' })
    ).toBe('Ada Lovelace');
    expect(commentAuthorName({ ...base, userId: 'u', displayName: ' Ada L ' })).toBe('Ada L');
    expect(commentAuthorName({ ...base, userId: 'u' })).toBe('user u');
  });

  it('names an association by its card and an anonymous comment by nothing personal', () => {
    expect(commentAuthorName({ ...base, association: card })).toBe('BDE');
    expect(commentAuthorName({ ...base, anonymous: true, firstName: 'Leak' })).toBe('Anonyme');
    expect(commentAuthorName({ ...base, anonymous: true, userId: 'u1' })).toBe('Anonyme');
  });

  it('says so when an anonymous comment was written by the post author', () => {
    expect(commentAuthorName({ ...base, anonymous: true, byPostAuthor: true })).toBe(
      'Anonyme - auteur du post'
    );
  });
});

describe('commentAuthorHref', () => {
  it('links an association page and a profile, and nothing for an anonymous comment', () => {
    expect(commentAuthorHref({ ...base, association: card })).toBe('/associations/bde%20club');
    expect(commentAuthorHref({ ...base, userId: 'u 1' })).toBe('/profile/u%201');
    expect(commentAuthorHref({ ...base, anonymous: true, userId: 'u1' })).toBeNull();
  });

  it('never builds a profile link from a missing account', () => {
    expect(commentAuthorHref({ ...base })).toBeNull();
  });
});

describe('commentRevealedAuthorId', () => {
  it('is the writer of an anonymous comment when the server served the id, and nothing else', () => {
    // A moderator, an admin or the writer: the id was served, so the writer is named under "Anonyme".
    expect(commentRevealedAuthorId({ ...base, anonymous: true, userId: 'u1' })).toBe('u1');
    // Every other reader: the server withheld it, there is nobody to name.
    expect(commentRevealedAuthorId({ ...base, anonymous: true })).toBeNull();
    // Not anonymous: the name line already says who wrote it.
    expect(commentRevealedAuthorId({ ...base, userId: 'u1' })).toBeNull();
    expect(
      commentRevealedAuthorId({ ...base, association: card, anonymous: true, userId: 'u1' })
    ).toBeNull();
  });
});
