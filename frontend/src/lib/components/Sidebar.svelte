<script lang="ts">
  import { Hand, RotateCcw } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';
  import SidebarHeaderControls from './SidebarHeaderControls.svelte';
  import SidebarChannelWorkspaces from './SidebarChannelWorkspaces.svelte';
  import SidebarFooterTools from './SidebarFooterTools.svelte';
  import SidebarNewChatModal from './SidebarNewChatModal.svelte';
  import SidebarNewChannelModal from './SidebarNewChannelModal.svelte';

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
    conversations: Map<string, Conversation>;
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
    onCreateChannel?: (channelName?: string) => void;
    onSelectConversation: (name: string) => void;
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
    onSelectConversation,
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
  let activeTab = $state<'contact' | 'group'>('contact');
  let activeSidebarTab = $state<'discussions' | 'channels'>('discussions');
  let contactId = $state('');
  let groupName = $state('');
  let channelName = $state('');
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



  let filteredConversationEntries = $derived.by(() => {
    const archived = new Set(archivedConversationIds.map((id) => id.toLowerCase()));
    const query = searchQuery.trim().toLowerCase();

    return Array.from(conversations.entries()).filter(([id, convo]) => {
      const isArchived = archived.has(id.toLowerCase());
      if (showArchivedConversations ? !isArchived : isArchived) {
        return false;
      }

      if (!query) return true;
      const lastContent = convo.messages.at(-1)?.content ?? '';
      return convo.name.toLowerCase().includes(query) || lastContent.toLowerCase().includes(query);
    });
  });

  let filteredChannelWorkspaces = $derived(
    channelWorkspaces
      .map((workspace) => {
        if (!searchQuery.trim()) return workspace;
        const query = searchQuery.trim().toLowerCase();
        const workspaceMatches = workspace.name.toLowerCase().includes(query);
        const channels = workspace.channels.filter((channel) =>
          channel.name.toLowerCase().includes(query)
        );
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
    onChannelInputChange?.(value);
    onCreateChannel?.(value);
    channelName = '';
    onChannelInputChange?.('');
    closeNewChannelModal();
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
  class="h-full backdrop-blur-md bg-white/40 dark:bg-gray-900/50 border-r border-white/50 dark:border-white/10 flex flex-col {drawerMode
    ? 'fixed left-0 top-0 bottom-0 z-40 w-[88vw] max-w-sm md:hidden shadow-2xl animate-panel-in'
    : 'w-full md:w-80'} {isHidden && !drawerMode ? 'hidden md:flex' : ''}"
>
  <SidebarHeaderControls
    {activeSidebarTab}
    {showArchivedConversations}
    {searchQuery}
    {drawerMode}
    {onCloseDrawer}
    onTabChange={(tab) => {
      activeSidebarTab = tab;
    }}
    onSearchQueryChange={(value) => {
      searchQuery = value;
    }}
    onToggleArchivedView={() => onToggleArchivedView?.()}
    onOpenNewChat={() => openNewChatModal(activeSidebarTab === 'channels' ? 'channel' : 'contact')}
  />

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
      <SidebarChannelWorkspaces
        {filteredChannelWorkspaces}
        {expandedWorkspaceIds}
        {selectedChannelId}
        onToggleWorkspace={toggleWorkspace}
        onOpenNewGroup={() => openNewChatModal('channel')}
        onSelectChannel={(channelId) => {
          selectedChannelId = channelId;
        }}
      />
    {/if}
  </div>

  <SidebarFooterTools
    {onImport}
    {onExport}
    {onStartSync}
    {onJoinSync}
    {isExporting}
    {isImporting}
    {isSyncing}
  />
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

