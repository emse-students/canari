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
    class?: string;
  }

  let { muted, onToggle, glass = true, disabled = false, class: klass = '' }: Props = $props();
</script>

<VideoChipButton
  label={m.video_sound_label()}
  pressed={!muted}
  onclick={onToggle}
  {glass}
  {disabled}
  class={klass}
>
  {#if muted}
    <VolumeX size={glass ? 16 : 20} strokeWidth={2.25} class="drop-shadow" data-video-sound="off" />
  {:else}
    <Volume2
      size={glass ? 16 : 20}
      strokeWidth={2.25}
      class="text-cn-yellow drop-shadow"
      data-video-sound="on"
    />
  {/if}
</VideoChipButton>
