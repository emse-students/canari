import { m } from '$lib/paraglide/messages';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import type { PostEntity } from './api';

/**
 * The name a post is published under, as its header prints it and as the media viewer's
 * information panel names who sent a post's photo.
 *
 * The association's name for an association post; "Anonyme" when the identity is hidden (an
 * anonymous post whose `authorId` the server stripped for this reader); otherwise the author's
 * first and last name, their display name, or the id's cached display name. ONE implementation,
 * because the header and the viewer must never disagree about who published the same post.
 */
export function postAuthorName(
  post: Pick<
    PostEntity,
    | 'association'
    | 'anonymous'
    | 'authorId'
    | 'authorFirstName'
    | 'authorLastName'
    | 'authorDisplayName'
  >
): string {
  if (post.association) return post.association.name;
  if (post.anonymous && !post.authorId) return m.post_anonymous_label();
  const first = post.authorFirstName?.trim();
  const last = post.authorLastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (post.authorDisplayName?.trim()) return post.authorDisplayName.trim();
  return getUserDisplayNameSync(post.authorId ?? '');
}

/**
 * Where tapping a post's publisher leads, as the post header and the reel viewer's overlay link it:
 * the association's page for an association post, the author's profile otherwise, and NOWHERE when
 * the identity is hidden from this reader. ONE implementation, beside the name it links.
 *
 * `anonymous` alone does not hide: a moderator, a platform admin and the post's own author all
 * receive `authorId` on an anonymous post (server-side, `PostsService.mustHideAnonymousAuthor`) - a
 * user request, 2026-09-17, that these three see the real name and avatar. Only a regular reader
 * (no `authorId` on the payload) gets the hidden identity.
 */
export function postAuthorHref(
  post: Pick<PostEntity, 'association' | 'anonymous' | 'authorId'>
): string | null {
  if (post.association) return `/associations/${encodeURIComponent(post.association.slug)}`;
  if (post.anonymous && !post.authorId) return null;
  return `/profile/${encodeURIComponent(post.authorId ?? '')}`;
}

/** The accessible name of the link {@link postAuthorHref} gives: whose page it opens. */
export function postAuthorLinkLabel(post: Parameters<typeof postAuthorName>[0]): string {
  return post.association
    ? m.post_view_association_label({ name: post.association.name })
    : m.post_view_profile_label({ name: postAuthorName(post) });
}
