<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import VideoGlassGlyph from './VideoGlassGlyph.svelte';

  /**
   * THE BIG PLAY BUTTON - drawn only when it answers "is this playing?": a chat video before its
   * first play, a paused viewer, an autoplay the engine refused (owner, 2026-11-09).
   *
   * THE TRIANGLE IS THE GLASS, AND THERE IS NO DISC (owner, 2026-11-09: *"J'aurais juste fait le
   * triangle en liquid glass"*; before it, the solid `--cn-yellow` sticker that hid the thumbnail and
   * shouted the brand over every clip, then a glass disc around a white glyph). The shape is
   * {@link VideoGlassGlyph}: the video's blur and dark tint inside a rounded triangle, a light rim on
   * its top-left edge, a soft shadow, so the state is carried by the shape and stays legible on a
   * white frame and a black one.
   *
   * THE HIT TARGET IS THE SQUARE, NOT THE TRIANGLE: the button is 64 px (72 px `lg`) and invisible,
   * so the 44 px minimum holds whatever the glyph draws. Centred.
   */
  interface Props {
    onclick: () => void;
    /** `lg` on a whole-screen reel. */
    size?: 'md' | 'lg';
    /** Out of the tab order where the bar repeats it for the keyboard. */
    tabindex?: number;
  }

  let { onclick, size = 'md', tabindex }: Props = $props();

  const side = $derived(size === 'lg' ? 72 : 64);
</script>

<button
  type="button"
  class="video-play-glyph absolute top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-white outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-black active:scale-95 motion-reduce:transition-none"
  style="width: {side}px; height: {side}px"
  aria-label={m.video_play_label()}
  data-video-controls
  data-video-play-glyph
  {tabindex}
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => {
    e.stopPropagation();
    onclick();
  }}
>
  <VideoGlassGlyph kind="play" size={side} />
</button>

<style>
  /* Pops in where it appears, so a pause reads as a change rather than a sticker; none when the
     reader asked for less motion. Opacity and transform only - the blur itself is never animated. */
  .video-play-glyph {
    animation: video-play-glyph-in 150ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .video-play-glyph {
      animation: none;
    }
  }
  @keyframes video-play-glyph-in {
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
