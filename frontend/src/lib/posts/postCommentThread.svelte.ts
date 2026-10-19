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
  getPost,
  likeComment as likeCommentApi,
  type PostComment,
  type PostEntity,
  type PostMediaRef,
} from '$lib/posts/api';
import { assertNotMuted, cachedMuteStatus } from '$lib/moderation/muteCheck';
import { publishFailureMessage } from '$lib/posts/publishFailure';
import { withCommentCountDelta, type CommentChange } from '$lib/posts/commentChange';
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
  /** The whole thread is about to be read: the card stops adopting a feed row's first few. */
  holdThread(): void;
  /** The whole thread was read: `full` is the server's post. */
  adoptThread(full: PostEntity): void;
  /** A refusal or a failure, in the reader's words: the card's line, the viewer's toast. */
  fail(message: string): void;
}

/** How a new comment ended: sent, refused before anything was written, or failed after. */
export type CommentOutcome = 'sent' | 'refused' | 'failed';

type CommentsListener = (change: CommentChange, from: object) => void;
/** Surfaces listening for a thread written elsewhere, by post id. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry of callbacks, never rendered
const listeners = new Map<string, Set<CommentsListener>>();

/**
 * Tells every surface showing `postId` a write made on another one (`from`, which its own
 * listener ignores). A listener that throws is logged and does not stop the others.
 */
export function publishPostComments(postId: string, change: CommentChange, from: object): void {
  for (const listener of listeners.get(postId) ?? []) {
    try {
      listener(change, from);
    } catch (err) {
      console.error(`[post-comments] a surface failed to take the comments of ${postId}`, err);
    }
  }
}

/** Listens for {@link publishPostComments} on `postId`. Returns the unsubscribe. */
export function onPostComments(postId: string, listener: CommentsListener): () => void {
  let set = listeners.get(postId);
  if (!set) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry of callbacks, never rendered
    set = new Set();
    listeners.set(postId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(postId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(postId);
  };
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
   */
  async add(
    text: string,
    parentId: string | undefined,
    media: PostMediaRef | undefined,
    clear: () => void
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
      userId,
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
      const result = await addComment(this.host.read().id, { text, parentId, media });
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
      this.host.write(withCommentCountDelta({ ...post, comments: kept }, -count));
      this.announce({ kind: 'remove', ids: ids.length > 0 ? ids : [commentId], count });
    } catch (err) {
      Log.d('PostCommentThread.remove failed', err);
      this.host.fail(m.post_unable_to_delete_comment());
    }
  }

  /**
   * Reads the whole thread: a feed row carries only its first few comments. A failure keeps the
   * thread shown.
   */
  async loadAll(): Promise<void> {
    this.host.holdThread();
    try {
      const full = await getPost(this.host.read().id);
      // A read of the post itself carries EVERY comment and no `commentCount`: its rows are the total.
      // Written ON the row, never on a copy: a spread drops the read's served stamp (`stampServed`, a
      // non-enumerable symbol), and an unstamped read is refused by every field a write answered.
      full.commentCount = (full.comments ?? []).length;
      this.host.adoptThread(full);
    } catch (err) {
      Log.d('PostCommentThread.loadAll failed - the thread shown is kept', err);
    }
  }
}
