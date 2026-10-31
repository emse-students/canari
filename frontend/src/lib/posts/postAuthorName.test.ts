/**
 * Where a publisher links, shared by the post header and the reel viewer's overlay: the association
 * for an association post, the profile otherwise, nowhere when the identity is hidden from the reader.
 */
import { expect, it } from 'vitest';
import {
  postAuthorHref,
  postAuthorLinkLabel,
  postAuthorName,
  revealedPostAuthor,
} from './postAuthorName';
import { m } from '$lib/paraglide/messages';

const association = { id: 'a1', name: 'BDE', slug: 'b d e', logoUrl: null };

it('an association post links its association', () => {
  const post = { association, anonymous: false, authorId: 'u1' } as never;
  expect(postAuthorHref(post)).toBe('/associations/b%20d%20e');
  expect(postAuthorLinkLabel(post)).toBe(m.post_view_association_label({ name: 'BDE' }));
});

it('a member post links the profile', () => {
  const post = { anonymous: false, authorId: 'u/1', authorFirstName: 'Ada', authorLastName: 'L' };
  expect(postAuthorHref(post as never)).toBe('/profile/u%2F1');
  expect(postAuthorLinkLabel(post as never)).toBe(m.post_view_profile_label({ name: 'Ada L' }));
});

it('an anonymous post is named "Anonyme" and links nowhere, whoever reads it', () => {
  expect(postAuthorHref({ anonymous: true } as never)).toBeNull();
  expect(postAuthorHref({ anonymous: true, authorId: 'u1' } as never)).toBeNull();
  expect(postAuthorName({ anonymous: true } as never)).toBe(m.post_anonymous_label());
  expect(postAuthorName({ anonymous: true, authorId: 'u1', authorFirstName: 'Ada' } as never)).toBe(
    m.post_anonymous_label()
  );
});

it('reveals the author of an anonymous post only when the server sent its id', () => {
  expect(revealedPostAuthor({ anonymous: true } as never)).toBeNull();
  expect(
    revealedPostAuthor({
      anonymous: true,
      authorId: 'u1',
      authorFirstName: 'Ada',
      authorLastName: 'L',
    } as never)
  ).toEqual({ userId: 'u1', name: 'Ada L' });
  // Nothing to reveal on a post that is not anonymous, nor on an association's.
  expect(revealedPostAuthor({ authorId: 'u1', authorFirstName: 'Ada' } as never)).toBeNull();
  expect(revealedPostAuthor({ association, anonymous: true, authorId: 'u1' } as never)).toBeNull();
});
