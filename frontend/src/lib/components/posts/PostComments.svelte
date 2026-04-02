<script lang="ts">
  import { ChevronDown, ChevronUp, Send } from 'lucide-svelte';
  import type { PostComment } from '$lib/posts/api';

  interface Props {
    comments: PostComment[];
    topLevelComments: PostComment[];
    showComments: boolean;
    commentText: string;
    submittingComment: boolean;
    currentUserId: string;
    onToggleComments: () => void;
    onCommentTextChange: (text: string) => Promise<void>;
    onAddComment: () => Promise<void>;
    onLikeComment: (commentId: string) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  }

  let {
    comments,
    topLevelComments,
    showComments,
    commentText,
    submittingComment,
    currentUserId,
    onToggleComments,
    onCommentTextChange,
    onAddComment,
    onLikeComment,
    onKeyDown,
  }: Props = $props();

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'à l\u2019instant';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `il y a ${diffD}j`;
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
</script>

{#if comments.length > 0 || showComments}
  <div class="border-t border-cn-border/40 px-5 py-3">
    {#if topLevelComments.length > 2 && !showComments}
      <button
        type="button"
        onclick={onToggleComments}
        class="text-xs text-text-muted hover:text-text-main mb-2 flex items-center gap-1"
      >
        <ChevronDown size={14} />
        Voir les {topLevelComments.length} commentaires
      </button>
    {/if}

    {#if showComments}
      <button
        type="button"
        onclick={onToggleComments}
        class="text-xs text-text-muted hover:text-text-main mb-2 flex items-center gap-1"
      >
        <ChevronUp size={14} />
        Masquer les commentaires
      </button>
    {/if}

    <div class="space-y-2">
      {#each showComments ? topLevelComments : topLevelComments.slice(-2) as comment (comment.id)}
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <p class="text-sm">
              <span class="font-bold text-text-main mr-1"
                >{comment.displayName || comment.userId}</span
              >
              <span class="text-text-main">{comment.text}</span>
            </p>
            <div class="flex items-center gap-3 mt-0.5">
              <span class="text-[0.65rem] text-text-muted">{timeAgo(comment.createdAt)}</span>
              <button
                type="button"
                onclick={() => onLikeComment(comment.id)}
                class="text-[0.65rem] font-semibold {comment.likes?.includes(currentUserId)
                  ? 'text-red-500'
                  : 'text-text-muted hover:text-text-main'} transition-colors"
              >
                {#if comment.likes?.length}
                  {comment.likes.length} J'aime
                {:else}
                  J'aime
                {/if}
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <div class="flex items-center gap-2 mt-3 pt-3 border-t border-cn-border/30">
      <input
        type="text"
        value={commentText}
        onchange={(e) => onCommentTextChange(e.currentTarget.value)}
        placeholder="Ajouter un commentaire..."
        class="flex-1 bg-transparent text-sm text-text-main placeholder:text-text-muted outline-none"
        onkeydown={onKeyDown}
      />
      <button
        type="button"
        onclick={onAddComment}
        disabled={!commentText.trim() || submittingComment}
        class="text-cn-yellow hover:text-cn-yellow-hover disabled:opacity-30 transition-colors"
        aria-label="Envoyer le commentaire"
      >
        <Send size={18} />
      </button>
    </div>
  </div>
{:else}
  <div class="border-t border-cn-border/40 px-5 py-3">
    <div class="flex items-center gap-2">
      <input
        type="text"
        value={commentText}
        onchange={(e) => onCommentTextChange(e.currentTarget.value)}
        placeholder="Ajouter un commentaire..."
        class="flex-1 bg-transparent text-sm text-text-main placeholder:text-text-muted outline-none"
        onkeydown={onKeyDown}
      />
      <button
        type="button"
        onclick={onAddComment}
        disabled={!commentText.trim() || submittingComment}
        class="text-cn-yellow hover:text-cn-yellow-hover disabled:opacity-30 transition-colors"
        aria-label="Envoyer le commentaire"
      >
        <Send size={18} />
      </button>
    </div>
  </div>
{/if}
