<script lang="ts">
  import { Heart } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE ONE LIKE CONTROL OF A COMMENT: a heart with the count beside it when there is one. Drawn by
   * the thread (`CommentItem`) and by the card's collapsed preview (`CommentsPreview`), so the two
   * cannot disagree about how a like looks or reads to a screen reader. `tap-target` gives it a 44px
   * hit box on a touch screen without changing how it is drawn.
   */
  interface Props {
    /** Whether the reader has liked this comment. */
    liked: boolean;
    /** How many people liked it. */
    count: number;
    onLike: () => void;
    class?: string;
  }

  let { liked, count, onLike, class: className = '' }: Props = $props();
</script>

<button
  type="button"
  onclick={onLike}
  aria-pressed={liked}
  aria-label={count > 0 ? m.post_likes_count_label({ count }) : m.post_like_label()}
  class="tap-target text-2xs flex items-center gap-1 font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {liked
    ? 'text-red-500'
    : 'text-text-muted hover:text-text-main'} {className}"
>
  <Heart size={15} strokeWidth={2.25} class={liked ? 'fill-current' : ''} />
  {#if count > 0}<span class="tabular-nums">{count}</span>{/if}
</button>
