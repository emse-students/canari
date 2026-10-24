<script lang="ts">
  /**
   * Stands in for `PostMedia` in the reel viewer tests: which media would play, nothing fetched.
   * It says whether the minimal reel player was asked for.
   */
  let { media, minimalPlayer }: { media: { mediaId: string }; minimalPlayer?: boolean } = $props();
</script>

<div
  data-post-media-stub={media.mediaId}
  data-minimal-player={minimalPlayer ? '' : undefined}
></div>
