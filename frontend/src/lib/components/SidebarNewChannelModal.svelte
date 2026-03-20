<script lang="ts">
  import Modal from './Modal.svelte';

  interface Props {
    open: boolean;
    channelName: string;
    onClose: () => void;
    onChannelNameChange: (value: string) => void;
    onSubmitChannel: () => void;
  }

  let { open, channelName, onClose, onChannelNameChange, onSubmitChannel }: Props = $props();
</script>

<Modal {open} {onClose} title="Nouveau canal">
  <div class="space-y-4 pt-2">
    <div>
      <label for="new-channel-name" class="block text-sm font-medium text-text-main mb-1"
        >Nom du canal</label
      >
      <input
        id="new-channel-name"
        type="text"
        value={channelName}
        oninput={(e) => onChannelNameChange((e.target as HTMLInputElement).value)}
        placeholder="ex: Général"
        class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        onkeydown={(e) => e.key === 'Enter' && onSubmitChannel()}
        autofocus
      />
    </div>
    <button
      onclick={onSubmitChannel}
      disabled={!channelName.trim()}
      class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Créer le canal
    </button>
  </div>
</Modal>
