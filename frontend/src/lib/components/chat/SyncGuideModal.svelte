<script lang="ts">
  import Modal from '../shared/Modal.svelte';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called when the modal should close. */
    onClose: () => void;
    /** Called when the user clicks "Ouvrir la synchronisation QR". */
    onOpenQrSync: () => void;
  }

  let { open, onClose, onOpenQrSync }: Props = $props();
</script>

<Modal {open} {onClose} title="Nouveau appareil detecte">
  <div class="space-y-3 text-sm text-text-main">
    <p>
      Pour recuperer vos conversations, lancez une synchronisation QR avec un appareil deja
      connecte.
    </p>
    <ol class="list-decimal list-inside space-y-1 text-text-muted">
      <li>Sur l'appareil principal: ouvrez la synchronisation QR.</li>
      <li>Affichez le QR de transfert.</li>
      <li>Sur ce nouvel appareil: scannez le QR ou collez le payload.</li>
    </ol>
    <button
      onclick={onOpenQrSync}
      class="w-full mt-2 px-3 py-2 rounded-xl bg-cn-dark text-white font-medium hover:bg-gray-800 transition-colors"
    >
      Ouvrir la synchronisation QR
    </button>
  </div>
</Modal>
