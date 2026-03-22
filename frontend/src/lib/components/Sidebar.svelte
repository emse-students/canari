<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Hand, RotateCcw, Hash, Lock, Plus } from 'lucide-svelte';
  import Avatar from './Avatar.svelte';
  import ConversationTile from './ConversationTile.svelte';
  import SidebarHeaderControls from './SidebarHeaderControls.svelte';

  import SidebarFooterTools from './SidebarFooterTools.svelte';
  import SidebarNewChatModal from './SidebarNewChatModal.svelte';
  import SidebarNewChannelModal from './SidebarNewChannelModal.svelte';
  import SidebarNewCommunityModal from './SidebarNewCommunityModal.svelte';
  import SidebarCommunityAdminModal from './SidebarCommunityAdminModal.svelte';

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: any[];
    isReady: boolean;
    mlsStateHex: string | null;
    unreadCount?: number;
  }

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

  interface Props {
    viewMode?: 'chat' | 'communities';
    conversations: SvelteMap<string, Conversation>;
    channelWorkspaces?: ChannelWorkspace[];
    archivedConversationIds?: string[];
    showArchivedConversations?: boolean;
    selectedContact: string | null;
    newContactInput: string;
    newGroupInput: string;
    newChannelInput?: string;
    onContactInputChange: (value: string) => void;
    onGroupInputChange: (value: string) => void;
    onChannelInputChange?: (value: string) => void;
    onAddContact: (contactId?: string) => void;
    onCreateGroup: (groupName?: string) => void;
    onCreateChannel?: (workspaceId: string, channelName: string) => void;
    onCreateWorkspace?: (workspaceName?: string) => void;
    onInviteChannelMember?: (
      channelId: string,
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
    onUpdateChannelMemberRole?: (
      channelId: string,
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
    onSelectConversation: (name: string) => void;
    onSelectChannelConversation?: (channelId: string) => void;
    selectedChannelId?: string;
    onToggleArchivedView?: () => void;
    onRestoreConversation?: (name: string) => void;
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
    viewMode = 'chat',
    conversations,
    channelWorkspaces = [],
    archivedConversationIds = [],
    showArchivedConversations = false,
    selectedContact,
    newContactInput,
    newGroupInput,
    newChannelInput = '',
    onContactInputChange,
    onGroupInputChange,
    onChannelInputChange,
    onAddContact,
    onCreateGroup,
    onCreateChannel,
    onCreateWorkspace,

    onSelectConversation,
    onSelectChannelConversation,
    selectedChannelId = '',
    onToggleArchivedView,
    onRestoreConversation,
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

  let showNewChatModal = $state(false);
  let showNewChannelModal = $state(false);
  let showCommunityAdminModal = $state(false);
  let showNewCommunityModal = $state(false);
  let activeTab = $state<'contact' | 'group'>('contact');
  let activeSidebarTab = $derived(
    (viewMode === 'communities' ? 'channels' : 'discussions') as 'channels' | 'discussions'
  );
  let contactId = $state('');
  let groupName = $state('');
  let channelName = $state('');
  let communityName = $state('');

  let selectedCommunityWorkspaceId = $state('');
  let searchQuery = $state('');

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

  let filteredConversationEntries = $derived.by(() => {
    const archived = new Set(archivedConversationIds.map((id) => id.toLowerCase()));
    const query = searchQuery.trim().toLowerCase();

    return [...conversations.entries()].filter(([id, convo]) => {
      // Hide channels from the discussions tab
      if (id.startsWith('channel_')) {
        return false;
      }

      const isArchived = archived.has(id.toLowerCase());
      if (showArchivedConversations ? !isArchived : isArchived) {
        return false;
      }

      if (!query) return true;
      const lastContent = convo.messages.at(-1)?.content ?? '';
      return convo.name.toLowerCase().includes(query) || lastContent.toLowerCase().includes(query);
    });
  });

  function openNewChatModal(tab: 'contact' | 'group' | 'channel' = 'contact') {
    if (tab === 'channel') {
      channelName = newChannelInput || '';
      showNewChannelModal = true;
    } else {
      activeTab = tab;
      contactId = newContactInput || '';
      groupName = newGroupInput || '';
      showNewChatModal = true;
    }
  }

  function closeNewChatModal() {
    showNewChatModal = false;
  }

  function closeNewChannelModal() {
    showNewChannelModal = false;
  }

  function closeCommunityAdminModal() {
    showCommunityAdminModal = false;
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

  function handleCreateChannel() {
    const value = channelName.trim();
    if (!value) return;
    if (!selectedCommunityWorkspaceId) {
      alert("Veuillez sélectionner une communauté d'abord");
      return;
    }
    onChannelInputChange?.(value);
    onCreateChannel?.(selectedCommunityWorkspaceId, value);
    channelName = '';
    onChannelInputChange?.('');
    closeNewChannelModal();
  }

  function handleCreateWorkspace() {
    const value = communityName.trim();
    if (!value) return;
    onCreateWorkspace?.(value);
    communityName = '';
    showNewCommunityModal = false;
  }
</script>

{#if drawerMode}
  <button
    type="button"
    class="fixed inset-0 z-30 bg-black/30 md:hidden"
    onclick={() => onCloseDrawer?.()}
    aria-label="Fermer le volet des conversations"
  ></button>
{/if}

<aside
  class="h-full backdrop-blur-md bg-white/40 dark:bg-gray-900/50 border-r border-white/50 dark:border-white/10 flex {viewMode ===
  'communities'
    ? 'flex-row'
    : 'flex-col'} {drawerMode
    ? 'fixed left-0 top-0 bottom-0 z-40 md:hidden shadow-2xl animate-panel-in ' +
      (viewMode === 'communities' ? 'w-[95vw] max-w-md' : 'w-[88vw] max-w-sm')
    : viewMode === 'communities'
      ? 'w-full md:w-96'
      : 'w-full md:w-80'} {isHidden && !drawerMode ? 'hidden md:flex' : ''}"
>
  {#if viewMode === 'communities'}
    <div
      class="w-[72px] h-full flex-shrink-0 flex flex-col items-center py-3 gap-3 border-r border-white/50 dark:border-white/10 bg-white/20 dark:bg-black/10 overflow-y-auto no-scrollbar"
    >
      {#each channelWorkspaces as workspace (workspace.id)}
        <button
          class="relative w-12 h-12 flex-shrink-0 rounded-2xl overflow-hidden transition-all duration-200 {selectedCommunityWorkspaceId ===
          workspace.id
            ? 'ring-2 ring-cn-yellow ring-offset-2 ring-offset-cn-bg'
            : 'opacity-70 hover:opacity-100 hover:rounded-xl'}"
          onclick={() => (selectedCommunityWorkspaceId = workspace.id)}
          title={workspace.name}
          aria-label={workspace.name}
        >
          <Avatar userId={workspace.avatarUserId} size="lg" />
        </button>
      {/each}

      <div class="w-8 h-[2px] bg-white/30 dark:bg-white/10 rounded-full my-1"></div>

      <button
        onclick={() => {
          showNewCommunityModal = true;
        }}
        class="w-12 h-12 flex-shrink-0 rounded-2xl border border-dashed border-text-muted/50 text-text-muted flex items-center justify-center hover:text-text-main hover:border-text-main hover:bg-white/10 transition-all hover:rounded-[10px]"
        title="Ajouter une communauté"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg
        >
      </button>
    </div>
  {/if}

  <div class="flex-1 h-full min-w-0 flex flex-col">
    {#if viewMode === 'chat'}
      <SidebarHeaderControls
        {activeSidebarTab}
        {showArchivedConversations}
        {searchQuery}
        {drawerMode}
        {onCloseDrawer}
        onSearchQueryChange={(value) => {
          searchQuery = value;
        }}
        onToggleArchivedView={() => onToggleArchivedView?.()}
        onOpenNewChat={() => openNewChatModal('contact')}
      />
    {:else}
      <div
        class="px-4 py-3 border-b border-white/50 dark:border-white/10 bg-white/30 dark:bg-gray-900/40 backdrop-blur-sm sticky top-0 z-10 flex items-center justify-between"
      >
        <h2 class="font-black tracking-tight text-text-main text-lg truncate">
          {channelWorkspaces.find((w) => w.id === selectedCommunityWorkspaceId)?.name ||
            'Communautés'}
        </h2>

        <div class="flex items-center gap-1">
          <button
            class="w-8 h-8 rounded-full flex items-center justify-center text-text-muted hover:text-text-main hover:bg-white/50 dark:hover:bg-black/30 transition-colors"
            onclick={() => {
              showCommunityAdminModal = true;
            }}
            title="Paramètres de la communauté"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
              /><circle cx="12" cy="12" r="3" /></svg
            >
          </button>

          {#if drawerMode}
            <button
              type="button"
              onclick={() => onCloseDrawer?.()}
              class="w-8 h-8 rounded-full flex items-center justify-center text-text-muted hover:bg-white/65 dark:hover:bg-black/30 bg-transparent transition-colors"
              aria-label="Fermer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
              >
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Conversation List -->
    <div class="flex-1 overflow-y-auto p-2.5">
      {#if activeSidebarTab === 'discussions'}
        {#each filteredConversationEntries as [name, convo] (name)}
          <div class="relative">
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
            {#if showArchivedConversations}
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/75 dark:bg-black/45 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white dark:hover:bg-black/60 transition-colors"
                aria-label="Restaurer la discussion"
                title="Restaurer"
                onclick={(event) => {
                  event.stopPropagation();
                  onRestoreConversation?.(name);
                }}
              >
                <RotateCcw size={14} />
              </button>
            {/if}
          </div>
        {/each}

        {#if filteredConversationEntries.length === 0}
          <div class="text-center py-8 px-4 text-text-muted">
            <div class="mb-4 opacity-50 flex justify-center items-center">
              <Hand size={48} />
            </div>
            <p class="text-sm">
              {searchQuery.trim()
                ? 'Aucune discussion correspondante.'
                : showArchivedConversations
                  ? 'Votre corbeille est vide.'
                  : 'Votre messagerie est vide. Cliquez sur + pour demarrer.'}
            </p>
          </div>
        {/if}
      {:else}
        {@const currentWorkspace = channelWorkspaces.find(
          (w) => w.id === selectedCommunityWorkspaceId
        )}
        {#if currentWorkspace}
          <div class="px-2 py-2">
            {#each currentWorkspace.channels as channel (channel.id)}
              <button
                type="button"
                onclick={() => onSelectChannelConversation?.(channel.id)}
                class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors {selectedChannelId ===
                channel.id
                  ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_16%,transparent)] text-text-main'
                  : 'hover:bg-white/40 dark:hover:bg-black/20 text-text-muted hover:text-text-main'}"
              >
                <span class="opacity-70">
                  {#if channel.isPrivate}
                    <Lock size={16} />
                  {:else}
                    <Hash size={16} />
                  {/if}
                </span>
                <span class="flex-1 truncate font-medium">{channel.name}</span>
                {#if channel.unreadCount}
                  <span
                    class="min-w-5 h-5 px-1 rounded-full bg-cn-dark text-cn-yellow text-[0.65rem] font-extrabold inline-flex items-center justify-center"
                  >
                    {channel.unreadCount}
                  </span>
                {/if}
              </button>
            {/each}

            <button
              type="button"
              onclick={() => openNewChatModal('channel')}
              class="w-full mt-2 flex items-center gap-2 px-3 py-2 rounded-xl text-left border border-dashed border-text-muted/30 text-text-muted hover:text-text-main hover:bg-white/40 dark:hover:bg-black/20 transition-colors"
            >
              <Plus size={16} />
              <span class="font-medium text-sm">Ajouter un canal</span>
            </button>
          </div>
        {:else}
          <div class="text-center py-8 px-4 text-text-muted text-sm">
            Sélectionner ou créer une communauté.
          </div>
        {/if}
      {/if}
    </div>

    {#if viewMode !== 'communities'}
      <SidebarFooterTools
        {onImport}
        {onExport}
        {onStartSync}
        {onJoinSync}
        {isExporting}
        {isImporting}
        {isSyncing}
      />
    {/if}
  </div>
</aside>

<SidebarNewChatModal
  open={showNewChatModal}
  {activeTab}
  {contactId}
  {groupName}
  onClose={closeNewChatModal}
  onTabChange={(tab) => {
    activeTab = tab;
  }}
  onContactIdChange={(value) => {
    contactId = value;
  }}
  onGroupNameChange={(value) => {
    groupName = value;
  }}
  onSubmitContact={handleAddContact}
  onSubmitGroup={handleCreateGroup}
/>

<SidebarNewChannelModal
  open={showNewChannelModal}
  {channelName}
  onClose={closeNewChannelModal}
  onChannelNameChange={(value) => {
    channelName = value;
  }}
  onSubmitChannel={handleCreateChannel}
/>

<SidebarCommunityAdminModal
  open={showCommunityAdminModal}
  workspaces={channelWorkspaces}
  selectedWorkspaceId={selectedCommunityWorkspaceId || channelWorkspaces[0]?.id || ''}
  onClose={closeCommunityAdminModal}
/>

<SidebarNewCommunityModal
  open={showNewCommunityModal}
  {communityName}
  onClose={() => (showNewCommunityModal = false)}
  onNameChange={(value) => {
    communityName = value;
  }}
  onSubmit={handleCreateWorkspace}
/>
