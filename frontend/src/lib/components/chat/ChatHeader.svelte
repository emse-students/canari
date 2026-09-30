<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
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
    Ellipsis,
  } from '@lucide/svelte';
  import GlassMenuButton, {
    type GlassMenuItem,
  } from '$lib/components/shared/GlassMenuButton.svelte';
  import { usesGlassChrome } from '$lib/mobile/glassChrome';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
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

  /** The phone apps draw the glass header; the website keeps the classic one (`usesGlassChrome`). */
  const glass = usesGlassChrome();

  const settingsLabel = $derived(
    isChannel
      ? m.chat_channel_settings_label()
      : isGroupConversation
        ? m.chat_group_settings_label()
        : m.chat_dm_settings_label()
  );

  /**
   * THE ACTIONS THE PHONE HEADER'S MENU GROWS INTO - the same ones, under the same conditions, as the
   * desktop header's row of icons below, so the two cannot offer different things (user, 2026-09-30:
   * a back and a menu button that grows to show the other options).
   */
  const menuItems = $derived.by((): GlassMenuItem[] => {
    const items: GlassMenuItem[] = [];
    if (showCallButtons && onStartAudioCall) {
      items.push({
        id: 'audio',
        label: m.chat_audio_call_label(),
        icon: Phone,
        onSelect: onStartAudioCall,
      });
    }
    if (showCallButtons && onStartVideoCall) {
      items.push({
        id: 'video',
        label: m.chat_video_call_label(),
        icon: Video,
        onSelect: onStartVideoCall,
      });
    }
    if (onOpenMembers) {
      items.push({
        id: 'members',
        label: m.common_members_label(),
        icon: Users,
        onSelect: onOpenMembers,
        active: membersActive,
      });
    }
    if (onOpenMedia) {
      items.push({
        id: 'media',
        label: m.chat_media_links_files_label(),
        icon: Images,
        onSelect: onOpenMedia,
      });
    }
    if (onToggleSearch) {
      items.push({
        id: 'search',
        label: m.chat_search_title(),
        icon: Search,
        onSelect: onToggleSearch,
        active: searchActive,
      });
    }
    items.push({
      id: 'settings',
      label: m.chat_settings_title(),
      icon: Settings,
      onSelect: () => onOpenSettings?.(),
    });
    return items;
  });

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
</script>

<!--
  IN THE PHONE APPS THE HEADER IS THREE PIECES OF GLASS FLOATING OVER THE CONVERSATION (user,
  2026-09-30) - back, the conversation in a centre pill, and a menu that grows into the actions. It
  draws no bar of its own: `ChatArea` floats it over the messages and reserves its height, so the
  thread scrolls under the glass. The website keeps the header below, at every width.
-->
{#if glass}
  <div class="chat-header-phone flex items-center gap-2 px-3 py-2 md:hidden">
    {#if onBack}
      <button
        type="button"
        onclick={onBack}
        aria-label={m.chat_back_label()}
        title={m.chat_back_label()}
        class="glass-chrome ui-icon-button text-text-main rounded-full transition-transform outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
      >
        <ChevronLeft size={22} strokeWidth={2.25} />
      </button>
    {/if}

    <div class="flex min-w-0 flex-1 justify-center">
      <button
        type="button"
        onclick={() => onOpenSettings?.()}
        aria-label={settingsLabel}
        class="glass-chrome flex max-w-full min-w-0 items-center gap-2 rounded-full py-1 pr-4 pl-1 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-[0.98]"
      >
        {#if isChannel}
          <span class="text-text-muted flex h-8 w-8 shrink-0 items-center justify-center">
            <Hash size={18} strokeWidth={2.5} />
          </span>
        {:else if isGroupConversation}
          <span class="flex h-8 w-8 shrink-0 items-center justify-center">
            <GroupAvatar {imageMediaId} name={displayName} variant="group" size="md" />
          </span>
        {:else}
          <span class="relative flex h-8 w-8 shrink-0 items-center justify-center">
            <Avatar userId={contactName} size="md" fallbackLabel={effectiveDisplayName} />
            {#if isOnline}
              <span
                class="absolute right-0 bottom-0 block h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-white dark:ring-zinc-900"
              ></span>
            {/if}
          </span>
        {/if}
        <span class="text-text-main min-w-0 truncate text-sm font-bold">
          <EmojiText text={effectiveDisplayName} />
        </span>
      </button>
    </div>

    <GlassMenuButton
      icon={Ellipsis}
      label={m.chat_more_actions_label()}
      items={menuItems}
      alignEnd
    />
  </div>
{/if}

<!-- The classic header: the website at every width, and the apps from `md` up. -->
<header
  class="bg-cn-surface relative z-20 items-center gap-3 border-b border-black/5 px-3 py-3 md:flex md:gap-4 md:px-6 dark:border-white/10 {glass
    ? 'hidden'
    : 'flex'}"
>
  <!-- Back button (mobile) - fixed width so the avatar stays centered -->
  <div class="flex w-8 shrink-0 items-center justify-start md:hidden">
    {#if onBack}
      <button
        onclick={onBack}
        aria-label={m.chat_back_label()}
        class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      >
        <ChevronLeft size={24} />
      </button>
    {/if}
  </div>

  <!-- Conversation icon (avatar for groups/DMs; channels show no avatar, only a type icon) -->
  {#if isChannel}
    <div class="text-text-muted flex h-10 w-10 shrink-0 items-center justify-center">
      <Hash size={22} strokeWidth={2.5} />
    </div>
  {:else if isGroupConversation}
    <div class="flex h-10 w-10 shrink-0 items-center justify-center">
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
    <h2 class="text-text-main mb-0.5 truncate text-base leading-tight font-bold md:text-base">
      <EmojiText text={effectiveDisplayName} />
    </h2>

    {#if isChannel}
      <span
        class="text-text-muted text-2xs inline-flex items-center font-semibold tracking-wider uppercase md:text-xs"
      >
        {m.chat_community_channel_label()}
      </span>
    {:else}
      <!--
        ONE LOCK, ONE COLOUR, ONE TITLE - AND IT IS ABOUT THE CONVERSATION, NOT ABOUT THIS DEVICE.
        It forked on `isReady` (`lifecycle === 'active'`, i.e. this device holds MLS state) and
        turned amber with a "not joined" title, which told the user about a transient the recovery
        ladder owns and can close by itself: a device holding a roster seat nobody owes a Welcome
        for joins by external commit with no member involved. The conversation is end-to-end
        encrypted either way, so the lock states that and nothing else.
      -->
      <LockKeyhole
        size={12}
        strokeWidth={2.5}
        class="text-emerald-600 dark:text-emerald-400"
        title={m.chat_e2e_verified_title()}
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
          class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
        >
          <Phone size={20} strokeWidth={2.5} />
        </button>
      {/if}
      {#if onStartVideoCall}
        <button
          onclick={onStartVideoCall}
          aria-label={m.chat_video_call_label()}
          title={m.chat_video_call_label()}
          class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
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
        class="ui-icon-button rounded-xl transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {membersActive
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
        class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      >
        <Images size={20} strokeWidth={2.5} />
      </button>
    {/if}

    {#if onToggleSearch}
      <button
        onclick={onToggleSearch}
        aria-label={m.chat_search_in_conversation_label()}
        title={m.chat_search_title()}
        class="ui-icon-button rounded-xl transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {searchActive
          ? 'bg-amber-500/10 text-amber-500'
          : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      >
        <Search size={20} strokeWidth={2.5} />
      </button>
    {/if}

    <!--
      ONE HANDLER, ALWAYS THE PARENT'S. This used to fall back to a local `showPanel` when
      `onOpenSettings` was absent, and that fallback WAS the divergence: a channel's settings went
      up to the page and opened a modal, while a group's stayed here and opened a portalled sheet
      this component mounted itself. The page decides which panel now, so there is nothing to fall
      back to.
    -->
    <button
      onclick={onOpenSettings}
      aria-label={isChannel
        ? m.chat_channel_settings_label()
        : isGroupConversation
          ? m.chat_group_settings_label()
          : m.chat_dm_settings_label()}
      class="ui-icon-button text-text-muted hover:text-text-main rounded-xl transition-all outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:hover:bg-white/10"
      title={m.chat_settings_title()}
    >
      <Settings size={20} strokeWidth={2.5} />
    </button>
  </div>
</header>
