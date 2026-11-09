<script lang="ts">
  import { Play } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * THE BIG PLAY BUTTON - drawn only when it answers "is this playing?": a chat video before its
   * first play, a paused viewer, an autoplay the engine refused (owner, 2026-11-09).
   *
   * GLASS, WHITE, NEVER AMBER. The old disc was a solid `--cn-yellow` sticker with a shadow: it hid the
   * thumbnail and shouted the brand over every clip. It was made opaque amber after a scrim disc took
   * the hue of a green clip (2026-10-01); here the DISC may take the frame's colour through its blur -
   * that is what glass is - but the glyph is white with a drop shadow over a dark tint, so the state
   * is carried by the shape and stays legible on any frame. Centred, 64px (72px on a full-screen reel).
   */
  interface Props {
    onclick: () => void;
    /** `lg` on a whole-screen reel. */
    size?: 'md' | 'lg';
    /** Out of the tab order where the bar repeats it for the keyboard. */
    tabindex?: number;
  }

  let { onclick, size = 'md', tabindex }: Props = $props();
</script>

<button
  type="button"
  class="glass-video video-play-disc absolute top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-black active:scale-95 motion-reduce:transition-none {size ===
  'lg'
    ? 'h-18 w-18'
    : 'h-16 w-16'}"
  aria-label={m.video_play_label()}
  data-glass={videoGlass()}
  data-video-controls
  data-video-play-disc
  {tabindex}
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => {
    e.stopPropagation();
    onclick();
  }}
>
  <Play
    size={size === 'lg' ? 32 : 28}
    strokeWidth={2.25}
    fill="currentColor"
    class="ml-1 drop-shadow"
  />
</button>

<style>
  /* Pops in where it appears, so a pause reads as a change rather than a sticker; none when the
     reader asked for less motion. Opacity and transform only - the blur itself is never animated. */
  .video-play-disc {
    animation: video-play-disc-in 150ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .video-play-disc {
      animation: none;
    }
  }
  @keyframes video-play-disc-in {
    /* `scale`, not `transform`: the centring is Tailwind's `translate` property, which a transform
       here would be added to rather than replace. */
    from {
      opacity: 0;
      scale: 0.85;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }
</style>
