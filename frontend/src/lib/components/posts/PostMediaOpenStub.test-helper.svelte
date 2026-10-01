<script lang="ts">
  /** Stands in for `PostMedia`: a button that does what a touch on the video does - `onOpen`. */
  let { onOpen }: { onOpen?: () => void } = $props();
</script>

<button type="button" data-post-media-open onclick={() => onOpen?.()}>open</button>
