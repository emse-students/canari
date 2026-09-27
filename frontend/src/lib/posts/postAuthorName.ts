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
