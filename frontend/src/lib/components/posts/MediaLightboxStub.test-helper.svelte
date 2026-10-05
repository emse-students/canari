<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Stands in for `MediaLightbox`: says which media it was opened at, out of how many. */
  let {
    dotIndex = 0,
    dotCount = 0,
    children,
  }: { dotIndex?: number; dotCount?: number; children?: Snippet } = $props();
</script>

<div data-lightbox data-dot-index={dotIndex} data-dot-count={dotCount}>
  {@render children?.()}
</div>
