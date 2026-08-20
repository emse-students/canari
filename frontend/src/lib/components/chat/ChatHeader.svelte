<script lang="ts">
  import {
    ChevronLeft,
    LockKeyhole,
    Settings,
    Search,
    Users,
    Phone,
    Video,
    Images,
    Hash,
  } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import ChatGroupPanel from './ChatGroupPanel.svelte';
  import { presenceMap, watchUsers, unwatchUsers } from '$lib/stores/presenceStore';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Raw contact/user ID used for presence lookup and avatar resolution. */
    contactName: string;
    /** MLS group id of the conversation (used to generate shareable invite links). */
    groupId?: string;
    /** Human-readable name displayed in the header. */
    displayName: string;
    /** Whether the MLS session is fully established. */
    isReady: boolean;
    /** Whether the conversation is a group (vs. a direct message). */
    isGroupConversation?: boolean;
    /** Whether the conversation is a community channel. */
    isChannel?: boolean;
    /** Optional media ID for the group avatar image. Ignored for channels (name only, no avatar). */
    imageMediaId?: string | null;
    /** Callback to invite one or more members by user ID. */
    onInviteMembers?: (ids: string[]) => void;
    /** Callback to navigate back to the conversation list on mobile. */
    onBack?: () => void;
    /** Callback to open the settings modal (for channels). */
    onOpenSettings?: () => void;
    // Group management
    /** List of member user IDs in the current group conversation. */
    groupMembers?: string[];
    /** User IDs with an invite currently in flight (optimistic pending rows). */
    pendingInvites?: string[];
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Callback to rename the group. */
    onGroupRename?: (name: string) => void;
    /** Callback to set the group avatar (uploaded media-service id). */
    onGroupSetImage?: (mediaId: string) => void;
    /** Callback to delete the group conversation. */
    onGroupDelete?: () => void;
    /** Callback fired when the current user leaves the group. */
    onGroupLeave?: () => void;
    /** Callback to remove a specific member from the group. */
    onGroupRemoveMember?: (userId: string) => void;
    /** Callback to open the shared media/links/files panel. */
    onOpenMedia?: () => void;
    /** Callback to toggle the in-conversation search bar. */
    onToggleSearch?: () => void;
    /** Whether the search bar is currently active. */
    searchActive?: boolean;
    /** Callback to toggle the channel members sidebar (drawer on mobile, collapsible panel on desktop). */
    onOpenMembers?: () => void;
    /** Whether the channel members panel is currently open (desktop toggle active state). */
    membersActive?: boolean;
    /** Callback to start an audio-only call. */
    onStartAudioCall?: () => void;
    /** Callback to start a video call. */
    onStartVideoCall?: () => void;
  }

  let {
    contactName,
    groupId = '',
    displayName,
    isReady,
    isGroupConversation = true,
    isChannel = false,
    imageMediaId = null,
    onInviteMembers,
    onBack,
    groupMembers = [],
    pendingInvites = [],
    currentUserId = '',
    onGroupRename,
    onGroupSetImage,
    onGroupDelete,
    onGroupLeave,
    onGroupRemoveMember,
    onOpenSettings,
    onOpenMedia,
    onToggleSearch,
    searchActive = false,
    onOpenMembers,
    membersActive = false,
    onStartAudioCall,
    onStartVideoCall,
  }: Props = $props();

  const showCallButtons = $derived(
    Boolean((onStartAudioCall || onStartVideoCall) && !isChannel && isReady)
  );

  let showPanel = $state(false);
  let isOnline = $derived($presenceMap[contactName] || false);
  let resolvedContactDisplayName = $state('');

  const effectiveDisplayName = $derived(
    !isGroupConversation && !isChannel ? resolvedContactDisplayName : displayName
  );

  $effect(() => {
    if (contactName && !isGroupConversation && !isChannel) {
      watchUsers([contactName]);
      return () => unwatchUsers([contactName]);
    }
  });

  $effect(() => {
    if (isGroupConversation || isChannel) {
      resolvedContactDisplayName = displayName;
      return;
    }
    resolvedContactDisplayName = getUserDisplayNameSync(contactName, displayName);
    resolveUserDisplayName(contactName).then((resolved) => {
      if (resolved) {
        resolvedContactDisplayName = resolved;
      }
    });
  });

  function handlePanelKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showPanel) {
      showPanel = false;
    }
  }
</script>

<svelte:window onkeydown={handlePanelKeydown} />

<!-- Main header -->
<header
  class="relative z-20 flex items-center gap-3 border-b border-black/5 bg-white/70 px-3 py-3 backdrop-blur-2xl md:gap-4 md:px-6 dark:border-white/10 dark:bg-black/50"
>
  <!-- Back button (mobile) - fixed width so the avatar stays centered -->
  <div class="flex w-8 flex-shrink-0 items-center justify-start md:hidden">
    {#if onBack}
      <button
        onclick={onBack}
        aria-label={m.chat_back_label()}
        class="text-text-muted hover:text-text-main rounded-xl p-1 transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      >
        <ChevronLeft size={24} />
      </button>
    {/if}
  </div>

  <!-- Conversation icon (avatar for groups/DMs; channels show no avatar, only a type icon) -->
  {#if isChannel}
    <div class="text-text-muted flex h-10 w-10 flex-shrink-0 items-center justify-center">
      <Hash size={22} strokeWidth={2.5} />
    </div>
  {:else if isGroupConversation}
    <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center">
      <GroupAvatar {imageMediaId} name={displayName} variant="group" size="lg" />
    </div>
  {:else}
    <div class="relative flex h-10 w-10 shrink-0 items-center justify-center">
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
      {#if isOnline}
        <span
          class="absolute right-0 bottom-0 block h-3.5 w-3.5 rounded-full bg-green-500 shadow-sm ring-2 ring-white dark:ring-zinc-900"
        ></span>
      {/if}
    </div>
  {/if}

  <!-- Info (name, status) -->
  <div class="flex min-w-0 flex-1 flex-col justify-center">
    <h2 class="text-text-main mb-0.5 truncate text-base leading-tight font-bold md:text-[1.05rem]">
      {effectiveDisplayName}
    </h2>

    {#if isChannel}
      <span
        class="text-text-muted inline-flex items-center text-[0.7rem] font-semibold tracking-wider uppercase md:text-xs"
      >
        {m.chat_community_channel_label()}
      </span>
    {:else}
      <LockKeyhole
        size={12}
        strokeWidth={2.5}
        class={isReady
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'animate-pulse text-amber-600 dark:text-amber-500'}
        title={isReady ? m.chat_e2e_verified_title() : m.chat_e2e_negotiating_title()}
      />
    {/if}
  </div>

  <!-- Actions (calls, members, search, settings) -->
  <div class="flex shrink-0 items-center gap-1">
    {#if showCallButtons}
      {#if onStartAudioCall}
        <button
          onclick={onStartAudioCall}
          aria-label={m.chat_audio_call_label()}
          title={m.chat_audio_call_label()}
          class="text-text-muted hover:text-text-main rounded-xl p-2.5 transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
        >
          <Phone size={20} strokeWidth={2.5} />
        </button>
      {/if}
      {#if onStartVideoCall}
        <button
          onclick={onStartVideoCall}
          aria-label={m.chat_video_call_label()}
          title={m.chat_video_call_label()}
          class="text-text-muted hover:text-text-main rounded-xl p-2.5 transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
        >
          <Video size={20} strokeWidth={2.5} />
        </button>
      {/if}
    {/if}

    {#if onOpenMembers}
      <button
        onclick={onOpenMembers}
        aria-label={m.chat_channel_members_title()}
        title={m.common_members_label()}
        aria-pressed={membersActive}
        class="rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {membersActive
          ? 'bg-amber-500/10 text-amber-500'
          : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      >
        <Users size={20} strokeWidth={2.5} />
      </button>
    {/if}

    {#if onOpenMedia}
      <button
        onclick={onOpenMedia}
        aria-label={m.chat_media_links_files_label()}
        title={m.chat_media_links_files_label()}
        class="text-text-muted hover:text-text-main rounded-xl p-2.5 transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      >
        <Images size={20} strokeWidth={2.5} />
      </button>
    {/if}

    {#if onToggleSearch}
      <button
        onclick={onToggleSearch}
        aria-label={m.chat_search_in_conversation_label()}
        title={m.chat_search_title()}
        class="rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {searchActive
          ? 'bg-amber-500/10 text-amber-500'
          : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      >
        <Search size={20} strokeWidth={2.5} />
      </button>
    {/if}

    <button
      onclick={onOpenSettings
        ? onOpenSettings
        : () => {
            showPanel = true;
          }}
      aria-label={isChannel
        ? m.chat_channel_settings_label()
        : isGroupConversation
          ? m.chat_group_settings_label()
          : m.chat_dm_settings_label()}
      class="text-text-muted hover:text-text-main rounded-xl p-2.5 transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      title={m.chat_settings_title()}
    >
      <Settings size={20} strokeWidth={2.5} />
    </button>
  </div>

  <!-- Group / DM settings panel -->
  <ChatGroupPanel
    {showPanel}
    {effectiveDisplayName}
    {contactName}
    {groupId}
    {isReady}
    {isGroupConversation}
    {imageMediaId}
    currentUserId={currentUserId ?? ''}
    {groupMembers}
    {pendingInvites}
    onClose={() => {
      showPanel = false;
    }}
    onRename={onGroupRename}
    onSetImage={onGroupSetImage}
    onRemoveMember={onGroupRemoveMember}
    {onGroupDelete}
    {onGroupLeave}
    {onInviteMembers}
  />
</header>
