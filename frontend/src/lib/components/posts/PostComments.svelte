<script lang="ts">
  import { ChevronDown, ChevronUp, ArrowUpDown } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { PostComment, PostMediaRef } from '$lib/posts/api';
  import type { CommentIdentity } from '$lib/posts/postIdentity';
  import type { CommentOutcome } from '$lib/posts/postCommentThread.svelte';
  import { commentAuthorKind, commentAuthorName } from '$lib/posts/commentAuthor';
  import CommentItem, { commentAnchorId } from './CommentItem.svelte';
  import CommentComposer from './CommentComposer.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  type SortMode = 'recent' | 'oldest' | 'liked';

  /** Props for the PostComments section of a post card. */
  interface Props {
    /** The post, for the draft kept per post and the composer's ids. */
    postId: string;
    /** All comments on the post (including replies). */
    comments: PostComment[];
    /** Top-level comments only (parentId is null). Pre-computed by the parent to avoid redundant filtering. */
    topLevelComments: PostComment[];
    /** Whether the full comment list is expanded (false = show preview only). */
    showComments: boolean;
    /** Current value of the comment input box, controlled by the parent. */
    commentText: string;
    /** True while a new comment is being submitted to prevent double-posting. */
    submittingComment: boolean;
    /** Authenticated user's ID: the heart, and the composer's avatar. Rights come from the server. */
    currentUserId: string;
    /** Total comment count from the server (may be higher than comments.length if the list was truncated). */
    totalCommentCount?: number;
    /** Called when the user clicks "Afficher" / "Masquer" to toggle comment visibility. */
    onToggleComments: () => void;
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
    /** If provided, a "view older comments" button is shown while the server counts more than is loaded. */
    onLoadAllComments?: () => Promise<void>;
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
    /**
     * Drawn as a sheet's body (`ReelCommentsSheet`): the list scrolls in the height it is given and
     * the composer stays docked under it, as Instagram's does, and the show/hide toggle is not drawn
     * - the sheet has its own close.
     */
    docked?: boolean;
  }

  let {
    postId,
    comments,
    topLevelComments,
    showComments,
    commentText,
    submittingComment,
    currentUserId,
    authToken = '',
    totalCommentCount,
    onToggleComments,
    onCommentTextChange,
    onAddComment,
    onLikeComment,
    onEditComment,
    onDeleteComment,
    onReport,
    onLoadAllComments,
    onKeyDown,
    sendError = '',
    pendingCommentIds,
    focusCommentId,
    docked = false,
  }: Props = $props();

  /** The focus id already acted on, so a later redraw (a new comment, a like) never scrolls again. */
  let focusHandled: string | undefined;
  $effect(() => {
    const id = focusCommentId;
    if (!id || focusHandled === id || !showComments) return;
    if (!comments.some((c) => c.id === id)) {
      // Deleted since the push, or not in this list: the post is shown, and the log says why the
      // page did not move.
      Log.d(`[PostComments] focus comment ${id.slice(0, 8)} not in the thread - post shown at top`);
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

  let loadingAll = $state(false);

  /** Calls onLoadAllComments with a loading spinner, then clears the spinner. */
  async function handleLoadAll() {
    loadingAll = true;
    await onLoadAllComments?.();
    loadingAll = false;
  }

  /** More comments exist than this copy holds: the server's total is higher than the rows. */
  const hasOlderComments = $derived(
    !!onLoadAllComments &&
      totalCommentCount !== undefined &&
      totalCommentCount > comments.length &&
      showComments
  );

  let composer = $state<{ focus: () => void } | null>(null);
  let replyingToId = $state<string | null>(null);
  let replyingToName = $state<string>('');
  let sortMode = $state<SortMode>('recent');

  const PREVIEW_COUNT = 1;

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

  const visibleComments = $derived(
    showComments ? sortedTopLevel : sortedTopLevel.slice(0, PREVIEW_COUNT)
  );
</script>

<!--
  NOTHING IS DRAWN FOR A POST NOBODY HAS COMMENTED ON, and that used to cost 90 px per card.

  An `{:else}` branch here rendered the composer at rest in EVERY card - avatar, "Soyez le premier..."
  and a send button - measured on A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14. Four posts visible on a
  phone meant 360 px of empty input fields between them. Facebook draws none: its comment icon opens
  the composer, which is what this card's own comment button already does.

  So `showComments` is now the only thing that opens it, and the placeholder still says "be the
  first" when the post has no comments - the invitation was worth keeping, the permanent field was
  not.

  OPENED FROM ZERO, THE COMPOSER SITS 8 PX UNDER THE ACTION ROW, and it sat 45 px under it. Measured
  at 436 px (the Mi 9T's width) on 2026-10-01, three paddings stacked above an input with nothing
  between them: this section's own `py-4` (16), the EMPTY list's `mb-4` (16) and the input area's
  `pt-3` (12) - spacing that separates a list from the composer, drawn when there is no list. The
  user read it on the phone as ~100 px of dead space under the icons. The list and its gap now
  exist only when there are comments, and the section pads itself like the row above it.
-->
{#if comments.length > 0 || showComments}
  <div
    class={docked
      ? 'flex h-full min-h-0 flex-col px-4 pt-2 pb-3 sm:px-5'
      : 'border-t border-black/5 bg-white/30 px-4 pt-2 pb-3 sm:px-5 dark:border-white/10 dark:bg-black/10'}
  >
    <div
      class={docked ? 'min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain' : ''}
      data-post-comments-list
    >
      <!--
      Controls: show/hide + sort. Both are about a LIST, so neither is drawn for a post with no
      comments - opened from zero, this section is a composer and "Masquer les commentaires" would
      name something that is not on screen.
    -->
      {#if topLevelComments.length > 0}
        <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div class="min-w-0">
            {#if topLevelComments.length > PREVIEW_COUNT && !showComments}
              <button
                type="button"
                onclick={onToggleComments}
                class="text-text-muted hover:text-text-main text-2xs flex items-center gap-1.5 rounded-lg px-2 py-1 font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <ChevronDown size={16} strokeWidth={2.5} />
                {m.post_show_comments_label({ count: topLevelComments.length })}
              </button>
            {:else if showComments && !docked}
              <button
                type="button"
                onclick={onToggleComments}
                class="text-text-muted hover:text-text-main text-2xs flex items-center gap-1.5 rounded-lg px-2 py-1 font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <ChevronUp size={16} strokeWidth={2.5} />
                {m.post_hide_comments_label()}
              </button>
            {/if}
          </div>

          <!-- Tri -->
          {#if topLevelComments.length > 1}
            <div class="flex min-w-0 flex-wrap items-center gap-1">
              <ArrowUpDown size={12} class="text-text-muted opacity-60" />
              {#each [['recent', m.post_sort_recent_label()], ['oldest', m.post_sort_oldest_label()], ['liked', m.post_sort_liked_label()]] as const as [mode, label] (mode)}
                <button
                  type="button"
                  onclick={() => (sortMode = mode)}
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
        </div>
      {/if}

      <!-- Comment list. -->
      {#if visibleComments.length > 0}
        <div class="mb-3 space-y-1">
          {#each visibleComments as comment (comment.id)}
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
          {/each}
        </div>
      {/if}

      <!-- Older comments, while the server counts more than this copy holds. -->
      {#if hasOlderComments}
        <button
          type="button"
          onclick={handleLoadAll}
          disabled={loadingAll}
          class="tap-target text-text-muted hover:text-text-main text-2xs mb-2 w-full rounded-lg py-1.5 font-bold transition-colors disabled:opacity-50"
        >
          {loadingAll ? m.common_loading_label() : m.post_comment_load_older_label()}
        </button>
      {/if}
    </div>

    <!-- Input area. -->
    <div class={docked ? 'shrink-0 pt-2' : ''}>
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
{/if}
