<script lang="ts">
  /** Stands in for `ReelViewer`: which reel it was opened on. */
  let { startPost }: { startPost: { id: string } } = $props();
</script>

<div data-reel-viewer-stub={startPost.id}></div>
