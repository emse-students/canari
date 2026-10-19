<script lang="ts">
  /**
   * Stands in for `PostMedia` in gallery mode with Canari's REAL player and no download: what a
   * reel's tap reaches, so the double-tap tests can see the player's own single tap still work.
   */
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
</script>

<VideoPlayer src="blob:reel" class="h-full w-full" />
