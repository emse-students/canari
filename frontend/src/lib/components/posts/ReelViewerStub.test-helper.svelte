<script lang="ts">
  import { onDestroy } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { handBackVideoPosition } from '$lib/utils/videoResume';

  /**
   * Stands in for `ReelViewer`: which reel it was opened on, and on which media of a carousel. Its
   * teardown hands back 9 s for its first media, as the real viewer's players do (`videoResume`).
   */
  let {
    startPost,
    startMediaIndex = 0,
    onClose,
  }: {
    startPost: { id: string; media?: { mediaId: string }[] };
    startMediaIndex?: number;
    onClose?: () => void;
  } = $props();

  onDestroy(() => {
    const first = startPost.media?.[0];
    if (first) handBackVideoPosition(first.mediaId, 9);
  });
</script>

<div data-reel-viewer-stub={startPost.id} data-start-media-index={startMediaIndex}>
  <Button data-reel-viewer-close onclick={() => onClose?.()}>close</Button>
</div>
