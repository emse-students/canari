<script lang="ts">
  /** Stands in for `PostMedia` in the reel viewer tests: which media would play, nothing fetched. */
  let { media }: { media: { mediaId: string } } = $props();
</script>

<div data-post-media-stub={media.mediaId}></div>
