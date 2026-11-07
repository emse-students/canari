<script lang="ts">
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
  }: {
    onOpen?: () => void;
    media?: { mediaId: string };
    letterbox?: boolean;
    deferred?: boolean;
    compact?: boolean;
  } = $props();
</script>

<button
  type="button"
  data-post-media-open
  data-media-id={media?.mediaId}
  data-letterbox={letterbox ? 'true' : 'false'}
  data-deferred={deferred ? 'true' : 'false'}
  data-compact={compact ? 'true' : 'false'}
  onclick={() => onOpen?.()}>open</button
>
