<script lang="ts">
  /**
   * Stands in for a post's comment thread in the layer tests: a `Modal` (desktop) or a page-level
   * `CommentsDrawer` (phone) that opens a `ModalOverlay` from its body, as the comment box opens
   * the GIF picker.
   */
  import CommentsDrawer from './CommentsDrawer.svelte';
  import Modal from './Modal.svelte';
  import ModalOverlay from './ModalOverlay.svelte';

  let { host }: { host: 'modal' | 'drawer' } = $props();
</script>

{#if host === 'drawer'}
  <CommentsDrawer scrim onClose={() => {}}>
    <ModalOverlay open label="L" onClose={() => {}}>
      <p data-overlay-body>overlay body</p>
    </ModalOverlay>
  </CommentsDrawer>
{:else}
  <Modal open title="T" onClose={() => {}}>
    <ModalOverlay open label="L" onClose={() => {}}>
      <p data-overlay-body>overlay body</p>
    </ModalOverlay>
  </Modal>
{/if}
