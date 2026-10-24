/**
 * WHO A COMMENT SAYS WROTE IT - the name, the link and the kind of avatar, in one place.
 *
 * A comment is written as the member, anonymously, or as an association (`CommentIdentity`), and the
 * server serves it accordingly: an anonymous comment has no name and, for most readers, no
 * `userId`; an association's has a card and no personal name. Everything that draws an author reads
 * these three answers, so none of them re-derives who wrote a comment from the fields that happen
 * to be present (which is how a stripped `userId` once became an empty profile link).
 */
import type { PostComment } from '$lib/posts/api';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { m } from '$lib/paraglide/messages';

export type CommentAuthorKind = 'personal' | 'anonymous' | 'association';

/** An association's comment wins over an anonymous flag, as the server resolves the two. */
export function commentAuthorKind(
  comment: Pick<PostComment, 'anonymous' | 'association'>
): CommentAuthorKind {
  if (comment.association) return 'association';
  if (comment.anonymous) return 'anonymous';
  return 'personal';
}

/** The personal name: "first last", then the display name, then whatever the app resolves for the id. */
function personalName(comment: PostComment): string {
  const first = comment.firstName?.trim();
  const last = comment.lastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (comment.displayName?.trim()) return comment.displayName.trim();
  return comment.userId ? getUserDisplayNameSync(comment.userId) : '';
}

/** What the comment's author line reads. An anonymous comment says when its writer is the post's author. */
export function commentAuthorName(comment: PostComment): string {
  const kind = commentAuthorKind(comment);
  if (kind === 'association') return comment.association?.name ?? '';
  if (kind === 'anonymous') {
    return comment.byPostAuthor
      ? m.post_comment_anonymous_author_label()
      : m.post_create_anonymous_label();
  }
  return personalName(comment);
}

/**
 * WHO WROTE AN ANONYMOUS COMMENT, for the reader the server told: it serves `userId` on an
 * anonymous comment to its writer, a content moderator and a platform admin only
 * (`comment-identity.ts`, `serveComment`), and stores no name on it - so the name is resolved from
 * that id by the caller. `null` for any other comment, and for an anonymous one whose `userId` was
 * withheld: the client draws what it was served and never decides who may see a writer.
 */
export function commentRevealedAuthorId(
  comment: Pick<PostComment, 'anonymous' | 'association' | 'userId'>
): string | null {
  if (commentAuthorKind(comment) !== 'anonymous') return null;
  return comment.userId || null;
}

/** Where the author line links: the association page, the profile, or nowhere for an anonymous comment. */
export function commentAuthorHref(comment: PostComment): string | null {
  const kind = commentAuthorKind(comment);
  if (kind === 'association' && comment.association) {
    return `/associations/${encodeURIComponent(comment.association.slug)}`;
  }
  if (kind === 'anonymous' || !comment.userId) return null;
  return `/profile/${encodeURIComponent(comment.userId)}`;
}
