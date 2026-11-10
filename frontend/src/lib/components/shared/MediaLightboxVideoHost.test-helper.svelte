<script lang="ts">
  /**
   * A viewer showing one slide at a time, as a gallery does: a video, another video, or a photo.
   * Each slide is a fresh mount (`{#key}`), so the tests see a player arrive and leave.
   */
  import MediaLightbox from './MediaLightbox.svelte';
  import VideoPlayer from './VideoPlayer.svelte';

  let { slide }: { slide: 'video-a' | 'video-b' | 'image' } = $props();
</script>

<MediaLightbox open onClose={() => {}}>
  {#key slide}
    {#if slide === 'image'}
      <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    {:else}
      <VideoPlayer src={`blob:${slide}`} class="h-full w-full" />
    {/if}
  {/key}
</MediaLightbox>
