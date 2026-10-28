<script lang="ts">
  /**
   * Stands in for `PostShareSheet` in the viewer's tests: it says which post it was opened on, and
   * its one button stands for a conversation tapped in the grid whose landing was published.
   */
  let {
    open,
    postId,
    onClose,
    onSentInApp,
  }: { open: boolean; postId: string; onClose: () => void; onSentInApp?: () => void } = $props();
</script>

{#if open}
  <div data-share-sheet={postId}>
    <button
      type="button"
      data-share-sent
      onclick={() => {
        onClose();
        onSentInApp?.();
      }}>sent</button
    >
  </div>
{/if}
