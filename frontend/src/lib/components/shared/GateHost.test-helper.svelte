<script lang="ts">
  /** The PIN lock as `ChatBackgroundService` mounts it: a `Modal` on the pinned `PinModal` gate. */
  import Modal from './Modal.svelte';
</script>

<Modal open gate="PinModal" title="PIN" onClose={() => {}}>
  <p>pin</p>
</Modal>
