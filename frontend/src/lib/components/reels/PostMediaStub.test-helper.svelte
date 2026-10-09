<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * Stands in for `PostMedia` in the reel viewer tests: which media would play, nothing fetched.
   * It draws the player bar's extra controls, as the real player does beside its volume button.
   */
  let { media, barActions }: { media: { mediaId: string }; barActions?: Snippet } = $props();
</script>

<div data-post-media-stub={media.mediaId}>{@render barActions?.()}</div>
