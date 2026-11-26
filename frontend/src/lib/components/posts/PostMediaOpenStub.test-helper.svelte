<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';

  /**
   * Stands in for `PostMedia`: a button that does what a touch on the media does - `onOpen` - and
   * says which media it draws, whether it was asked to fill its box (`letterbox`) and whether it
   * was asked for a compact document row (`compact`).
   */
  let {
    onOpen,
    media,
    letterbox = false,
    deferred = false,
    compact = false,
    postInfo,
    onLoaded,
  }: {
    onOpen?: () => void;
    media?: { mediaId: string };
    letterbox?: boolean;
    deferred?: boolean;
    compact?: boolean;
    postInfo?: { senderName?: string; sentAt?: string };
    onLoaded?: (url: string) => void;
  } = $props();
</script>

<button
  type="button"
  data-post-media-open
  data-media-id={media?.mediaId}
  data-letterbox={letterbox ? 'true' : 'false'}
  data-deferred={deferred ? 'true' : 'false'}
  data-compact={compact ? 'true' : 'false'}
  data-info-sender={postInfo?.senderName}
  data-info-sent={postInfo?.sentAt}
  onclick={() => onOpen?.()}>open</button
>
{#if onLoaded}
  <Button data-post-media-loaded onclick={() => onLoaded('blob:loaded')}>loaded</Button>
{/if}
