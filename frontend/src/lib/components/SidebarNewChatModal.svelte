<script lang="ts">
  import Modal from './Modal.svelte';

  interface Props {
    open: boolean;
    activeTab: 'contact' | 'group';
    contactId: string;
    groupName: string;
    onClose: () => void;
    onTabChange: (tab: 'contact' | 'group') => void;
    onContactIdChange: (value: string) => void;
    onGroupNameChange: (value: string) => void;
    onSubmitContact: () => void;
    onSubmitGroup: () => void;
  }

  let {
    open,
    activeTab,
    contactId,
    groupName,
    onClose,
    onTabChange,
    onContactIdChange,
    onGroupNameChange,
    onSubmitContact,
    onSubmitGroup,
  }: Props = $props();
</script>

<Modal {open} {onClose} title="Nouvelle discussion">
  <div
    class="flex gap-2 rounded-2xl bg-white/45 dark:bg-black/25 border border-white/50 dark:border-white/10 p-1 mb-4"
  >
    <button
      class="flex-1 px-3 py-2 text-sm font-semibold rounded-xl transition-colors {activeTab ===
      'contact'
        ? 'bg-white/80 dark:bg-black/40 text-text-main border border-white/60 dark:border-white/10'
        : 'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30'}"
      onclick={() => onTabChange('contact')}
    >
      Contact
    </button>
    <button
      class="flex-1 px-3 py-2 text-sm font-semibold rounded-xl transition-colors {activeTab ===
      'group'
        ? 'bg-white/80 dark:bg-black/40 text-text-main border border-white/60 dark:border-white/10'
        : 'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30'}"
      onclick={() => onTabChange('group')}
    >
      Groupe
    </button>
  </div>

  {#if activeTab === 'contact'}
    <div class="space-y-4">
      <div>
        <label for="new-contact-id" class="block text-sm font-medium text-text-main mb-1"
          >Identifiant du contact</label
        >
        <input
          id="new-contact-id"
          type="text"
          value={contactId}
          oninput={(e) => onContactIdChange((e.target as HTMLInputElement).value)}
          placeholder="ex: alice"
          class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
          onkeydown={(e) => e.key === 'Enter' && onSubmitContact()}
        />
      </div>
      <button
        onclick={onSubmitContact}
        disabled={!contactId.trim()}
        class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Demarrer la discussion
      </button>
    </div>
  {:else if activeTab === 'group'}
    <div class="space-y-4">
      <div>
        <label for="new-group-name" class="block text-sm font-medium text-text-main mb-1"
          >Nom du groupe</label
        >
        <input
          id="new-group-name"
          type="text"
          value={groupName}
          oninput={(e) => onGroupNameChange((e.target as HTMLInputElement).value)}
          placeholder="ex: Projet X"
          class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
          onkeydown={(e) => e.key === 'Enter' && onSubmitGroup()}
        />
      </div>
      <button
        onclick={onSubmitGroup}
        disabled={!groupName.trim()}
        class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Creer le groupe
      </button>
    </div>
  {/if}
</Modal>
