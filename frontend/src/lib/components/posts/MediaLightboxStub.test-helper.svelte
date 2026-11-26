<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';

  /** Stands in for `MediaLightbox`: says which media it was opened at, out of how many. */
  let {
    dotIndex = 0,
    dotCount = 0,
    onDownload,
    onNext,
    children,
  }: {
    dotIndex?: number;
    dotCount?: number;
    onDownload?: () => void;
    onNext?: () => void;
    children?: Snippet;
  } = $props();
</script>

<div data-lightbox data-dot-index={dotIndex} data-dot-count={dotCount}>
  {@render children?.()}
  {#if onDownload}<Button data-lightbox-download onclick={() => onDownload()}>download</Button>{/if}
  <Button data-lightbox-next onclick={() => onNext?.()}>next</Button>
</div>
