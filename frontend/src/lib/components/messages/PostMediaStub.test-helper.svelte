<script lang="ts">
  /** Stands in for `PostMedia`: says which media it was asked to decrypt, and can report a failure. */
  let {
    media,
    onFailure,
  }: { media?: { mediaId: string }; onFailure?: (cause: 'expired' | 'failed') => void } = $props();
</script>

<div data-post-media-stub={media?.mediaId}>
  <button type="button" data-fail-expired onclick={() => onFailure?.('expired')}>x</button>
  <button type="button" data-fail-other onclick={() => onFailure?.('failed')}>y</button>
</div>
