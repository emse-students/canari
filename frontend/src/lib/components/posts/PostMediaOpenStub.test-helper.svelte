<script lang="ts">
  /**
   * Stands in for `PostMedia`: a button that does what a touch on the media does - `onOpen` - and
   * says which media it draws and whether it was asked to fill its box (`letterbox`).
   */
  let {
    onOpen,
    media,
    letterbox = false,
  }: { onOpen?: () => void; media?: { mediaId: string }; letterbox?: boolean } = $props();
</script>

<button
  type="button"
  data-post-media-open
  data-media-id={media?.mediaId}
  data-letterbox={letterbox ? 'true' : 'false'}
  onclick={() => onOpen?.()}>open</button
>
