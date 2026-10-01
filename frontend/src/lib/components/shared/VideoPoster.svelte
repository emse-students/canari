<script lang="ts">
  import { Play } from '@lucide/svelte';

  /**
   * WHAT A VIDEO BOX SHOWS UNTIL ITS FIRST FRAME IS DECODED - Canari's colours and a play glyph.
   *
   * WHY (user, 2026-10-01, Mi 9T): the box used to be flat black until the frame arrived. Black is
   * what `TRANSPARENT_VIDEO_POSTER` leaves (`utils/videoPoster.ts`: the element's own `poster` must
   * stay transparent, or the Android WebView draws its grey play button over the whole card), so the
   * picture has to come from BEHIND the element instead. This sits over the `<video>` and the caller
   * removes it on `loadeddata` - the moment the element holds its first frame - so the reader sees
   * the frame itself as soon as there is one, and this gradient only for as long as there is not.
   *
   * Decorative: the player's own controls carry the names, so nothing here is announced.
   */
  interface Props {
    /** Smaller glyph for a box under ~200 px (a chat bubble). */
    compact?: boolean;
  }

  let { compact = false }: Props = $props();
</script>

<div
  class="from-cn-ink to-cn-scrim pointer-events-none absolute inset-0 flex items-center justify-center bg-linear-to-br"
  aria-hidden="true"
>
  <div class="from-cn-yellow/20 absolute inset-0 bg-radial to-transparent to-70%"></div>
  <span
    class="bg-cn-yellow text-cn-ink relative flex items-center justify-center rounded-full shadow-lg {compact
      ? 'h-11 w-11'
      : 'h-14 w-14'}"
  >
    <Play size={compact ? 20 : 26} strokeWidth={2.25} fill="currentColor" class="ml-0.5" />
  </span>
</div>
