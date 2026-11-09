<script lang="ts" module>
  /** What a gesture just did, as the glyph draws it. */
  export type VideoFeedbackKind = 'play' | 'pause' | 'sound-on' | 'sound-off';
</script>

<script lang="ts">
  import { Pause, Play, Volume2, VolumeX } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * THE FEEDBACK OF A GESTURE, NEVER A STATE (user, 2026-10-23; owner, 2026-11-09): the icon of what
   * the reader's tap, hold or key just did - sound on, sound off, paused, playing - popping in the
   * centre and fading in 600 ms, then gone. Nothing at load, at autoplay or at the end. Never a target.
   *
   * NO TIMER: the fade is a CSS animation that ends invisible; a new gesture remounts it through its
   * `n`. Hidden under `prefers-reduced-motion` - a reader who asked for no motion still has the
   * speaker's state and the announcement below.
   *
   * A SOUND CHANGE IS ANNOUNCED (`aria-live="polite"`) because it is the reader's own action and the
   * picture gives no other cue to a screen reader; an autoplay never is.
   */
  interface Props {
    /** What just happened, and a counter that makes the same kind twice pop twice. */
    feedback: { kind: VideoFeedbackKind; n: number } | null;
  }

  let { feedback }: Props = $props();

  const announcement = $derived(
    feedback?.kind === 'sound-on'
      ? m.video_sound_on_announce()
      : feedback?.kind === 'sound-off'
        ? m.video_sound_off_announce()
        : ''
  );
</script>

<span class="sr-only" aria-live="polite">{announcement}</span>

{#key feedback?.n}
  {#if feedback}
    <div
      class="glass-video video-feedback-glyph pointer-events-none absolute top-1/2 left-1/2 z-30 flex items-center justify-center rounded-full motion-reduce:hidden {feedback.kind ===
        'play' || feedback.kind === 'pause'
        ? 'h-16 w-16'
        : 'h-12 w-12'}"
      data-glass={videoGlass()}
      aria-hidden="true"
      data-video-glyph={feedback.kind}
    >
      {#if feedback.kind === 'pause'}
        <Pause size={28} strokeWidth={2.25} fill="currentColor" class="drop-shadow" />
      {:else if feedback.kind === 'play'}
        <Play size={28} strokeWidth={2.25} fill="currentColor" class="ml-1 drop-shadow" />
      {:else if feedback.kind === 'sound-on'}
        <Volume2 size={22} strokeWidth={2.25} class="text-cn-yellow drop-shadow" />
      {:else}
        <VolumeX size={22} strokeWidth={2.25} class="drop-shadow" />
      {/if}
    </div>
  {/if}
{/key}

<style>
  /* Pops in, fades out, and ends invisible. `transform` carries the centring here (no Tailwind
     translate on this element), so the keyframes hold it at every step. */
  .video-feedback-glyph {
    animation: video-feedback-pop 600ms ease-out forwards;
  }
  @keyframes video-feedback-pop {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.7);
    }
    25% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(1.15);
    }
  }
</style>
