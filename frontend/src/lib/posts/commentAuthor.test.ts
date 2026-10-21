import { describe, expect, it, vi } from 'vitest';
import type { PostComment } from './api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `user ${id}`,
}));

import { commentAuthorHref, commentAuthorKind, commentAuthorName } from './commentAuthor';

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
