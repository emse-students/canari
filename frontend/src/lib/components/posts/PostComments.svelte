<script lang="ts">
  import { ArrowUpDown } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import type { PostComment, PostMediaRef } from '$lib/posts/api';
  import type { CommentIdentity } from '$lib/posts/postIdentity';
  import type { CommentOutcome } from '$lib/posts/postCommentThread.svelte';
  import { commentAuthorKind, commentAuthorName } from '$lib/posts/commentAuthor';
  import CommentItem, { commentAnchorId } from './CommentItem.svelte';
  import CommentComposer from './CommentComposer.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { commentArrivals } from '$lib/posts/commentArrival';

  type SortMode = 'recent' | 'oldest' | 'liked';

  /** The most pages "oldest" and "liked" read before sorting, so a very long thread cannot loop for ever. */
  const MAX_PAGES_FOR_SORT = 25;

  /**
   * A POST'S THREAD AS A SHEET'S BODY: the list scrolls in the height it is given, and the composer
   * stays docked under it (the card's comment sheet `PostCommentsSheet`, and the reel viewer's
   * `ReelCommentsSheet`). The card itself shows only a one-comment preview (`CommentsPreview`), so
   * there is no inline mode left here: the whole thread is always this.
   */
  interface Props {
    /** The post, for the draft kept per post and the composer's ids. */
    postId: string;
    /** All comments on the post held so far (including replies). */
    comments: PostComment[];
    /** Top-level comments only (parentId is null). Pre-computed by the parent to avoid redundant filtering. */
    topLevelComments: PostComment[];
    /** Current value of the comment input box, controlled by the parent. */
    commentText: string;
    /** True while a new comment is being submitted to prevent double-posting. */
    submittingComment: boolean;
    /** Authenticated user's ID: the heart, and the composer's avatar. Rights come from the server. */
    currentUserId: string;
    /** Total comment count from the server (may be higher than comments.length while pages are unread). */
    totalCommentCount?: number;
    /** Called on each keystroke to sync the comment input value to the parent's state. */
    onCommentTextChange: (text: string) => Promise<void>;
    /**
     * Called when the user submits a comment (or reply if parentId is provided). `media` is an
     * optional encrypted GIF/image; `identity` is who it is written as. The outcome says whether
     * it went, so the composer keeps a chosen identity across a failed send.
     */
    onAddComment: (
      parentId?: string,
      media?: PostMediaRef,
      identity?: CommentIdentity
    ) => Promise<CommentOutcome>;
    /** Called when the user toggles a like on a comment. */
    onLikeComment: (commentId: string) => void;
    /** Called when the user saves an inline edit. */
    onEditComment: (commentId: string, text: string) => Promise<void>;
    /** Called when the user deletes a comment (after the confirmation this section asks). */
    onDeleteComment: (commentId: string) => Promise<void>;
    /** Called when the user reports a comment. */
    onReport?: (commentId: string) => void;
    /** Bearer token forwarded to PostImage for decrypting comment media. */
    authToken?: string;
    /** Reads the next page of older threads; the "older comments" button and the sorts call it. */
    onLoadOlder?: () => Promise<void>;
    /**
     * The server's answer to "is there more": `true` offers the button, `false` hides it, and
     * `undefined` (no page read yet) falls back to comparing the server's count with the rows held.
     */
    hasMoreComments?: boolean;
    /** A page is on its way: the button says so and cannot ask twice. */
    loadingMore?: boolean;
    /** Optional external keydown handler forwarded after internal shortcuts are processed. */
    onKeyDown?: (e: KeyboardEvent) => void;
    /**
     * Why the last comment did not go, shown beside the box until the reader types again. It used to
     * be a banner at the bottom of the whole card.
     */
    sendError?: string;
    /**
     * Comments shown before the server has acknowledged them.
     *
     * THEY CARRY A LOCAL ID, WHICH NO ENDPOINT WOULD RECOGNISE, so every control that would name
     * one to the server is withheld until the real row replaces it. That is the whole contract:
     * the reader sees their comment immediately and cannot act on an id that does not exist yet.
     */
    pendingCommentIds?: ReadonlySet<string>;
    /**
     * The comment a notification tap opened the post at (`?comment=` on `/posts/[postId]`): scrolled
     * into view once it is drawn, and marked so the reader sees which one they were told about.
     */
    focusCommentId?: string;
    /** Put the caret in the box when the thread opens (the "write a comment" tap, an empty thread). */
    autofocusComposer?: boolean;
  }

  let {
    postId,
    comments,
    topLevelComments,
    commentText,
    submittingComment,
    currentUserId,
    authToken = '',
    totalCommentCount,
    onCommentTextChange,
    onAddComment,
    onLikeComment,
    onEditComment,
    onDeleteComment,
    onReport,
    onLoadOlder,
    hasMoreComments,
    loadingMore = false,
    onKeyDown,
    sendError = '',
    pendingCommentIds,
    focusCommentId,
    autofocusComposer = false,
  }: Props = $props();

  /** The focus id already acted on, so a later redraw (a new comment, a like) never scrolls again. */
  let focusHandled: string | undefined;
  $effect(() => {
    const id = focusCommentId;
    if (!id || focusHandled === id) return;
    if (!comments.some((c) => c.id === id)) {
      // Deleted since the push, or not in this list: the thread is shown from the top, and the log
      // says why the page did not move.
      Log.d(
        `[PostComments] focus comment ${id.slice(0, 8)} not in the thread - shown from the top`
      );
      focusHandled = id;
      return;
    }
    focusHandled = id;
    void tick().then(() => {
      const el = document.getElementById(commentAnchorId(id));
      Log.d(`[PostComments] focus comment ${id.slice(0, 8)} found=${el !== null}`);
      el?.scrollIntoView({ block: 'center' });
    });
  });

  let composer = $state<{ focus: () => void } | null>(null);

  onMount(() => {
    if (autofocusComposer) void tick().then(() => composer?.focus());
  });

  /** More threads can be read: the server said so, or - before any page - its count exceeds the rows. */
  const hasOlderComments = $derived(
    !!onLoadOlder &&
      (hasMoreComments ?? (totalCommentCount !== undefined && totalCommentCount > comments.length))
  );

  let replyingToId = $state<string | null>(null);
  let replyingToName = $state<string>('');
  let sortMode = $state<SortMode>('recent');

  /**
   * Picks a sort. "Recent" is the order the pages come in; "oldest" and "liked" are about the WHOLE
   * thread, so while more pages exist they are read first (up to `MAX_PAGES_FOR_SORT`), or the list
   * would be the oldest of what happens to be loaded - not the oldest comments.
   */
  async function selectSort(mode: SortMode) {
    sortMode = mode;
    if (mode === 'recent' || !onLoadOlder) return;
    for (let i = 0; i < MAX_PAGES_FOR_SORT && hasOlderComments; i++) {
      const before = comments.length;
      await onLoadOlder();
      // A page that brought nothing (a failure, which the host said) ends the wait.
      if (comments.length === before) break;
    }
  }

  /**
   * Enters reply mode targeting the given comment, and puts the caret in the box (it used to leave
   * the reader to find the box at the end of the thread and tap again). Replies to replies are
   * threaded under the top-level comment (flat); a reply to a PERSONAL comment pre-fills the name,
   * an anonymous or association comment has no name to type.
   */
  function initiateReply(comment: PostComment) {
    replyingToId = comment.parentId ?? comment.id;
    replyingToName = commentAuthorName(comment);
    if (comment.parentId && commentAuthorKind(comment) === 'personal') {
      void onCommentTextChange(`@${replyingToName} `);
    }
    void tick().then(() => composer?.focus());
  }

  /** Re-enters reply mode on a comment a kept draft was answering, without touching the text. */
  function restoreReply(commentId: string) {
    const target = comments.find((c) => c.id === commentId);
    if (!target) {
      Log.d(
        `[PostComments] draft reply target ${commentId.slice(0, 8)} is gone - draft kept as a comment`
      );
      return;
    }
    replyingToId = target.parentId ?? target.id;
    replyingToName = commentAuthorName(target);
  }

  /** Exits reply mode and clears the reply target name. Undoes the name pre-fill if untouched. */
  function cancelReply() {
    if (commentText === `@${replyingToName} `) {
      void onCommentTextChange('');
    }
    replyingToId = null;
    replyingToName = '';
  }

  /** An inline edit starts on some comment: the reply being composed is dropped. */
  function dropReplyForEdit() {
    replyingToId = null;
    replyingToName = '';
  }

  /** Sends through the host, then leaves reply mode; the outcome goes back to the composer. */
  async function handleSend(send: {
    parentId?: string;
    media?: PostMediaRef;
    identity: CommentIdentity;
  }): Promise<CommentOutcome> {
    const outcome = await onAddComment(send.parentId, send.media, send.identity);
    cancelReply();
    return outcome;
  }

  const sortedTopLevel = $derived.by(() => {
    const list = [...topLevelComments];
    if (sortMode === 'oldest')
      return list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    if (sortMode === 'liked')
      return list.sort((a, b) => (b.likes?.length ?? 0) - (a.likes?.length ?? 0));
    // recent = newest first
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  });

  // THE ENTRANCE OF ONE NEW COMMENT (`motion-pop-in`, `commentArrivals`). The reader's own comment is
  // shown under a local id and swapped for the server's row when it lands: that swap is the same
  // comment, so a pass in which a local id vanished is not an arrival.
  const knownIds = new Set<string>();
  let listDrawn = false;
  let heldLocalIds = new Set<string>();
  let arrived = $state<ReadonlySet<string>>(new Set());
  $effect(() => {
    const ids = sortedTopLevel.map((c) => c.id);
    const present = new Set(ids);
    const swapped = [...heldLocalIds].some((id) => !present.has(id));
    heldLocalIds = new Set(ids.filter((id) => pendingCommentIds?.has(id)));
    const fresh = commentArrivals(knownIds, ids, listDrawn && !swapped);
    listDrawn = true;
    if (fresh.length) arrived = new Set([...arrived, ...fresh]);
  });
</script>

<!--
  THE WHOLE THREAD, in the height the sheet gives it: the list scrolls, the composer is docked under
  it. Nothing here decides whether to be drawn - a post nobody commented on opens as a composer and
  nothing else, and the sheet is opened only from a tap that asked for it (the card draws NOTHING
  for a post with no comments, `CommentsPreview`).
-->
<div class="flex h-full min-h-0 flex-col px-4 pt-2 pb-3 sm:px-5">
  <!-- The scroller reaches the sheet's edges (`-mx-4 px-4`), so the 44 px hit box a small control gets on a
       touch screen (`tap-target`, the heart at the row's right end) stays INSIDE it: with the padding on
       the wrapper instead, that box stuck out by a few pixels and the list scrolled sideways. -->
  <div
    class="-mx-4 min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain px-4 sm:-mx-5 sm:px-5"
    data-post-comments-list
  >
    <!-- Sort: about a LIST, so not drawn for fewer than two comments. -->
    {#if topLevelComments.length > 1}
      <div class="mb-2 flex flex-wrap items-center justify-end gap-1">
        <ArrowUpDown size={12} class="text-text-muted opacity-60" />
        {#each [['recent', m.post_sort_recent_label()], ['oldest', m.post_sort_oldest_label()], ['liked', m.post_sort_liked_label()]] as const as [mode, label] (mode)}
          <button
            type="button"
            onclick={() => void selectSort(mode)}
            class="tap-target text-2xs rounded-full px-2 py-0.5 font-bold transition-colors {sortMode ===
            mode
              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              : 'text-text-muted hover:text-text-main'}"
          >
            {label}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Comment list. -->
    {#if sortedTopLevel.length > 0}
      <div class="mb-3 space-y-1">
        {#each sortedTopLevel as comment (comment.id)}
          <div class={arrived.has(comment.id) ? 'motion-pop-in' : ''}>
            <CommentItem
              {comment}
              {comments}
              {currentUserId}
              {authToken}
              {pendingCommentIds}
              {focusCommentId}
              onLike={onLikeComment}
              onReply={initiateReply}
              onEditStart={dropReplyForEdit}
              onEdit={onEditComment}
              onDelete={onDeleteComment}
              {onReport}
            />
          </div>
        {/each}
      </div>
    {/if}

    <!-- Older comments, page by page. -->
    {#if hasOlderComments}
      <button
        type="button"
        onclick={() => void onLoadOlder?.()}
        disabled={loadingMore}
        class="tap-target text-text-muted hover:text-text-main text-2xs mb-2 w-full rounded-lg py-1.5 font-bold transition-colors disabled:opacity-50"
      >
        {loadingMore ? m.common_loading_label() : m.post_comment_load_older_label()}
      </button>
    {/if}
  </div>

  <!-- Input area. -->
  <div class="shrink-0 pt-2">
    <CommentComposer
      bind:this={composer}
      {postId}
      value={commentText}
      onChange={(text) => onCommentTextChange(text)}
      placeholder={replyingToId
        ? m.post_reply_placeholder()
        : comments.length === 0
          ? m.post_first_comment_placeholder()
          : m.post_comment_placeholder()}
      submitting={submittingComment}
      {currentUserId}
      replyTo={replyingToId ? { id: replyingToId, name: replyingToName } : null}
      onCancelReply={cancelReply}
      onRestoreReply={restoreReply}
      onSubmit={handleSend}
      {sendError}
      {onKeyDown}
    />
  </div>
</div>
