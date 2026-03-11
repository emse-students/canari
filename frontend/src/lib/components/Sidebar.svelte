<script lang="ts">
  import {
    Hand,
    Plus,
    Download,
    Upload,
    X,
    ScanLine,
    Smartphone,
    Search,
    ChevronDown,
    ChevronRight,
    Hash,
    Lock,
  } from 'lucide-svelte';
  import Avatar from './Avatar.svelte';
  import ConversationTile from './ConversationTile.svelte';
  import Modal from './Modal.svelte';

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: any[];
    isReady: boolean;
    mlsStateHex: string | null;
    unreadCount?: number;
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
  let activeSidebarTab = $state<'discussions' | 'channels'>('discussions');
  let contactId = $state('');
  let groupName = $state('');
  let searchQuery = $state('');
  let expandedWorkspaceIds = $state<string[]>(['sports', 'bde']);
  let selectedChannelId = $state('sports-annonces');

  interface ChannelItem {
    id: string;
    name: string;
    unreadCount?: number;
    isPrivate?: boolean;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    avatarUserId: string;
    channels: ChannelItem[];
  }

  const channelWorkspaces: ChannelWorkspace[] = [
    {
      id: 'sports',
      name: 'Bureau des Sports',
      avatarUserId: 'bds-canari',
      channels: [
        { id: 'sports-annonces', name: 'annonces', unreadCount: 3 },
        { id: 'sports-general', name: 'general' },
        { id: 'sports-organisation', name: 'organisation', isPrivate: true, unreadCount: 1 },
        { id: 'sports-tresorerie', name: 'tresorerie', isPrivate: true },
      ],
    },
    {
      id: 'bde',
      name: 'Bureau des Eleves',
      avatarUserId: 'bde-canari',
      channels: [
        { id: 'bde-annonces', name: 'annonces', unreadCount: 5 },
        { id: 'bde-evenements', name: 'evenements', unreadCount: 2 },
        { id: 'bde-general', name: 'general' },
      ],
    },
    {
      id: 'photo',
      name: 'Club Photo',
      avatarUserId: 'club-photo',
      channels: [{ id: 'photo-general', name: 'general' }],
    },
    {
      id: 'entreprises',
      name: 'Forum Entreprises',
      avatarUserId: 'forum-entreprises',
      channels: [{ id: 'entreprises-general', name: 'general' }],
    },
  ];

  let filteredConversationEntries = $derived(
    Array.from(conversations.entries()).filter(([, convo]) => {
      if (!searchQuery.trim()) return true;
      const query = searchQuery.trim().toLowerCase();
      const lastContent = convo.messages.at(-1)?.content ?? '';
      return convo.name.toLowerCase().includes(query) || lastContent.toLowerCase().includes(query);
    })
  );

  let filteredChannelWorkspaces = $derived(
    channelWorkspaces
      .map((workspace) => {
        if (!searchQuery.trim()) return workspace;
        const query = searchQuery.trim().toLowerCase();
        const workspaceMatches = workspace.name.toLowerCase().includes(query);
        const channels = workspace.channels.filter((channel) => channel.name.toLowerCase().includes(query));
        if (!workspaceMatches && channels.length === 0) return null;
        return {
          ...workspace,
          channels: workspaceMatches ? workspace.channels : channels,
        };
      })
      .filter((workspace): workspace is ChannelWorkspace => workspace !== null)
  );

  function toggleWorkspace(workspaceId: string) {
    expandedWorkspaceIds = expandedWorkspaceIds.includes(workspaceId)
      ? expandedWorkspaceIds.filter((id) => id !== workspaceId)
      : [...expandedWorkspaceIds, workspaceId];
  }

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
  <div
    class="px-4 py-3 border-b border-cn-bg sticky top-0 bg-[var(--surface-elevated)]/90 backdrop-blur-md z-10"
  >
    <div class="grid grid-cols-2 rounded-2xl bg-cn-bg p-1 gap-1 w-full">
      <button
        type="button"
        onclick={() => (activeSidebarTab = 'discussions')}
        class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab === 'discussions'
          ? 'bg-white text-cn-dark shadow-sm'
          : 'text-text-muted hover:text-cn-dark'}"
      >
        Discussions
      </button>
      <button
        type="button"
        onclick={() => (activeSidebarTab = 'channels')}
        class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab === 'channels'
          ? 'bg-white text-cn-dark shadow-sm'
          : 'text-text-muted hover:text-cn-dark'}"
      >
        Canaux
      </button>
    </div>
  </div>

  <div class="px-4 py-3 border-b border-cn-border bg-[var(--surface-elevated)]/80 backdrop-blur-sm">
    <div class="flex items-center gap-2">
      <div class="flex-1 relative">
        <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Rechercher..."
          class="w-full rounded-2xl bg-cn-bg pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-cn-yellow/40"
        />
      </div>

      <button
        onclick={() => openNewChatModal(activeSidebarTab === 'channels' ? 'group' : 'contact')}
        class="w-8 h-8 rounded-full bg-cn-bg hover:bg-gray-200 text-cn-dark transition-colors flex items-center justify-center"
        title={activeSidebarTab === 'channels' ? 'Nouveau groupe' : 'Nouvelle discussion'}
        aria-label={activeSidebarTab === 'channels' ? 'Nouveau groupe' : 'Nouvelle discussion'}
      >
        <Plus size={16} />
      </button>
      {#if drawerMode}
        <button
          type="button"
          onclick={() => onCloseDrawer?.()}
          class="p-2 rounded-lg text-text-muted bg-cn-bg"
          aria-label="Fermer"
        >
          <X size={16} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Conversation List -->
  <div class="flex-1 overflow-y-auto p-2">
    {#if activeSidebarTab === 'discussions'}
      {#each filteredConversationEntries as [name, convo] (name)}
        <ConversationTile
          contactName={convo.contactName}
          displayName={convo.name}
          lastMessage={convo.messages.length > 0
            ? convo.messages[convo.messages.length - 1].content
            : undefined}
          isReady={convo.isReady}
          isSelected={selectedContact === name}
          unreadCount={convo.unreadCount ?? 0}
          onClick={() => onSelectConversation(name)}
        />
      {/each}

      {#if filteredConversationEntries.length === 0}
        <div class="text-center py-8 px-4 text-text-muted">
          <div class="mb-4 opacity-50 flex justify-center items-center">
            <Hand size={48} />
          </div>
          <p class="text-sm">
            {searchQuery.trim()
              ? 'Aucune discussion correspondante.'
              : 'Votre messagerie est vide. Cliquez sur + pour demarrer.'}
          </p>
        </div>
      {/if}
    {:else}
      <div class="space-y-2">
        {#each filteredChannelWorkspaces as workspace (workspace.id)}
          {@const isExpanded = expandedWorkspaceIds.includes(workspace.id)}
          <section class="rounded-2xl overflow-hidden">
            <div class="flex items-center gap-2 px-2 py-2 hover:bg-cn-bg rounded-xl transition-colors">
              <button
                type="button"
                onclick={() => toggleWorkspace(workspace.id)}
                class="flex items-center gap-2 min-w-0 flex-1 text-left"
              >
                <span class="text-text-muted">
                  {#if isExpanded}
                    <ChevronDown size={14} />
                  {:else}
                    <ChevronRight size={14} />
                  {/if}
                </span>
                <div class="w-9 h-9 rounded-xl overflow-hidden flex-shrink-0">
                  <Avatar userId={workspace.avatarUserId} size="lg" />
                </div>
                <div class="flex-1 min-w-0 font-semibold text-cn-dark truncate">{workspace.name}</div>
              </button>
              <button
                type="button"
                onclick={() => openNewChatModal('group')}
                class="w-7 h-7 rounded-full hover:bg-white text-text-muted inline-flex items-center justify-center flex-shrink-0"
                aria-label="Ajouter un canal"
              >
                <Plus size={14} />
              </button>
            </div>

            {#if isExpanded}
              <div class="pl-10 pr-2 pb-2 space-y-1">
                {#each workspace.channels as channel (channel.id)}
                  <button
                    type="button"
                    onclick={() => {
                      selectedChannelId = channel.id;
                    }}
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors {selectedChannelId === channel.id
                      ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_16%,transparent)] text-cn-dark'
                      : 'hover:bg-cn-bg text-text-muted'}"
                  >
                    <span class="opacity-70">
                      {#if channel.isPrivate}
                        <Lock size={14} />
                      {:else}
                        <Hash size={14} />
                      {/if}
                    </span>
                    <span class="flex-1 truncate text-sm font-medium">{channel.name}</span>
                    {#if channel.unreadCount}
                      <span class="min-w-5 h-5 px-1 rounded-full bg-cn-dark text-cn-yellow text-[0.65rem] font-extrabold inline-flex items-center justify-center">
                        {channel.unreadCount}
                      </span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}

        {#if filteredChannelWorkspaces.length === 0}
          <div class="text-center py-8 px-4 text-text-muted text-sm">
            Aucun canal correspondant.
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="p-3 border-t border-cn-border bg-[var(--surface-elevated)]/95 backdrop-blur-md">
    <div class="rounded-2xl border border-cn-border bg-white/75 p-3 shadow-sm space-y-3">
      <div class="space-y-2">
        <div class="text-[0.65rem] uppercase tracking-wide font-semibold text-text-muted">
          Sauvegarde chiffree
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button
            onclick={triggerImport}
            disabled={isImporting}
            class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--cn-bg)_80%,white)] text-xs font-semibold text-cn-dark transition-colors disabled:opacity-50"
            title="Importer une sauvegarde .canari"
          >
            <Upload size={13} />
            {isImporting ? 'Import...' : 'Importer'}
          </button>
          <button
            onclick={onExport}
            disabled={isExporting}
            class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--cn-bg)_80%,white)] text-xs font-semibold text-cn-dark transition-colors disabled:opacity-50"
            title="Exporter les conversations vers un fichier .canari"
          >
            <Download size={13} />
            {isExporting ? 'Export...' : 'Exporter'}
          </button>
        </div>
      </div>

      <div class="space-y-2 pt-1 border-t border-cn-border/70">
        <div class="text-[0.65rem] uppercase tracking-wide font-semibold text-text-muted">
          Synchronisation appareils
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button
            onclick={onStartSync}
            disabled={isSyncing}
            class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--cn-bg)_80%,white)] text-xs font-semibold text-cn-dark transition-colors disabled:opacity-50"
            title="Démarrer une session de synchronisation QR"
          >
            <ScanLine size={13} />
            Demarrer
          </button>
          <button
            onclick={onJoinSync}
            disabled={isSyncing}
            class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--cn-bg)_80%,white)] text-xs font-semibold text-cn-dark transition-colors disabled:opacity-50"
            title="Rejoindre une session de synchronisation QR"
          >
            <Smartphone size={13} />
            Joindre
          </button>
        </div>
      </div>
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
  <div class="flex gap-4 border-b border-cn-border mb-4 pb-2">
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'contact'
        ? 'text-cn-dark border-b-2 border-cn-dark'
        : 'text-text-muted hover:text-cn-dark'}"
      onclick={() => (activeTab = 'contact')}
    >
      Contact
    </button>
    <button
      class="px-2 py-1 text-sm font-medium transition-colors {activeTab === 'group'
        ? 'text-cn-dark border-b-2 border-cn-dark'
        : 'text-text-muted hover:text-cn-dark'}"
      onclick={() => (activeTab = 'group')}
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
        <label for="new-group-name" class="block text-sm font-medium text-text-main mb-1"
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
