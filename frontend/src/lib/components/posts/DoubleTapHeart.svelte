<script lang="ts">
  /**
   * THE HEART A DOUBLE TAP DRAWS WHERE THE FINGER LANDED (`doubleTapLike`), over a post card or a
   * reel. It is the "J'aime" reaction's own picture - Noto's heart through `EmojiText`, the glyph
   * the reaction bar draws - so what flies up is what the post now carries.
   *
   * Each burst lives exactly as long as its animation: `animationend` removes it, never a timer.
   * Reduced motion keeps a short fade in place and no movement (`.double-tap-heart` in `app.css`,
   * which deliberately outranks the global rule that would otherwise make it end before a frame).
   *
   * Decoration only (`aria-hidden`): the like itself is announced where it always was, on the
   * reaction button.
   */
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { DOUBLE_TAP_REACTION } from '$lib/posts/postReaction';
  import { reactionTypeToEmoji } from '$lib/posts/reactions';
  import { hapticTick } from '$lib/utils/haptics';

  /** A light tick: the like is felt as well as seen (Android; iOS WebKit cannot vibrate). */
  const LIKE_HAPTIC_MS = 12;

  const emoji = reactionTypeToEmoji(DOUBLE_TAP_REACTION);

  let bursts = $state<{ id: number; x: number; y: number }[]>([]);
  let nextId = 0;

  /** Draws one heart at `at`, in the layer's own coordinates, and ticks the haptic. */
  export function burst(at: { x: number; y: number }) {
    bursts = [...bursts, { id: nextId++, x: at.x, y: at.y }];
    hapticTick(LIKE_HAPTIC_MS);
  }

  function done(id: number) {
    bursts = bursts.filter((b) => b.id !== id);
  }
</script>

<div class="pointer-events-none absolute inset-0 z-30" aria-hidden="true" data-double-tap-hearts>
  {#each bursts as b (b.id)}
    <span
      class="double-tap-heart"
      style:left="{b.x}px"
      style:top="{b.y}px"
      onanimationend={() => done(b.id)}
      data-double-tap-heart><EmojiText text={emoji} /></span
    >
  {/each}
</div>
