<script lang="ts">
  /** Stands in for `PostShareSheet` in the viewer's tests: it only says which post it was opened on. */
  let { open, postId }: { open: boolean; postId: string; onClose: () => void } = $props();
</script>

{#if open}<div data-share-sheet={postId}></div>{/if}
