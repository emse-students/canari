<script lang="ts">
  import { User, Users, Hand, Download, Upload, X, ScanLine, Smartphone } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';

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
    onAddContact: () => void;
    onCreateGroup: () => void;
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

  function handleContactKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && newContactInput.trim()) {
      onAddContact();
    }
  }

  function handleGroupKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && newGroupInput.trim()) {
      onCreateGroup();
    }
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
  <!-- Header -->
  <div class="p-4 border-b border-cn-bg space-y-3">
    {#if drawerMode}
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-cn-dark">Conversations</h2>
        <button
          type="button"
          onclick={() => onCloseDrawer?.()}
          class="p-2 rounded-lg text-gray-500 bg-cn-bg"
          aria-label="Fermer"
        >
          <X size={16} />
        </button>
      </div>
    {/if}

    <!-- Add Contact -->
    <div class="flex gap-2">
      <input
        type="text"
        value={newContactInput}
        oninput={(e) => onContactInputChange(e.currentTarget.value)}
        onkeydown={handleContactKeydown}
        placeholder="Nouveau contact..."
        class="flex-1 px-4 py-3 bg-cn-bg rounded-2xl text-sm outline-none focus:shadow-[inset_0_0_0_2px] focus:shadow-cn-yellow text-text-main"
      />
      <button
        onclick={onAddContact}
        class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center hover:bg-gray-800 transition-colors"
        title="Ajouter un contact"
      >
        <User size={20} />
      </button>
    </div>

    <!-- Create Group -->
    <div class="flex gap-2">
      <input
        type="text"
        value={newGroupInput}
        oninput={(e) => onGroupInputChange(e.currentTarget.value)}
        onkeydown={handleGroupKeydown}
        placeholder="Nouveau groupe..."
        class="flex-1 px-4 py-3 bg-cn-bg rounded-2xl text-sm outline-none focus:shadow-[inset_0_0_0_2px] focus:shadow-cn-yellow text-text-main"
      />
      <button
        onclick={onCreateGroup}
        class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center hover:bg-gray-800 transition-colors"
        title="Créer un groupe"
      >
        <Users size={20} />
      </button>
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
        <p class="text-sm">Votre messagerie est vide. Cherchez un pseudo pour commencer.</p>
      </div>
    {/if}
  </div>

  <!-- Backup section -->
  <div class="p-3 border-t border-cn-border space-y-2">
    <p class="text-xs text-gray-400 px-1">Sauvegarde chiffrée</p>
    <div class="flex gap-2">
      <!-- Export -->
      <button
        onclick={onExport}
        disabled={isExporting}
        class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-sm
               bg-cn-bg text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-50"
        title="Exporter les conversations vers un fichier .canari"
      >
        <Download size={15} />
        {isExporting ? 'Export…' : 'Exporter'}
      </button>

      <!-- Import -->
      <button
        onclick={triggerImport}
        disabled={isImporting}
        class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-sm
               bg-cn-bg text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-50"
        title="Importer une sauvegarde .canari"
      >
        <Upload size={15} />
        {isImporting ? 'Import…' : 'Importer'}
      </button>

      <!-- Hidden file picker -->
      <input
        bind:this={fileInput}
        type="file"
        accept=".canari"
        class="hidden"
        onchange={handleFileChange}
      />
    </div>

    <p class="text-xs text-gray-400 px-1 pt-1">Synchro multi-appareils</p>
    <div class="flex gap-2">
      <button
        onclick={onStartSync}
        disabled={isSyncing}
        class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-sm
               bg-cn-bg text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-50"
        title="Démarrer une session de synchronisation QR"
      >
        <ScanLine size={15} />
        Démarrer
      </button>

      <button
        onclick={onJoinSync}
        disabled={isSyncing}
        class="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-sm
               bg-cn-bg text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-50"
        title="Rejoindre une session de synchronisation QR"
      >
        <Smartphone size={15} />
        Joindre
      </button>
    </div>
  </div>
</aside>
