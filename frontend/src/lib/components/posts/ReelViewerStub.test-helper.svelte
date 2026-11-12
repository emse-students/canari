<script lang="ts">
  import { onDestroy } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { handBackVideoPosition } from '$lib/utils/videoResume';

  /**
   * Stands in for `ReelViewer`: which reel it was opened on, and on which media of a carousel; the
   * order switch it was handed (`data-order`, absent with none), whose buttons call its `onChange`;
   * and `loadFirst`, which asks its loader for the first page as the viewer would. Its teardown
   * hands back 9 s for its first media, as the real viewer's players do (`videoResume`).
   */
  let {
    startPost,
    startMediaIndex = 0,
    onClose,
    loadPage,
    orderChoice,
  }: {
    startPost: { id: string; media?: { mediaId: string }[] };
    startMediaIndex?: number;
    onClose?: () => void;
    loadPage?: (offset: number, limit: number) => Promise<unknown[]>;
    orderChoice?: { value: string; onChange: (order: 'ranked' | 'recent') => void };
  } = $props();

  onDestroy(() => {
    const first = startPost.media?.[0];
    if (first) handBackVideoPosition(first.mediaId, 9);
  });
</script>

<div
  data-reel-viewer-stub={startPost.id}
  data-start-media-index={startMediaIndex}
  data-order={orderChoice?.value}
>
  <Button data-reel-viewer-close onclick={() => onClose?.()}>close</Button>
  <Button data-reel-viewer-load-first onclick={() => void loadPage?.(0, 10)}>load</Button>
  <Button data-reel-viewer-recent onclick={() => orderChoice?.onChange('recent')}>recent</Button>
</div>
