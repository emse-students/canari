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
  <div class="flex gap-4 border-b border-cn-border mb-4 pb-2">
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'contact'
        ? 'text-text-main border-b-2 border-cn-yellow'
        : 'text-text-muted hover:text-text-main'}"
      onclick={() => onTabChange('contact')}
    >
      Contact
    </button>
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'group'
        ? 'text-text-main border-b-2 border-cn-yellow'
        : 'text-text-muted hover:text-text-main'}"
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
          class="w-full px-4 py-2 bg-cn-bg rounded-xl text-sm outline-none focus:ring-2 focus:ring-cn-yellow/50"
          onkeydown={(e) => e.key === 'Enter' && onSubmitContact()}
        />
      </div>
      <button
        onclick={onSubmitContact}
        disabled={!contactId.trim()}
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Demarrer la discussion
      </button>
    </div>
  {:else}
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
          class="w-full px-4 py-2 bg-cn-bg rounded-xl text-sm outline-none focus:ring-2 focus:ring-cn-yellow/50"
          onkeydown={(e) => e.key === 'Enter' && onSubmitGroup()}
        />
      </div>
      <button
        onclick={onSubmitGroup}
        disabled={!groupName.trim()}
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Creer le groupe
      </button>
    </div>
  {/if}
</Modal>
