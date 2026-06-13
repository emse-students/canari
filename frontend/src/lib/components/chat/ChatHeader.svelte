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
  } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import ChatGroupPanel from './ChatGroupPanel.svelte';
  import { presenceMap, watchUsers, unwatchUsers } from '$lib/stores/presenceStore';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    /** Raw contact/user ID used for presence lookup and avatar resolution. */
    contactName: string;
    /** Human-readable name displayed in the header. */
    displayName: string;
    /** Whether the MLS session is fully established. */
    isReady: boolean;
    /** Whether the conversation is a group (vs. a direct message). */
    isGroupConversation?: boolean;
    /** Whether the conversation is a community channel. */
    isChannel?: boolean;
    /** Optional media ID for the group or channel avatar image. */
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
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Callback to rename the group. */
    onGroupRename?: (name: string) => void;
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
    /** Callback to open the channel members sidebar. */
    onOpenMembers?: () => void;
    /** Callback to start an audio-only call. */
    onStartAudioCall?: () => void;
    /** Callback to start a video call. */
    onStartVideoCall?: () => void;
  }

  let {
    contactName,
    displayName,
    isReady,
    isGroupConversation = true,
    isChannel = false,
    imageMediaId = null,
    onInviteMembers,
    onBack,
    groupMembers = [],
    currentUserId = '',
    onGroupRename,
    onGroupDelete,
    onGroupLeave,
    onGroupRemoveMember,
    onOpenSettings,
    onOpenMedia,
    onToggleSearch,
    searchActive = false,
    onOpenMembers,
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

<!-- En-tête principal -->
<header
  class="bg-white/70 dark:bg-black/50 px-3 md:px-6 py-3 border-b border-black/5 dark:border-white/10 flex items-center gap-3 md:gap-4 relative backdrop-blur-2xl z-20"
>
  <!-- Bouton Retour (Mobile) - largeur fixe pour que l'avatar soit centré -->
  <div class="w-8 flex-shrink-0 flex items-center justify-start md:hidden">
    {#if onBack}
      <button
        onclick={onBack}
        aria-label="Retour au menu"
        class="p-1 rounded-xl text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <ChevronLeft size={24} />
      </button>
    {/if}
  </div>

  <!-- Icône de la conversation (Avatar, Groupe ou Canal) -->
  {#if isChannel}
    <div class="w-10 h-10 flex-shrink-0 flex items-center justify-center">
      <GroupAvatar {imageMediaId} name={displayName} variant="channel" size="lg" />
    </div>
  {:else if isGroupConversation}
    <div class="w-10 h-10 flex-shrink-0 flex items-center justify-center">
      <GroupAvatar {imageMediaId} name={displayName} variant="group" size="lg" />
    </div>
  {:else}
    <div class="relative shrink-0 w-10 h-10 flex items-center justify-center">
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
      {#if isOnline}
        <span
          class="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-zinc-900 bg-green-500 shadow-sm"
        ></span>
      {/if}
    </div>
  {/if}

  <!-- Informations (Nom, Statut) -->
  <div class="flex-1 min-w-0 flex flex-col justify-center">
    <h2 class="text-base md:text-[1.05rem] font-bold text-text-main mb-0.5 truncate leading-tight">
      {effectiveDisplayName}
    </h2>

    {#if isChannel}
      <span
        class="inline-flex items-center text-[0.7rem] md:text-xs font-semibold text-text-muted uppercase tracking-wider"
      >
        Canal de communauté
      </span>
    {:else}
      <LockKeyhole
        size={12}
        strokeWidth={2.5}
        class={isReady
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'animate-pulse text-amber-600 dark:text-amber-500'}
        title={isReady ? 'Chiffrement bout-en-bout vérifié' : 'Négociation sécurisée en cours…'}
      />
    {/if}
  </div>


  <!-- Actions (Appels, Membres, Recherche, Paramètres) -->
  <div class="flex items-center gap-1 shrink-0">
    {#if showCallButtons}
      {#if onStartAudioCall}
        <button
          onclick={onStartAudioCall}
          aria-label="Appel audio"
          title="Appel audio"
          class="p-2.5 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
        >
          <Phone size={20} strokeWidth={2.5} />
        </button>
      {/if}
      {#if onStartVideoCall}
        <button
          onclick={onStartVideoCall}
          aria-label="Appel vidéo"
          title="Appel vidéo"
          class="p-2.5 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
        >
          <Video size={20} strokeWidth={2.5} />
        </button>
      {/if}
    {/if}

    {#if onOpenMembers}
      <button
        onclick={onOpenMembers}
        aria-label="Membres du canal"
        title="Membres"
        class="p-2.5 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
      >
        <Users size={20} strokeWidth={2.5} />
      </button>
    {/if}

    {#if onOpenMedia}
      <button
        onclick={onOpenMedia}
        aria-label="Médias, liens et fichiers"
        title="Médias, liens et fichiers"
        class="p-2.5 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
      >
        <Images size={20} strokeWidth={2.5} />
      </button>
    {/if}

    {#if onToggleSearch}
      <button
        onclick={onToggleSearch}
        aria-label="Rechercher dans la conversation"
        title="Rechercher"
        class="p-2.5 rounded-xl transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {searchActive
          ? 'text-amber-500 bg-amber-500/10'
          : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
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
        ? 'Paramètres du canal'
        : isGroupConversation
          ? 'Paramètres du groupe'
          : 'Paramètres de la discussion'}
      class="p-2.5 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
      title="Paramètres"
    >
      <Settings size={20} strokeWidth={2.5} />
    </button>
  </div>

  <!-- Panneau de paramètres du groupe / DM -->
  <ChatGroupPanel
    {showPanel}
    {effectiveDisplayName}
    {contactName}
    {isReady}
    {isGroupConversation}
    currentUserId={currentUserId ?? ''}
    {groupMembers}
    onClose={() => {
      showPanel = false;
    }}
    onRename={onGroupRename}
    onRemoveMember={onGroupRemoveMember}
    {onGroupDelete}
    {onGroupLeave}
    {onInviteMembers}
  />
</header>
