<script lang="ts">
  /**
   * Stands in for a full-screen viewer in the layer tests: marks its subtree as the viewer's
   * (`markViewerLayer`) when `inViewer`, and opens one `Modal` and one `ModalOverlay` inside it.
   */
  import Modal from './Modal.svelte';
  import ModalOverlay from './ModalOverlay.svelte';
  import { markViewerLayer } from '$lib/utils/viewerLayer';

  let { inViewer }: { inViewer: boolean } = $props();

  // svelte-ignore state_referenced_locally -- read once, as a viewer marks itself once
  if (inViewer) markViewerLayer();
</script>

<Modal open title="T" onClose={() => {}}>
  <p>modal body</p>
</Modal>
<ModalOverlay open label="L" onClose={() => {}}>
  <p data-overlay-body>overlay body</p>
</ModalOverlay>
