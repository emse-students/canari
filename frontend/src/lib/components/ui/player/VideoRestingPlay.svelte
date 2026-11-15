<script lang="ts">
  import { Play } from '@lucide/svelte';

  /**
   * THE PLAY TRIANGLE THAT IS ALWAYS ON SCREEN WHILE NOTHING PLAYS - a poster's, a chat video's, a
   * tile's (owner, 2026-11-15: ONE hybrid art direction on every platform). A RESTING control is
   * FLAT: a bare white lucide glyph with a drop shadow, no blur, no chip - the feed's quiet speaker
   * is the same family. The glass is for what appears on interaction (the bar, the slider, the time
   * bubble, the gesture's pop: `VideoGlassGlyph`), which also means a resting triangle costs no
   * backdrop blur over a decoder on any GPU.
   *
   * It replaced the glass triangle (owner, 2026-11-09), which drew the blur permanently.
   * `size` is the side of the box it fills, so every call site keeps its old footprint; decorative:
   * the caller wraps it in the button or the link.
   */
  interface Props {
    /** The side of the square box, in px. */
    size: number;
    class?: string;
  }

  let { size, class: className = '' }: Props = $props();
</script>

<span
  class="pointer-events-none relative flex shrink-0 items-center justify-center text-white {className}"
  style="width: {size}px; height: {size}px"
  aria-hidden="true"
  data-video-resting-play
>
  <Play
    size={Math.round(size * 0.7)}
    strokeWidth={2}
    fill="currentColor"
    class="ml-[6%] drop-shadow-md"
  />
</span>
