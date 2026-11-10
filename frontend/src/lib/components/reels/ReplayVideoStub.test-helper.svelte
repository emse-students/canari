<script lang="ts">
  /**
   * Stands in for `VideoPlayer` in the replay pane tests: a real `<video>` element handed to `onVideo`
   * as the shared player does, without the engine's playback.
   */
  import { onMount } from 'svelte';
  let {
    src,
    onVideo,
  }: { src: string; onVideo?: (video: HTMLVideoElement) => (() => void) | void } = $props();
  let el = $state<HTMLVideoElement | null>(null);
  onMount(() => {
    if (el && onVideo) return onVideo(el) ?? undefined;
  });
</script>

<video bind:this={el} data-video-player-stub={src}></video>
