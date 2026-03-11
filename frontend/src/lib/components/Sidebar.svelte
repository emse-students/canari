<script lang="ts">
  import { Hand, Plus, Download, Upload, X, ScanLine, Smartphone } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';
  import Modal from './Modal.svelte';

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
    newContactInput: string;
    newGroupInput: string;
    onContactInputChange: (value: string) => void;
    onGroupInputChange: (value: string) => void;
    onAddContact: (contactId?: string) => void;
    onCreateGroup: (groupName?: string) => void;
    onSelectConversation: (name: string) => void;
    onExport: () => void;
    onImport: (file: File) => void;
    onStartSync: () => void;
    onJoinSync: () => void;
    isExporting?: boolean;
    isImporting?: boolean;
    isSyncing?: boolean;
    isHidden?: boolean;
    drawerMode?: boolean;
    onCloseDrawer?: () => void;
  }

  let {
    conversations,
    selectedContact,
    newContactInput,
    newGroupInput,
    onContactInputChange,
    onGroupInputChange,
    onAddContact,
    onCreateGroup,
    onSelectConversation,
    onExport,
    onImport,
    onStartSync,
    onJoinSync,
    isExporting = false,
    isImporting = false,
    isSyncing = false,
    isHidden = false,
    drawerMode = false,
    onCloseDrawer,
  }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  let showNewChatModal = $state(false);
  let activeTab = $state<'contact' | 'group'>('contact');
  let contactId = $state('');
  let groupName = $state('');

  function openNewChatModal(tab: 'contact' | 'group' = 'contact') {
    activeTab = tab;
    contactId = newContactInput;
    groupName = newGroupInput;
    showNewChatModal = true;
  }

  function closeNewChatModal() {
    showNewChatModal = false;
  }

  function handleAddContact() {
    const value = contactId.trim();
    if (!value) return;
    onContactInputChange(value);
    onAddContact(value);
    contactId = '';
    onContactInputChange('');
    closeNewChatModal();
  }

  function handleCreateGroup() {
    const value = groupName.trim();
    if (!value) return;
    onGroupInputChange(value);
    onCreateGroup(value);
    groupName = '';
    onGroupInputChange('');
    closeNewChatModal();
  }

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      onImport(file);
      input.value = ''; // reset so the same file can be re-selected
    }
  }
</script>

{#if drawerMode}
  <button
    type="button"
    class="fixed inset-0 z-30 bg-black/35 md:hidden"
    onclick={() => onCloseDrawer?.()}
    aria-label="Fermer le volet des conversations"
  ></button>
{/if}

<aside
  class="bg-[var(--surface-elevated)] border-r border-cn-border flex flex-col {drawerMode
    ? 'fixed left-0 top-0 bottom-0 z-40 w-[88vw] max-w-sm md:hidden shadow-2xl animate-panel-in'
    : 'w-full md:w-80'} {isHidden && !drawerMode ? 'hidden md:flex' : ''}"
>
  <div class="px-4 py-4 border-b border-cn-bg flex items-center justify-between sticky top-0 bg-[var(--surface-elevated)]/90 backdrop-blur-md z-10">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold tracking-wide text-cn-dark">Discussions</h2>
    </div>
    <div class="flex items-center gap-2">
      <button
        onclick={() => openNewChatModal('contact')}
        class="w-8 h-8 rounded-full bg-cn-bg hover:bg-gray-200 text-cn-dark transition-colors flex items-center justify-center"
        title="Nouvelle discussion"
        aria-label="Nouvelle discussion"
      >
        <Plus size={16} />
      </button>
      {#if drawerMode}
        <button
          type="button"
          onclick={() => onCloseDrawer?.()}
          class="p-2 rounded-lg text-gray-500 bg-cn-bg"
          aria-label="Fermer"
        >
          <X size={16} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Conversation List -->
  <div class="flex-1 overflow-y-auto p-2">
    {#each Array.from(conversations.entries()) as [name, convo] (name)}
      <ConversationTile
        contactName={name}
        displayName={convo.name}
        lastMessage={convo.messages.length > 0
          ? convo.messages[convo.messages.length - 1].content
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
        <p class="text-sm">Votre messagerie est vide. Cliquez sur + pour demarrer.</p>
      </div>
    {/if}
  </div>

  <div class="p-3 border-t border-cn-border space-y-2 text-xs text-gray-500">
    <div class="flex items-center justify-between">
      <span>Sauvegarde chiffree</span>
      <div class="flex items-center gap-2">
        <button
          onclick={triggerImport}
          disabled={isImporting}
          class="inline-flex items-center gap-1 hover:text-cn-dark transition-colors disabled:opacity-50"
          title="Importer une sauvegarde .canari"
        >
          <Upload size={13} />
          {isImporting ? '...' : 'Importer'}
        </button>
        <span class="text-gray-300">|</span>
        <button
          onclick={onExport}
          disabled={isExporting}
          class="inline-flex items-center gap-1 hover:text-cn-dark transition-colors disabled:opacity-50"
          title="Exporter les conversations vers un fichier .canari"
        >
          <Download size={13} />
          {isExporting ? '...' : 'Exporter'}
        </button>
      </div>
    </div>

    <div class="flex items-center justify-between">
      <span>Sync appareils</span>
      <button
        onclick={onStartSync}
        disabled={isSyncing}
        class="inline-flex items-center gap-1 hover:text-cn-dark transition-colors disabled:opacity-50"
        title="Démarrer une session de synchronisation QR"
      >
        <ScanLine size={13} />
        Demarrer
      </button>
      <span class="text-gray-300">|</span>
      <button
        onclick={onJoinSync}
        disabled={isSyncing}
        class="inline-flex items-center gap-1 hover:text-cn-dark transition-colors disabled:opacity-50"
        title="Rejoindre une session de synchronisation QR"
      >
        <Smartphone size={13} />
        Joindre
      </button>
    </div>

    <input
      bind:this={fileInput}
      type="file"
      accept=".canari"
      class="hidden"
      onchange={handleFileChange}
    />
  </div>
</aside>

<Modal open={showNewChatModal} onClose={closeNewChatModal} title="Nouvelle discussion">
  <div class="flex gap-4 border-b border-gray-100 mb-4 pb-2">
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'contact'
        ? 'text-cn-dark border-b-2 border-cn-dark'
        : 'text-gray-400 hover:text-gray-600'}"
      onclick={() => (activeTab = 'contact')}
    >
      Contact
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
        <label for="new-contact-id" class="block text-sm font-medium text-gray-700 mb-1"
          >Identifiant du contact</label
        >
        <input
          id="new-contact-id"
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
        Demarrer la discussion
      </button>
    </div>
  {:else}
    <div class="space-y-4">
      <div>
        <label for="new-group-name" class="block text-sm font-medium text-gray-700 mb-1"
          >Nom du groupe</label
        >
        <input
          id="new-group-name"
          type="text"
          bind:value={groupName}
          placeholder="ex: Projet X"
          class="w-full px-4 py-2 bg-cn-bg rounded-xl text-sm outline-none focus:ring-2 focus:ring-cn-yellow/50"
          onkeydown={(e) => e.key === 'Enter' && handleCreateGroup()}
        />
      </div>
      <button
        onclick={handleCreateGroup}
        disabled={!groupName.trim()}
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Creer le groupe
      </button>
    </div>
  {/if}
</Modal>
