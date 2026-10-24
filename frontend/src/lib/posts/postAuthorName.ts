import { m } from '$lib/paraglide/messages';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import type { PostEntity } from './api';

/**
 * The name a post is published under, as its header prints it and as the media viewer's
 * information panel names who sent a post's photo.
 *
 * The association's name for an association post; "Anonyme" for an anonymous post, WHOEVER reads
 * it - a reader the server lets see the author gets that name as a second, smaller line
 * ({@link revealedPostAuthor}), never in place of "Anonyme" (user, 2026-10-24); otherwise the
 * author's first and last name, their display name, or the id's cached display name. ONE
 * implementation, because the header and the viewer must never disagree about who published the
 * same post.
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
  if (post.anonymous) return m.post_anonymous_label();
  return personalPostAuthorName(post);
}

/** The author's own name, from the row's name columns, then the id's cached display name. */
function personalPostAuthorName(
  post: Pick<PostEntity, 'authorId' | 'authorFirstName' | 'authorLastName' | 'authorDisplayName'>
): string {
  const first = post.authorFirstName?.trim();
  const last = post.authorLastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (post.authorDisplayName?.trim()) return post.authorDisplayName.trim();
  return getUserDisplayNameSync(post.authorId ?? '');
}

/**
 * WHO WROTE AN ANONYMOUS POST, for the one reader the server told: a moderator, a platform admin
 * and the post's own author receive `authorId` on an anonymous post (server-side,
 * `PostsService.mustHideAnonymousAuthor`; user, 2026-09-17), every other reader does not. `null`
 * for any other post, and for an anonymous one whose `authorId` was withheld - the client never
 * decides who may see an author, it draws what it was served.
 */
export function revealedPostAuthor(
  post: Pick<
    PostEntity,
    | 'association'
    | 'anonymous'
    | 'authorId'
    | 'authorFirstName'
    | 'authorLastName'
    | 'authorDisplayName'
  >
): { userId: string; name: string } | null {
  if (post.association || !post.anonymous || !post.authorId) return null;
  return { userId: post.authorId, name: personalPostAuthorName(post) };
}

/**
 * Where tapping a post's publisher leads, as the post header and the reel viewer's overlay link it:
 * the association's page for an association post, the author's profile otherwise, and NOWHERE for
 * an anonymous post - "Anonyme" is not a page. A reader who may see the author reaches the profile
 * from the smaller line under it ({@link revealedPostAuthor}). ONE implementation, beside the name
 * it links.
 */
export function postAuthorHref(
  post: Pick<PostEntity, 'association' | 'anonymous' | 'authorId'>
): string | null {
  if (post.association) return `/associations/${encodeURIComponent(post.association.slug)}`;
  if (post.anonymous) return null;
  return `/profile/${encodeURIComponent(post.authorId ?? '')}`;
}

/** The accessible name of the link {@link postAuthorHref} gives: whose page it opens. */
export function postAuthorLinkLabel(post: Parameters<typeof postAuthorName>[0]): string {
  return post.association
    ? m.post_view_association_label({ name: post.association.name })
    : m.post_view_profile_label({ name: postAuthorName(post) });
}
