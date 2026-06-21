<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Hash, Lock, MessageSquarePlus, Plus } from '@lucide/svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import ConversationTile from '../chat/ConversationTile.svelte';
  import SidebarHeaderControls from './SidebarHeaderControls.svelte';

  import SidebarNewChatModal from './SidebarNewChatModal.svelte';
  import SidebarNewChannelModal from './SidebarNewChannelModal.svelte';
  import SidebarNewCommunityModal from './SidebarNewCommunityModal.svelte';
  import SidebarCommunityAdminModal from './SidebarCommunityAdminModal.svelte';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { pullToRefresh } from '$lib/actions/pullToRefresh';
  import type { Conversation } from '$lib/types';

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
    imageMediaId?: string | null;
    workspaceDbId?: string;
    channels: ChannelItem[];
  }

  interface Props {
    /** Controls whether the sidebar shows chat conversations or community channels. */
    viewMode?: 'chat' | 'communities';
    /** Map of all loaded conversations keyed by conversation ID. */
    conversations: SvelteMap<string, Conversation>;
    /** List of channel workspaces available in communities view. */
    channelWorkspaces?: ChannelWorkspace[];
    /** ID/name of the currently selected conversation. */
    selectedContact: string | null;
    /** Current value of the new-contact input (controlled). */
    newContactInput: string;
    /** Current value of the new-group name input (controlled). */
    newGroupInput: string;
    /** Current value of the new-channel name input (controlled). */
    newChannelInput?: string;
    /** Callback fired when the contact input value changes. */
    onContactInputChange: (value: string) => void;
    /** Callback fired when the group name input value changes. */
    onGroupInputChange: (value: string) => void;
    /** Callback fired when the channel name input value changes. */
    onChannelInputChange?: (value: string) => void;
    /** Callback to start a direct conversation with the given contact ID. */
    onAddContact: (contactId?: string) => void;
    /** Callback to create a new group conversation with the given name. */
    onCreateGroup: (groupName?: string) => void;
    /** Callback to create a new channel inside the specified workspace. */
    onCreateChannel?: (workspaceId: string, channelName: string) => void;
    /** Callback to create a new community workspace. */
    onCreateWorkspace?: (workspaceName?: string) => void;
    /** Callback to invite a member to a channel with a given role. */
    onInviteChannelMember?: (
      channelId: string,
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
    /** Callback to update an existing channel member's role. */
    onUpdateChannelMemberRole?: (
      channelId: string,
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
    /** Callback to update the avatar image of a workspace. */
    onUpdateWorkspaceImage?: (workspaceDbId: string, mediaId: string) => void;
    /** Callback fired when the user leaves a workspace. */
    onLeaveWorkspace?: (workspaceDbId: string) => void;
    /** Callback fired when the user selects a direct or group conversation. */
    onSelectConversation: (name: string) => void;
    /** Callback fired when the user selects a channel conversation. */
    onSelectChannelConversation?: (channelId: string) => void;
    /** ID of the currently active channel. */
    selectedChannelId?: string;
    /** When true, the sidebar is hidden on mobile (shown only on desktop). */
    isHidden?: boolean;
    /** When true, the sidebar renders as a slide-over drawer on mobile. */
    drawerMode?: boolean;
    /** Callback to close the drawer when in drawer mode. */
    onCloseDrawer?: () => void;
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Optional pull-to-refresh handler for the conversations list. */
    onRefresh?: () => Promise<void>;
  }

  let {
    viewMode = 'chat',
    conversations,
    channelWorkspaces = [],
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
    onInviteChannelMember,
    onUpdateWorkspaceImage,
    onLeaveWorkspace,
    onSelectConversation,
    onSelectChannelConversation,
    selectedChannelId = '',
    isHidden = false,
    drawerMode = false,
    onCloseDrawer,
    currentUserId = '',
    onRefresh,
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
  const selectedCommunityWorkspace = $derived(
    channelWorkspaces.find((w) => w.id === selectedCommunityWorkspaceId)
  );

  // When a channel is selected externally (e.g. "Rejoindre" button after invite),
  // auto-reveal the workspace that contains it.
  $effect(() => {
    if (!selectedChannelId || viewMode !== 'communities') return;
    const ws = channelWorkspaces.find((w) => w.channels.some((ch) => ch.id === selectedChannelId));
    if (ws && selectedCommunityWorkspaceId !== ws.id) {
      selectedCommunityWorkspaceId = ws.id;
    }
  });

  // Auto-select the first workspace when entering communities mode so the
  // gear icon and channel list are immediately visible (avoids an empty panel).
  $effect(() => {
    if (viewMode !== 'communities' || selectedCommunityWorkspaceId || channelWorkspaces.length === 0) return;
    selectedCommunityWorkspaceId = channelWorkspaces[0].id;
  });

  // Clear stale workspace selection if the workspace was removed from the server.
  $effect(() => {
    if (!selectedCommunityWorkspaceId) return;
    if (!channelWorkspaces.some((w) => w.id === selectedCommunityWorkspaceId)) {
      selectedCommunityWorkspaceId = '';
    }
  });

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
    imageMediaId?: string | null;
    workspaceDbId?: string;
    channels: ChannelItem[];
  }

  let filteredConversationEntries = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();

    return [...conversations.entries()]
      .filter(([id, convo]) => {
        if (isChannelConversationId(id)) return false;
        if (!query) return true;
        const lastContent = convo.messages.at(-1)?.content ?? '';
        return convo.name.toLowerCase().includes(query) || lastContent.toLowerCase().includes(query);
      })
      .sort(([, a], [, b]) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
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
    channelName = '';
  }

  function closeCommunityAdminModal() {
    showCommunityAdminModal = false;
  }

  function handleAddContact() {
    const value = contactId.trim();
    if (!value) return;
    if (currentUserId && value.toLowerCase() === currentUserId.toLowerCase()) return;
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
      showToast("Veuillez sélectionner une communauté d'abord", 'warning');
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
    class="fixed inset-0 z-[42] bg-black/30 md:hidden"
    onclick={() => onCloseDrawer?.()}
    aria-label="Fermer le volet des conversations"
  ></button>
{/if}

<aside
  class="h-full backdrop-blur-md bg-white/40 dark:bg-gray-900/50 border-r border-white/50 dark:border-white/10 flex {viewMode ===
  'communities'
    ? 'flex-row'
    : 'flex-col'} {drawerMode
    ? 'fixed left-0 top-0 bottom-0 z-40 md:hidden shadow-2xl animate-panel-in pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ' +
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
          onclick={() => {
            selectedCommunityWorkspaceId = workspace.id;
          }}
          title={workspace.name}
          aria-label={workspace.name}
        >
          <GroupAvatar
            imageMediaId={workspace.imageMediaId}
            name={workspace.name}
            variant="community"
            size="lg"
          />
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
        {searchQuery}
        {drawerMode}
        {onCloseDrawer}
        onSearchQueryChange={(value) => {
          searchQuery = value;
        }}
        onOpenNewChat={() => openNewChatModal('contact')}
      />
    {:else}
      <div
        class="px-4 py-3 border-b border-white/50 dark:border-white/10 bg-white/30 dark:bg-gray-900/40 backdrop-blur-sm sticky top-0 z-10 flex items-center justify-between"
      >
        <h2 class="font-black tracking-tight text-text-main text-lg truncate">
          {selectedCommunityWorkspace?.name || 'Communautés'}
        </h2>

        <div class="flex items-center gap-1">
          {#if selectedCommunityWorkspace}
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
          {/if}

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
    <div
      class="flex-1 overflow-y-auto p-2.5"
      use:pullToRefresh={{ onRefresh: onRefresh ?? (() => Promise.resolve()) }}
    >
      {#if activeSidebarTab === 'discussions'}
        {#each filteredConversationEntries as [name, convo] (name)}
          {@const resolved = resolveConversationListPresentation(
            { id: convo.id || name, name: convo.name, contactName: convo.contactName,
              conversationType: convo.conversationType, directPeerId: convo.directPeerId },
            currentUserId
          )}
          <div class="relative">
            <ConversationTile
              contactName={resolved.contactId}
              displayName={resolved.displayName}
              conversationType={convo.conversationType}
              lastMessage={convo.messages.length > 0
                ? convo.messages[convo.messages.length - 1].content
                : undefined}
              isReady={convo.lifecycle === 'active'}
              isRemoved={convo.lifecycle === 'removed'}
              isSelected={selectedContact === name}
              unreadCount={convo.unreadCount ?? 0}
              imageMediaId={convo.imageMediaId}
              onClick={() => onSelectConversation(name)}
            />
          </div>
        {/each}

        {#if filteredConversationEntries.length === 0}
          <div class="text-center py-12 px-6 text-text-muted">
            <div class="mb-4 flex justify-center">
              <div class="p-4 rounded-2xl bg-black/5 dark:bg-white/5">
                <MessageSquarePlus size={36} class="opacity-40" />
              </div>
            </div>
            {#if searchQuery.trim()}
              <p class="text-sm font-medium">Aucune discussion correspondante.</p>
            {:else}
              <p class="text-sm font-bold text-text-main mb-1">Aucune discussion</p>
              <p class="text-xs mb-4">Commencez à écrire à quelqu'un !</p>
              <button
                type="button"
                onclick={() => (showNewChatModal = true)}
                class="px-4 py-2 rounded-xl bg-amber-500 text-white text-xs font-semibold transition-all active:scale-95"
              >
                Nouvelle discussion
              </button>
            {/if}
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
  </div>
</aside>

<SidebarNewChatModal
  open={showNewChatModal}
  {activeTab}
  {contactId}
  {groupName}
  {currentUserId}
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
  selectedWorkspaceId={selectedCommunityWorkspaceId}
  onClose={closeCommunityAdminModal}
  {onUpdateWorkspaceImage}
  {onLeaveWorkspace}
  onInviteCommunityMember={async (memberId, roleName) => {
    const workspace = selectedCommunityWorkspace;
    if (!workspace) {
      throw new Error("Veuillez sélectionner une communauté d'abord");
    }

    const targetChannel =
      workspace.channels.find((channel) => channel.name.trim().toLowerCase() === 'general') ||
      workspace.channels[0];

    if (!targetChannel) {
      throw new Error("Aucun canal disponible dans cette communauté pour envoyer l'invitation");
    }

    await onInviteChannelMember?.(targetChannel.id, memberId, roleName);
  }}
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
