<script lang="ts">
  import { Volume2, VolumeX } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import VideoChipButton from './VideoChipButton.svelte';

  /**
   * THE SPEAKER - the one sound button of every video surface (owner, 2026-11-09: the four copies of
   * the feed, the bar, the reel rail and the live corner are this one). Always visible on a playing
   * video, so the tap-for-sound gesture is discoverable: Instagram keeps the same small speaker on
   * the bottom-right of a feed video.
   *
   * The state is the SHAPE (speaker with waves, speaker struck through) and `aria-pressed`; the sound-on
   * glyph alone wears the brand yellow, the only accent the player allows itself besides the played
   * part of a scrubber.
   */
  interface Props {
    muted: boolean;
    onToggle: () => void;
    /** Its own glass chip; off inside a glass bar. */
    glass?: boolean;
    /** A video with no sound to give (`soundScope="silent"`). */
    disabled?: boolean;
    /**
     * `rail`: the reel rail's - a bare 26px glyph beside the heart and the comments, the same
     * button rather than a fourth copy of it. Otherwise 16px in a chip, 20px in a bar.
     */
    rail?: boolean;
    class?: string;
    /** `data-*` markers of the call site. */
    [data: `data-${string}`]: unknown;
  }

  let {
    muted,
    onToggle,
    glass = true,
    disabled = false,
    rail = false,
    class: klass = '',
    ...markers
  }: Props = $props();

  const glyphSize = $derived(rail ? 26 : glass ? 16 : 20);
  const shadow = $derived(rail ? 'drop-shadow-md' : 'drop-shadow');
</script>

<VideoChipButton
  label={m.video_sound_label()}
  title={rail ? m.video_sound_label() : undefined}
  pressed={!muted}
  onclick={onToggle}
  glass={glass && !rail}
  {disabled}
  class={klass}
  {...markers}
>
  {#if muted}
    <VolumeX size={glyphSize} strokeWidth={rail ? 2 : 2.25} class={shadow} data-video-sound="off" />
  {:else}
    <Volume2
      size={glyphSize}
      strokeWidth={rail ? 2 : 2.25}
      class="text-accent {shadow}"
      data-video-sound="on"
    />
  {/if}
</VideoChipButton>
