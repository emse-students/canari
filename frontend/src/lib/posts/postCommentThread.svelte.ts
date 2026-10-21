/**
 * ONE PATH FOR WRITING A POST'S COMMENTS, WHEREVER THE THREAD IS SHOWN.
 *
 * A reel is a post (C2), so its comments are the post's: the same rows, the same moderation, the
 * same composer and the same requests. Until 2026-10-19 the only place they were written was
 * `PostCard`, inline; the CanaReels comments sheet (user, 2026-10-19: a reel's comment button opens
 * them over the playing reel, as on Instagram) is a second surface, so the writes live here once.
 *
 * WHERE THE POST IS HELD AND HOW A FAILURE IS SAID STAY WITH EACH SURFACE (`CommentThreadHost`): the
 * card keeps a ledger of its own writes and an inline line, the viewer keeps its array of reels and
 * says a refusal in a toast. What both need - the comment shown before it is sent under a LOCAL id
 * (`pending`), the refusal known before any request, the request behind `assertNotMuted`, the
 * row-by-row rollback - is the class below.
 *
 * A write on one surface is announced to the others showing the same post AS A CHANGE
 * ({@link publishPostComments}, `posts/commentChange.ts`), never as a list - so closing the reel
 * viewer shows the card with the comment just written there, and the card keeps every row it held.
 * Every write keeps the post's `commentCount` (the server's total) in step.
 */
import { SvelteSet } from 'svelte/reactivity';
import {
  addComment,
  deleteComment as deleteCommentApi,
  editComment as editCommentApi,
  fetchComments,
  likeComment as likeCommentApi,
  type PostComment,
  type PostEntity,
  type PostMediaRef,
} from '$lib/posts/api';
import { assertNotMuted, cachedMuteStatus } from '$lib/moderation/muteCheck';
import { publishFailureMessage } from '$lib/posts/publishFailure';
import { withCommentCountDelta, type CommentChange } from '$lib/posts/commentChange';
import { PostListeners } from '$lib/posts/postListeners';
import {
  PERSONAL_COMMENT_IDENTITY,
  commentIdentityFields,
  type CommentIdentity,
} from '$lib/posts/postIdentity';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/** What a surface showing a post's comments lends the thread. */
export interface CommentThreadHost {
  /** The signed-in reader. */
  userId(): string;
  /** The post as this surface holds it now. */
  read(): PostEntity;
  /** Replaces this surface's copy of the post. */
  write(next: PostEntity): void;
  /** A write of the comments starts; the card's ledger holds the field until `end`. */
  begin(): void;
  /** That write is over, whichever way it went. */
  end(): void;
  /** An answer replaced the comments outright (an edit, a deletion). */
  answered(): void;
  /** A refusal or a failure, in the reader's words: the card's line, the viewer's toast. */
  fail(message: string): void;
}

/** How a new comment ended: sent, refused before anything was written, or failed after. */
export type CommentOutcome = 'sent' | 'refused' | 'failed';

type CommentsListener = (change: CommentChange, from: object) => void;
/** Surfaces listening for a thread written elsewhere, by post id. */
const listeners = new PostListeners<[change: CommentChange, from: object]>(
  'post-comments',
  'comments'
);

/**
 * Tells every surface showing `postId` a write made on another one (`from`, which its own
 * listener ignores). A listener that throws is logged and does not stop the others.
 */
export function publishPostComments(postId: string, change: CommentChange, from: object): void {
  listeners.publish(postId, change, from);
}

/** Listens for {@link publishPostComments} on `postId`. Returns the unsubscribe. */
export function onPostComments(postId: string, listener: CommentsListener): () => void {
  return listeners.on(postId, listener);
}

/** The ids of `rows`, for the membership tests below (not observed by any template). */
function idsOf(rows: readonly PostComment[]): Set<string> {
  return new Set(rows.map((c) => c.id));
}

/** Threads asked per page: the server's own default, so a page is one request of the usual size. */
export const COMMENT_PAGE_SIZE = 20;

/**
 * `post` with the rows of a page ADDED: a row already held is kept as it is, never replaced.
 *
 * The held rows are authoritative - they carry the feed row, and every write this device made
 * (a heart tapped while the page was in flight is newer than the page's copy of that comment) - so
 * a page can only bring what was not held, never undo what was. `removed` names the comments taken
 * away on this device: a page read before the deletion answered still carries them.
 */
function withOlderComments(
  post: PostEntity,
  page: PostComment[],
  removed: ReadonlySet<string>
): PostEntity {
  const held = post.comments ?? [];
  const known = idsOf(held);
  // A comment removed here while the page was in flight is in that page's copy: it stays gone.
  const added = page.filter((c) => !known.has(c.id) && !removed.has(c.id));
  return added.length === 0 ? post : { ...post, comments: [...held, ...added] };
}

/** The comments of `post` with `id` replaced by `row` (or removed when `row` is null). */
function withComment(post: PostEntity, id: string, row: PostComment | null): PostEntity {
  const comments = post.comments ?? [];
  return {
    ...post,
    comments: row
      ? comments.map((c) => (c.id === id ? row : c))
      : comments.filter((c) => c.id !== id),
  };
}

/** The comment writes of one surface, over its {@link CommentThreadHost}. */
export class PostCommentThread {
  /**
   * Comments written into the list before the server acknowledged them, by their LOCAL id.
   * `PostComments` withholds every control that would name such an id to the server.
   */
  readonly pending = new SvelteSet<string>();
  /** True while a new comment is on its way, so the composer cannot send it twice. */
  submitting = $state(false);

  constructor(private readonly host: CommentThreadHost) {}

  /** Announces this surface's write to the others showing the same post. */
  private announce(change: CommentChange): void {
    publishPostComments(this.host.read().id, change, this);
  }

  /**
   * Adds a comment (or a reply to `parentId`) carrying `text` and/or `media`.
   *
   * THE COMMENT IS COMPLETE BEFORE IT IS SENT, so it is shown before it is sent, under a local id
   * listed in `pending`, and `clear` empties the caller's box at that moment. A mute already known
   * refuses before anything moves ('refused', the box keeps the text); a failure afterwards removes
   * ONLY the row this write added ('failed', the caller puts the text back).
   *
   * `identity` is who the comment is written as. The row is drawn as THAT identity at once - an
   * anonymous comment never flashes the writer's name, an association's carries its card - and the
   * request carries the same choice, so the row and the answer cannot disagree about whose it is.
   */
  async add(
    text: string,
    parentId: string | undefined,
    media: PostMediaRef | undefined,
    clear: () => void,
    identity: CommentIdentity = PERSONAL_COMMENT_IDENTITY
  ): Promise<CommentOutcome> {
    const userId = this.host.userId().trim();
    if ((!text && !media) || !userId) return 'refused';
    if (cachedMuteStatus()?.isMuted) {
      Log.d('PostCommentThread.add', 'refused: the reader is muted');
      this.host.fail(m.post_action_not_allowed());
      return 'refused';
    }

    const pendingId = `pending-${crypto.randomUUID()}`;
    const row: PostComment = {
      id: pendingId,
      // The account is withheld from an anonymous or association row, as the server withholds it.
      ...(identity.kind === 'personal' ? { userId } : {}),
      ...(identity.kind === 'anonymous' ? { anonymous: true } : {}),
      ...(identity.kind === 'association' ? { association: { ...identity.association } } : {}),
      text,
      parentId: parentId ?? null,
      likes: [],
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a stamp written once, never observed
      createdAt: new Date().toISOString(),
      ...(media ? { media } : {}),
    };
    this.pending.add(pendingId);
    const before = this.host.read();
    this.host.write(
      withCommentCountDelta({ ...before, comments: [...(before.comments ?? []), row] }, 1)
    );
    clear();
    this.submitting = true;

    this.host.begin();
    try {
      await assertNotMuted();
      const result = await addComment(this.host.read().id, {
        text,
        parentId,
        media,
        ...commentIdentityFields(identity),
      });
      this.host.write(withComment(this.host.read(), pendingId, result.comment));
      this.announce({ kind: 'upsert', comment: result.comment });
      return 'sent';
    } catch (err) {
      // Two causes wear this sentence: moderation refusing, and `addComment` failing. Only the row
      // this write added goes; the list carries the reader's other writes, which this says nothing about.
      console.error('[post-comments] comment refused', err);
      this.host.write(withCommentCountDelta(withComment(this.host.read(), pendingId, null), -1));
      this.host.fail(publishFailureMessage(err, m.post_unable_to_comment()));
      return 'failed';
    } finally {
      this.host.end();
      this.pending.delete(pendingId);
      this.submitting = false;
    }
  }

  /**
   * Toggles the reader's heart on a comment. The heart is a membership test on an array this device
   * holds, so it moves on the tap; a failure puts back THIS comment only.
   */
  async like(commentId: string): Promise<void> {
    const userId = this.host.userId();
    const previous = (this.host.read().comments ?? []).find((c) => c.id === commentId);
    if (!previous) {
      Log.d('PostCommentThread.like', `unknown comment ${commentId.slice(0, 8)}`);
      return;
    }
    this.host.begin();
    const likes = previous.likes.includes(userId)
      ? previous.likes.filter((id) => id !== userId)
      : [...previous.likes, userId];
    this.host.write(withComment(this.host.read(), commentId, { ...previous, likes }));
    try {
      const result = await likeCommentApi(this.host.read().id, commentId);
      this.host.write(withComment(this.host.read(), commentId, result.comment));
      this.announce({ kind: 'upsert', comment: result.comment });
    } catch (err) {
      Log.d('PostCommentThread.like failed', err);
      this.host.write(withComment(this.host.read(), commentId, previous));
    } finally {
      this.host.end();
    }
  }

  /** Replaces a comment's text with the server's answer. */
  async edit(commentId: string, text: string): Promise<void> {
    try {
      const result = await editCommentApi(this.host.read().id, commentId, text);
      this.host.answered();
      this.host.write(withComment(this.host.read(), commentId, result.comment));
      this.announce({ kind: 'upsert', comment: result.comment });
    } catch (err) {
      Log.d('PostCommentThread.edit failed', err);
      this.host.fail(m.post_unable_to_edit_comment());
    }
  }

  /** Deletes a comment and its replies. */
  async remove(commentId: string): Promise<void> {
    try {
      await deleteCommentApi(this.host.read().id, commentId);
      this.host.answered();
      const post = this.host.read();
      const held = post.comments ?? [];
      const kept = held.filter((c) => c.id !== commentId && c.parentId !== commentId);
      // The server deletes the comment and its replies; the count goes down by the rows held, and
      // by one at least - the comment itself, even when this copy no longer held it.
      const count = Math.max(1, held.length - kept.length);
      const ids = held.filter((c) => !kept.includes(c)).map((c) => c.id);
      this.noteRemoved(ids.length > 0 ? ids : [commentId]);
      this.host.write(withCommentCountDelta({ ...post, comments: kept }, -count));
      this.announce({ kind: 'remove', ids: ids.length > 0 ? ids : [commentId], count });
    } catch (err) {
      Log.d('PostCommentThread.remove failed', err);
      this.host.fail(m.post_unable_to_delete_comment());
    }
  }

  // --- Paging -------------------------------------------------------------------------------------
  // A feed row carries the newest few threads. The rest is read PAGE BY PAGE from
  // `GET /posts/:id/comments` (whole threads, newest first), the cursor being where the last page
  // ended, so a long thread is never read in one go.

  /** Where the last page ended; `undefined` before the first page, `null` once the server said no more. */
  private cursor: number | null | undefined = undefined;
  /** Pages read so far: while any were, a fresher feed row must not cut the thread back (`keepHeld`). */
  private pagesRead = 0;
  /** Comments removed since this thread was drawn (by it, or by another surface it was told of). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping read only inside this class's methods, never in a template
  private readonly removed = new Set<string>();

  /**
   * Remembers comments that were removed, so a page read BEFORE the removal answered cannot bring
   * them back. `remove` calls it; so does a surface told of another surface's removal.
   */
  noteRemoved(ids: readonly string[]): void {
    for (const id of ids) this.removed.add(id);
  }

  /** True while a page is on its way, so the button cannot ask twice. */
  loadingMore = $state(false);
  /** The server's answer to "is there more": `undefined` until a page has told us. */
  hasMore = $state<boolean | undefined>(undefined);

  /** Whether any page was read: the card keeps those rows when its feed row is replaced. */
  get hasPages(): boolean {
    return this.pagesRead > 0;
  }

  /**
   * Reads the next page of older threads and ADDS them. A failure is said (`fail`), never silent: a
   * reader who tapped "older comments" and saw nothing happen would tap again to no effect.
   */
  async loadMore(): Promise<void> {
    if (this.loadingMore || this.hasMore === false) return;
    this.loadingMore = true;
    try {
      const page = await fetchComments(this.host.read().id, {
        cursor: this.cursor,
        limit: COMMENT_PAGE_SIZE,
        order: 'recent',
      });
      this.host.write(withOlderComments(this.host.read(), page.comments, this.removed));
      this.cursor = page.nextCursor;
      this.hasMore = page.hasMore;
      this.pagesRead++;
    } catch (err) {
      Log.d('PostCommentThread.loadMore failed - the thread shown is kept', err);
      this.host.fail(m.post_comment_load_older_error());
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * `adopted` - the post a fresher feed row produced - with the older rows this thread had read and
   * the row does not carry. A feed row holds only the newest few threads, so adopting it alone would
   * cut the thread the reader had extended back to those few (and move the page under their thumb);
   * the row's own copy of a comment still wins, being the fresher. Nothing is read again.
   */
  keepHeld(before: PostEntity, adopted: PostEntity): PostEntity {
    const carried = idsOf(adopted.comments ?? []);
    const kept = (before.comments ?? []).filter(
      (c) => !carried.has(c.id) && !this.removed.has(c.id)
    );
    return kept.length === 0
      ? adopted
      : { ...adopted, comments: [...(adopted.comments ?? []), ...kept] };
  }
}
