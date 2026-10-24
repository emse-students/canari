import { getSavedUserId } from '$lib/stores/user';

/**
 * A comment being written, kept per ACCOUNT and per POST so closing the sheet, navigating away or
 * a failed send never costs the text (the owner-keyed model of `postComposerDraft.ts`: a draft
 * keyed on the device alone would hand one account's words to the next).
 */
export interface PostCommentDraft {
  text: string;
  /** The comment being answered, or `null` for a new top-level comment. */
  parentId: string | null;
}

const KEY_PREFIX = 'canari_post_comment_draft:';

/** The storage key of one account's draft on one post. */
export function postCommentDraftKey(userId: string, postId: string): string {
  return `${KEY_PREFIX}${userId}:${postId}`;
}

function ownedKey(postId: string, action: string): string | null {
  const userId = getSavedUserId();
  if (!userId) {
    console.log(`[POST_COMMENT_DRAFT] ${action}: no signed-in account - draft untouched`);
    return null;
  }
  return postCommentDraftKey(userId, postId);
}

/** Saves the draft; an empty text with no reply target clears it instead of storing nothing. */
export function savePostCommentDraft(postId: string, draft: PostCommentDraft): void {
  if (typeof localStorage === 'undefined') return;
  if (draft.text.trim() === '') {
    clearPostCommentDraft(postId);
    return;
  }
  const key = ownedKey(postId, 'save');
  if (key) localStorage.setItem(key, JSON.stringify(draft));
}

/** The signed-in account's draft on this post, or `null` when there is none or it is unreadable. */
export function loadPostCommentDraft(postId: string): PostCommentDraft | null {
  if (typeof localStorage === 'undefined') return null;
  const key = ownedKey(postId, 'load');
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PostCommentDraft>;
    if (typeof parsed.text !== 'string') throw new Error('no text');
    return {
      text: parsed.text,
      parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
    };
  } catch (e) {
    console.warn(`[POST_COMMENT_DRAFT] unreadable draft for post ${postId} dropped`, e);
    localStorage.removeItem(key);
    return null;
  }
}

/** Forgets the draft - after a successful send, or when the writer empties the field. */
export function clearPostCommentDraft(postId: string): void {
  if (typeof localStorage === 'undefined') return;
  const key = ownedKey(postId, 'clear');
  if (key) localStorage.removeItem(key);
}
