<script lang="ts">
  /** Stands in for `ReelViewer`: which reel it was opened on, and on which media of a carousel. */
  let { startPost, startMediaIndex = 0 }: { startPost: { id: string }; startMediaIndex?: number } =
    $props();
</script>

<div data-reel-viewer-stub={startPost.id} data-start-media-index={startMediaIndex}></div>
