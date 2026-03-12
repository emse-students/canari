<script lang="ts">
  import { Hand } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';
  import SidebarHeaderControls from './SidebarHeaderControls.svelte';
  import SidebarChannelWorkspaces from './SidebarChannelWorkspaces.svelte';
  import SidebarFooterTools from './SidebarFooterTools.svelte';
  import SidebarNewChatModal from './SidebarNewChatModal.svelte';

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
  <SidebarHeaderControls
    {activeSidebarTab}
    {searchQuery}
    {drawerMode}
    {onCloseDrawer}
    onTabChange={(tab) => {
      activeSidebarTab = tab;
    }}
    onSearchQueryChange={(value) => {
      searchQuery = value;
    }}
    onOpenNewChat={() => openNewChatModal(activeSidebarTab === 'channels' ? 'group' : 'contact')}
  />

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
      <SidebarChannelWorkspaces
        {filteredChannelWorkspaces}
        {expandedWorkspaceIds}
        {selectedChannelId}
        onToggleWorkspace={toggleWorkspace}
        onOpenNewGroup={() => openNewChatModal('group')}
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
