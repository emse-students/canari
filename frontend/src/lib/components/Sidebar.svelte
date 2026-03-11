<script lang="ts">
  import { Hand, Plus } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';
  import { parseEnvelope, getPreviewText } from '$lib/envelope';
  import Modal from './Modal.svelte';
  import MultiUserSelector from './MultiUserSelector.svelte';

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: any[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  interface Props {
    conversations: Map<string, Conversation>;
    selectedContact: string | null;
    // We can keep these props for backward compatibility if MainChatPage relies on binding them,
    // but we will use internal state for the modals.
    newContactInput?: string;
    newGroupInput?: string;

    onContactInputChange?: (value: string) => void;
    onGroupInputChange?: (value: string) => void;

    // Actions
    onAddContact: (id: string) => void;
    onCreateGroup: (name: string, members: string[]) => void;

    onSelectConversation: (name: string) => void;
    onExport: () => void;
    onImport: (file: File) => void;
    isExporting?: boolean;
    isImporting?: boolean;
    isHidden?: boolean;
    userProfile?: { id: string };
  }

  let {
    conversations,
    selectedContact,
    onAddContact,
    onCreateGroup,
    onSelectConversation,
    onExport,
    onImport,
    isExporting = false,
    isImporting = false,
    isHidden = false,
    userProfile,
  }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();

  // Modal states
  let showNewChatModal = $state(false);
  let activeTab = $state<'contact' | 'group'>('contact');

  // Local form states
  let contactId = $state('');
  let groupName = $state('');
  let groupMembers = $state<string[]>([]);

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      onImport(file);
      input.value = '';
    }
  }

  function handleAddContact() {
    if (contactId.trim()) {
      onAddContact(contactId.trim());
      showNewChatModal = false;
      contactId = '';
    }
  }

  function handleCreateGroup() {
    if (groupName.trim()) {
      onCreateGroup(groupName.trim(), groupMembers);
      showNewChatModal = false;
      groupName = '';
      groupMembers = [];
    }
  }
</script>

<aside
  class="w-full md:w-80 bg-white border-r border-cn-border flex flex-col {isHidden
    ? 'hidden md:flex'
    : ''}"
>
  <!-- Header -->
  <div
    class="px-4 py-4 border-b border-cn-bg flex items-center justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10"
  >
    <div class="flex items-center gap-2">
      <div
        class="w-8 h-8 rounded-full bg-cn-dark text-cn-yellow flex items-center justify-center font-bold text-sm"
      >
        {userProfile?.id?.[0]?.toUpperCase() ?? 'ME'}
      </div>
      <span class="font-semibold text-gray-700">Discussions</span>
    </div>

    <button
      onclick={() => (showNewChatModal = true)}
      class="w-8 h-8 flex items-center justify-center rounded-full bg-cn-bg hover:bg-gray-200 text-cn-dark transition-colors"
      title="Nouvelle discussion"
    >
      <Plus size={20} />
    </button>
  </div>

  <!-- Search (Placeholder for future) -->
  <div class="px-4 py-2">
    <div class="bg-cn-bg rounded-xl px-3 py-2 text-sm text-gray-500 flex items-center gap-2">
      <span class="text-gray-400">🔍</span> Rechercher...
    </div>
  </div>

  <!-- Conversation List -->
  <div class="flex-1 overflow-y-auto p-2">
    {#each Array.from(conversations.entries()) as [name, convo] (name)}
      <ConversationTile
        contactName={name}
        displayName={convo.name}
        lastMessage={convo.messages.length > 0
          ? getPreviewText(parseEnvelope(convo.messages[convo.messages.length - 1].content))
          : undefined}
        isReady={convo.isReady}
        isSelected={selectedContact === name}
        onClick={() => onSelectConversation(name)}
      />
    {/each}

    {#if conversations.size === 0}
      <div class="text-center py-8 px-4 text-gray-500">
        <div class="mb-4 opacity-50 flex justify-center items-center">
          <Hand size={48} />
        </div>
        <p class="text-sm">Votre messagerie est vide. Cliquez sur + pour démarrer.</p>
      </div>
    {/if}
  </div>

  <!-- Backup footer -->
  <div
    class="p-3 border-t border-cn-border flex justify-between items-center text-xs text-gray-400"
  >
    <span>Sauvegarde chiffrée</span>
    <div class="flex gap-2">
      <button
        onclick={triggerImport}
        class="hover:text-cn-dark transition-colors"
        disabled={isImporting}
      >
        {isImporting ? '...' : 'Importer'}
      </button>
      <span>|</span>
      <button
        onclick={onExport}
        class="hover:text-cn-dark transition-colors"
        disabled={isExporting}
      >
        {isExporting ? '...' : 'Exporter'}
      </button>
    </div>
  </div>
  <input
    bind:this={fileInput}
    type="file"
    accept=".json"
    class="hidden"
    onchange={handleFileChange}
  />
</aside>

<Modal
  open={showNewChatModal}
  onClose={() => (showNewChatModal = false)}
  title="Nouvelle Discussion"
>
  <div class="flex gap-4 border-b border-gray-100 mb-4 pb-2">
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'contact'
        ? 'text-cn-dark border-b-2 border-cn-dark'
        : 'text-gray-400 hover:text-gray-600'}"
      onclick={() => (activeTab = 'contact')}
    >
      Contact Privé
    </button>
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'group'
        ? 'text-cn-dark border-b-2 border-cn-dark'
        : 'text-gray-400 hover:text-gray-600'}"
      onclick={() => (activeTab = 'group')}
    >
      Groupe
    </button>
  </div>

  {#if activeTab === 'contact'}
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Identifiant du contact</label>
        <input
          type="text"
          bind:value={contactId}
          placeholder="ex: alice"
          class="w-full px-4 py-2 bg-cn-bg rounded-xl text-sm outline-none focus:ring-2 focus:ring-cn-yellow/50"
          onkeydown={(e) => e.key === 'Enter' && handleAddContact()}
        />
      </div>
      <button
        onclick={handleAddContact}
        disabled={!contactId.trim()}
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Démarrer la discussion
      </button>
    </div>
  {:else}
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Nom du groupe</label>
        <input
          type="text"
          bind:value={groupName}
          placeholder="ex: Projet X"
          class="w-full px-4 py-2 bg-cn-bg rounded-xl text-sm outline-none focus:ring-2 focus:ring-cn-yellow/50"
        />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Membres initiaux</label>
        <MultiUserSelector
          users={groupMembers}
          onUsersChange={(u) => (groupMembers = u)}
          placeholder="Ajouter un membre..."
        />
      </div>
      <button
        onclick={handleCreateGroup}
        disabled={!groupName.trim()}
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Créer le groupe
      </button>
    </div>
  {/if}
</Modal>
