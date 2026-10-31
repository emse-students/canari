<script module lang="ts">
  /** The DOM id of a comment's row, the anchor a notification tap scrolls to. */
  export function commentAnchorId(id: string): string {
    return `comment-${id}`;
  }

  /**
   * A top-level comment with at least this many replies draws them folded behind "Voir les N
   * réponses"; fewer are always shown, since folding one reply costs a tap and saves one row.
   */
  export const FOLD_REPLIES_FROM = 2;
</script>

<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import {
    ChevronDown,
    ChevronUp,
    CornerDownRight,
    Flag,
    Pencil,
    Send,
    Trash2,
    X,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import CommentMedia from './CommentMedia.svelte';
  import CommentLikeButton from './CommentLikeButton.svelte';
  import CommentAuthorAvatar from './CommentAuthorAvatar.svelte';
  import RevealedAuthorLine from './RevealedAuthorLine.svelte';
  import CommentItem from './CommentItem.svelte';
  import { POST_MARKDOWN_RENDERERS } from './postMarkdownRenderers';
  import { COMMENT_MAX_LENGTH, type PostComment } from '$lib/posts/api';
  import {
    commentAuthorHref,
    commentAuthorName,
    commentRevealedAuthorId,
  } from '$lib/posts/commentAuthor';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { reportLineClamp } from '$lib/actions/reportLineClamp';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE COMMENT AND ITS REPLIES: the bubble, who wrote it, the controls the SERVER says this reader
   * has, and the replies folded or not.
   *
   * The controls are `canEdit` / `canDelete`, never a comparison of `userId` with the reader: the
   * server withholds the account of an anonymous or association comment, so a client that derived
   * its own rights from `userId` would hide the writer's own controls (`durable-rules`, "a field the
   * server strips for privacy cannot be the field a client derives a permission from").
   */
  interface Props {
    comment: PostComment;
    isReply?: boolean;
    /** Every comment of the thread: the parent a reply names, and the replies of a top-level one. */
    comments: PostComment[];
    /** The reader, for the heart only. */
    currentUserId: string;
    authToken?: string;
    /** Local ids of comments the server has not acknowledged: their controls are withheld. */
    pendingCommentIds?: ReadonlySet<string>;
    /** The comment a notification tap opened the post at. */
    focusCommentId?: string;
    onLike: (commentId: string) => void;
    /** Enters reply mode on this comment (the host owns the composer). */
    onReply: (comment: PostComment) => void;
    /** An inline edit starts here: the host drops a reply it was composing. */
    onEditStart?: () => void;
    onEdit: (commentId: string, text: string) => Promise<void>;
    onDelete: (commentId: string) => Promise<void>;
    onReport?: (commentId: string) => void;
  }

  let {
    comment,
    isReply = false,
    comments,
    currentUserId,
    authToken = '',
    pendingCommentIds,
    focusCommentId,
    onLike,
    onReply,
    onEditStart,
    onEdit,
    onDelete,
    onReport,
  }: Props = $props();

  const authorName = $derived(commentAuthorName(comment));
  const authorHref = $derived(commentAuthorHref(comment));
  /**
   * The writer of an anonymous comment, for the reader the server served it to (the writer, a
   * moderator, an admin): drawn small under "Anonyme", which stays the name (user, 2026-10-24).
   */
  const revealedAuthorId = $derived(commentRevealedAuthorId(comment));
  const isPending = $derived(pendingCommentIds?.has(comment.id) ?? false);
  const liked = $derived(comment.likes?.includes(currentUserId) ?? false);
  const likeCount = $derived(comment.likes?.length ?? 0);
  const isFocused = $derived(comment.id === focusCommentId);
  const replies = $derived(isReply ? [] : comments.filter((c) => c.parentId === comment.id));

  // --- Text: the five-line clamp and "voir plus" ---------------------------------------------
  let expanded = $state(false);
  /** Whether the text is really cut by the clamp (measured, see `reportLineClamp`). */
  let clipped = $state(false);

  // --- Inline edit -----------------------------------------------------------------------------
  let editing = $state(false);
  let editingText = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (editing && editInputEl) void tick().then(() => editInputEl?.focus());
  });

  function startEdit() {
    editing = true;
    editingText = comment.text;
    onEditStart?.();
  }

  function cancelEdit() {
    editing = false;
    editingText = '';
  }

  async function submitEdit() {
    const text = editingText.trim();
    if (!text) return;
    await onEdit(comment.id, text);
    cancelEdit();
  }

  function handleEditKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitEdit();
    }
    if (e.key === 'Escape') cancelEdit();
  }

  /** A delete takes the comment's replies with it, so it asks first: a stray tap used to remove a thread. */
  async function confirmDelete() {
    const confirmed = await showConfirm(m.post_comment_delete_confirm(), {
      danger: true,
      confirmLabel: m.common_delete_button(),
    });
    if (confirmed) await onDelete(comment.id);
  }

  // --- Replies: folded from FOLD_REPLIES_FROM, opened by the reader, by a notification or by a send ---
  let repliesOpen = $state(false);
  const foldable = $derived(replies.length >= FOLD_REPLIES_FROM);
  /** A reply the reader just wrote, or was told about, is never hidden behind the fold. */
  const mustShowReplies = $derived(
    replies.some((r) => r.id === focusCommentId || (pendingCommentIds?.has(r.id) ?? false))
  );
  const showReplies = $derived(!foldable || repliesOpen || mustShowReplies);
</script>

<div
  id={commentAnchorId(comment.id)}
  data-focused={isFocused || undefined}
  class="flex scroll-mt-24 items-start gap-2.5 {isReply ? 'mt-3' : 'mt-5'} {isPending
    ? 'opacity-60'
    : ''}"
>
  {#snippet avatar()}
    <CommentAuthorAvatar {comment} />
  {/snippet}

  {#if authorHref}
    <a
      href={authorHref}
      class="mt-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      {@render avatar()}
    </a>
  {:else}
    <span class="mt-0.5 shrink-0">{@render avatar()}</span>
  {/if}

  <div class="min-w-0 flex-1">
    {#if editing}
      <!-- Inline edit mode. -->
      <div
        class="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-amber-500/40 bg-black/5 px-3.5 py-2.5 dark:bg-white/5"
      >
        <input
          type="text"
          bind:this={editInputEl}
          bind:value={editingText}
          maxlength={COMMENT_MAX_LENGTH}
          onkeydown={handleEditKeyDown}
          class="text-text-main flex-1 bg-transparent text-sm font-medium outline-none"
        />
        <button
          type="button"
          onclick={submitEdit}
          class="ui-icon-button ui-icon-button--sm shrink-0 text-amber-500 outline-none hover:text-amber-400"
          aria-label={m.common_validate_button()}
        >
          <Send size={15} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onclick={cancelEdit}
          class="ui-icon-button ui-icon-button--sm text-text-muted hover:text-text-main shrink-0 outline-none"
          aria-label={m.common_cancel_button()}
        >
          <X size={15} strokeWidth={2.5} />
        </button>
      </div>
    {:else}
      <!-- The comment a notification tap opened the post at carries a ring: the bubble only, so
           a focused comment does not mark the replies drawn under it. -->
      <div
        class="w-fit max-w-full rounded-3xl bg-black/5 px-3.5 py-2 dark:bg-white/10 {isFocused
          ? 'ring-2 ring-amber-500/60'
          : ''}"
      >
        {#if authorHref}
          <a
            href={authorHref}
            class="text-text-main mb-0.5 block text-xs font-bold transition-colors outline-none hover:text-amber-500 focus-visible:underline"
          >
            <EmojiText text={authorName} />
          </a>
        {:else}
          <span class="text-text-main mb-0.5 block text-xs font-bold">
            <EmojiText text={authorName} />
          </span>
        {/if}
        {#if revealedAuthorId}
          <RevealedAuthorLine userId={revealedAuthorId} class="text-text-muted mb-0.5" />
        {/if}
        {#if isReply}
          <!-- "In reply to" badge on rendered replies. -->
          {@const parentComment = comments.find((c) => c.id === comment.parentId)}
          {#if parentComment}
            <span
              class="text-text-muted text-2xs mb-1 flex items-center gap-1 font-semibold opacity-75"
            >
              <CornerDownRight size={11} />
              <EmojiText text={commentAuthorName(parentComment)} />
            </span>
          {/if}
        {/if}
        {#if comment.text}
          <div
            use:reportLineClamp={{
              active: !expanded,
              text: comment.text,
              onMeasure: (isClipped) => (clipped = isClipped),
            }}
            class="post-markdown text-text-main text-sm leading-snug wrap-break-word [&_p]:m-0 [&_p]:inline {expanded
              ? ''
              : 'line-clamp-5'}"
          >
            <SvelteMarkdown
              source={preprocessPostMarkdown(comment.text)}
              renderers={POST_MARKDOWN_RENDERERS}
              options={{ gfm: true, breaks: true }}
            />
          </div>
          {#if clipped || expanded}
            <button
              type="button"
              onclick={() => (expanded = !expanded)}
              class="text-primary text-2xs mt-0.5 font-semibold outline-none hover:underline focus-visible:underline"
            >
              {expanded ? m.post_voir_moins() : m.post_voir_plus()}
            </button>
          {/if}
        {/if}
        {#if comment.media && authToken}
          <CommentMedia media={comment.media} {authToken} />
        {/if}
      </div>
    {/if}

    <div class="mt-1 flex items-center gap-x-4 px-2">
      <span
        class="text-text-muted text-2xs font-bold opacity-80"
        title={exactDate(comment.createdAt)}
        >{timeAgo(
          comment.createdAt
        )}{#if comment.editedAt}&nbsp;·&nbsp;{m.post_comment_edited_label()}{/if}</span
      >

      <!-- WITHHELD WHILE THE ROW IS PENDING: every one of these names the comment's id to the
           server, and a pending row's id is local. The reader sees the comment; they simply cannot
           act on it until it exists. `tap-target` gives each small control a 44px hit box on a touch
           screen without changing how it is drawn. -->
      {#if !isPending}
        <button
          type="button"
          onclick={() => onReply(comment)}
          class="tap-target text-text-muted hover:text-text-main text-2xs font-bold transition-colors outline-none focus-visible:underline"
        >
          {m.post_reply_label()}
        </button>

        {#if comment.canEdit && !editing}
          <button
            type="button"
            onclick={startEdit}
            class="tap-target text-text-muted text-2xs font-bold transition-colors outline-none hover:text-amber-500"
            aria-label={m.common_edit_label()}
          >
            <Pencil size={12} strokeWidth={2.5} />
          </button>
        {/if}
        {#if comment.canDelete}
          <button
            type="button"
            onclick={confirmDelete}
            class="tap-target text-text-muted text-2xs font-bold transition-colors outline-none hover:text-red-500"
            aria-label={m.common_delete_button()}
          >
            <Trash2 size={12} strokeWidth={2.5} />
          </button>
        {/if}
        {#if !comment.canEdit && onReport}
          <button
            type="button"
            onclick={() => onReport?.(comment.id)}
            class="tap-target text-text-muted text-2xs font-bold transition-colors outline-none hover:text-red-400"
            aria-label={m.post_report_comment_label()}
            title={m.post_report_label()}
          >
            <Flag size={11} strokeWidth={2.5} />
          </button>
        {/if}

        <CommentLikeButton
          {liked}
          count={likeCount}
          onLike={() => onLike(comment.id)}
          class="ml-auto"
        />
      {/if}
    </div>

    {#if replies.length > 0}
      {#if foldable && !mustShowReplies}
        <button
          type="button"
          onclick={() => (repliesOpen = !repliesOpen)}
          class="tap-target text-text-muted hover:text-text-main text-2xs mt-1 ml-2 flex items-center gap-1.5 font-bold transition-colors outline-none focus-visible:underline"
          aria-expanded={showReplies}
        >
          {#if showReplies}
            <ChevronUp size={14} strokeWidth={2.5} />
            {m.post_comment_hide_replies_label()}
          {:else}
            <ChevronDown size={14} strokeWidth={2.5} />
            {m.post_comment_show_replies_label({ count: replies.length })}
          {/if}
        </button>
      {/if}
      {#if showReplies}
        <div class="mt-1 ml-1 pl-3">
          {#each replies as reply (reply.id)}
            <CommentItem
              comment={reply}
              isReply
              {comments}
              {currentUserId}
              {authToken}
              {pendingCommentIds}
              {focusCommentId}
              {onLike}
              {onReply}
              {onEditStart}
              {onEdit}
              {onDelete}
              {onReport}
            />
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
