<script lang="ts">
  import {
    ChevronLeft,
    LockKeyhole,
    Clock,
    Settings,
    Search,
    Trash2,
    UserMinus,
    Check,
    UserPlus,
    Users,
    X,
    PencilLine,
    Shield,
  } from 'lucide-svelte';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import Modal from '../shared/Modal.svelte';
  import MultiUserSelector from '../shared/MultiUserSelector.svelte';
  import { portal } from '$lib/actions/portal';
  import { presenceMap, watchUsers } from '$lib/stores/presenceStore';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { fade, fly } from 'svelte/transition';

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    isGroupConversation?: boolean;
    isChannel?: boolean;
    imageMediaId?: string | null;
    onInviteMembers?: (ids: string[]) => void;
    onBack?: () => void;
    onOpenSettings?: () => void;
    // Group management
    groupMembers?: string[];
    currentUserId?: string;
    onGroupRename?: (name: string) => void;
    onGroupDelete?: () => void;
    onGroupRemoveMember?: (userId: string) => void;
    onStartCall?: () => void;
    onToggleSearch?: () => void;
    searchActive?: boolean;
    onOpenMembers?: () => void;
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
    onGroupRemoveMember,
    onOpenSettings,
    onToggleSearch,
    searchActive = false,
    onOpenMembers,
  }: Props = $props();

  let showPanel = $state(false);
  let showInviteModal = $state(false);
  let newMembers = $state<string[]>([]);
  let renameInput = $state('');
  let confirmDelete = $state(false);

  let isOnline = $derived($presenceMap[contactName] || false);
  let resolvedContactDisplayName = $state('');

  const effectiveDisplayName = $derived(
    !isGroupConversation && !isChannel ? resolvedContactDisplayName : displayName
  );

  $effect(() => {
    if (contactName && !isGroupConversation && !isChannel) {
      watchUsers([contactName]);
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

  function handleInviteMembers() {
    if (newMembers.length > 0 && onInviteMembers) {
      onInviteMembers(newMembers);
      newMembers = [];
      showInviteModal = false;
    }
  }

  function openPanel() {
    renameInput = displayName;
    confirmDelete = false;
    showPanel = true;
  }

  function closePanel() {
    showPanel = false;
    confirmDelete = false;
  }

  function submitRename() {
    const name = renameInput.trim();
    if (name && name !== displayName) {
      onGroupRename?.(name);
    }
    showPanel = false;
  }

  function handleRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') closePanel();
  }

  function handlePanelKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showPanel) {
      closePanel();
    }
  }

  const panelTitle = $derived(isGroupConversation ? 'Gestion du groupe' : 'Infos de la discussion');

  const panelSubtitle = $derived(
    isGroupConversation
      ? 'Organisez les membres, le nom et la suppression.'
      : 'Cette discussion est privée entre deux participants.'
  );
</script>

<svelte:window onkeydown={handlePanelKeydown} />

<!-- En-tête principal -->
<header
  class="bg-white/70 dark:bg-black/50 px-3 md:px-6 py-3 border-b border-black/5 dark:border-white/10 flex items-center gap-3 md:gap-4 relative backdrop-blur-2xl z-20"
>
  <!-- Bouton Retour (Mobile) — largeur fixe pour que l'avatar soit centré -->
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
      <span
        class="inline-flex items-center gap-1.5 text-[0.7rem] md:text-xs font-bold {isReady
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-amber-600 dark:text-amber-500'}"
      >
        {#if isReady}
          <LockKeyhole size={12} strokeWidth={2.5} /> Bout-en-bout vérifié
        {:else}
          <Clock size={12} strokeWidth={2.5} class="animate-pulse" /> Négociation sécurisée...
        {/if}
      </span>
    {/if}
  </div>

  <!-- Actions (Appel, Paramètres) -->
  <div class="flex items-center gap-1 shrink-0">
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
      onclick={onOpenSettings ? onOpenSettings : openPanel}
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

  <!-- PANNEAU DES PARAMÈTRES (Sidebar droite) -->
  {#if showPanel}
    <div use:portal class="fixed inset-0 z-[260] pointer-events-none flex justify-end">
      <!-- Overlay sombre cliquable pour fermer -->
      <button
        type="button"
        class="absolute inset-0 bg-black/40 backdrop-blur-sm border-0 pointer-events-auto outline-none transition-opacity"
        aria-label="Fermer les paramètres du groupe"
        onclick={closePanel}
        transition:fade={{ duration: 250 }}
      ></button>

      <!-- Contenu du panneau -->
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paramètres du groupe"
        class="relative pointer-events-auto w-full md:w-[28rem] h-full bg-white/85 dark:bg-[#151B2C]/95 border-l border-black/5 dark:border-white/10 shadow-[-10px_0_30px_rgba(0,0,0,0.1)] dark:shadow-[-10px_0_30px_rgba(0,0,0,0.4)] backdrop-blur-3xl flex flex-col overflow-hidden text-text-main"
        transition:fly={{ x: 20, duration: 300, easing: (t) => t * (2 - t) }}
      >
        <!-- En-tête du panneau -->
        <div
          class="px-5 md:px-6 py-5 border-b border-black/5 dark:border-white/10 flex items-start justify-between gap-3 bg-white/40 dark:bg-black/20"
        >
          <div class="min-w-0">
            <h3 class="text-lg font-extrabold text-text-main truncate tracking-wide">
              {panelTitle}
            </h3>
            <p class="text-xs font-medium text-text-muted mt-1 leading-snug">{panelSubtitle}</p>
          </div>
          <button
            onclick={closePanel}
            class="p-2.5 rounded-full bg-black/5 dark:bg-white/10 text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0"
            aria-label="Fermer"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>

        <!-- Contenu scrollable -->
        <div class="flex-1 min-h-0 overflow-y-auto p-5 md:p-6 flex flex-col gap-6">
          <!-- Carte d'identité du groupe/contact -->
          <div
            class="rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 px-4 py-4 flex items-center gap-4 shadow-sm"
          >
            {#if isGroupConversation}
              <div
                class="w-[3.25rem] h-[3.25rem] rounded-2xl flex-shrink-0 bg-gradient-to-b from-gray-100 to-gray-200 dark:from-zinc-800 dark:to-zinc-900 border border-black/5 dark:border-white/5 text-gray-600 dark:text-gray-300 flex items-center justify-center shadow-inner"
              >
                <Users size={24} strokeWidth={2} />
              </div>
            {:else}
              <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
            {/if}
            <div class="min-w-0 flex-1">
              <div class="text-[1.05rem] font-extrabold text-text-main truncate mb-1">
                {effectiveDisplayName}
              </div>
              <div
                class="text-[0.7rem] font-bold text-text-muted inline-flex items-center gap-1.5 uppercase tracking-wider"
              >
                {#if isReady}
                  <Shield size={14} class="text-emerald-500" strokeWidth={2.5} />
                  Sécurisé & Sync
                {:else}
                  <Clock size={14} class="text-amber-500 animate-pulse" strokeWidth={2.5} />
                  Synchronisation...
                {/if}
              </div>
            </div>
          </div>

          <!-- Section Renommer -->
          {#if isGroupConversation}
            <div
              class="rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-4 md:p-5 flex flex-col gap-3 shadow-sm"
            >
              <label
                for="group-rename-input"
                class="text-[0.75rem] text-text-muted font-bold uppercase tracking-wider inline-flex items-center gap-2 mb-1"
              >
                <PencilLine size={14} /> Nom du groupe
              </label>
              <div class="flex flex-col sm:flex-row gap-3">
                <input
                  id="group-rename-input"
                  type="text"
                  bind:value={renameInput}
                  onkeydown={handleRenameKey}
                  class="flex-1 px-4 py-3 border border-black/10 dark:border-white/10 rounded-xl text-sm font-semibold outline-none bg-white/80 dark:bg-black/40 text-text-main focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 shadow-inner transition-all"
                />
                <button
                  onclick={submitRename}
                  class="inline-flex items-center justify-center gap-2 px-5 py-3 bg-amber-500 text-[#151B2C] font-bold rounded-xl hover:bg-amber-400 active:scale-95 transition-all shadow-sm shadow-amber-500/20 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  aria-label="Valider le renommage"
                >
                  <Check size={16} strokeWidth={3} />
                  Valider
                </button>
              </div>
            </div>
          {/if}

          <!-- Section Membres -->
          {#if isGroupConversation}
            <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2 px-1">
                <span
                  class="text-[0.75rem] text-text-muted font-bold uppercase tracking-wider inline-flex items-center gap-2"
                >
                  <Users size={14} /> Membres ({groupMembers.length})
                </span>
                <button
                  type="button"
                  onclick={() => {
                    showInviteModal = true;
                  }}
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 text-[0.75rem] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  <UserPlus size={14} strokeWidth={2.5} />
                  Ajouter
                </button>
              </div>

              {#if groupMembers.length > 0}
                <div
                  class="rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 overflow-hidden shadow-sm"
                >
                  <ul class="flex flex-col max-h-[35dvh] overflow-y-auto">
                    {#each groupMembers as member, index (member)}
                      <li
                        class="flex items-center justify-between gap-3 px-4 py-3.5 {index !==
                        groupMembers.length - 1
                          ? 'border-b border-black/5 dark:border-white/5'
                          : ''}"
                      >
                        <div class="flex items-center gap-3 min-w-0">
                          <Avatar userId={member} size="sm" />
                          <UserName
                            userId={member}
                            class="text-[0.9rem] font-semibold text-text-main truncate"
                          />
                          {#if currentUserId && member.toLowerCase() === currentUserId.toLowerCase()}
                            <span
                              class="text-[0.65rem] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-md shrink-0"
                              >Vous</span
                            >
                          {/if}
                        </div>

                        {#if onGroupRemoveMember}
                          <button
                            onclick={() => onGroupRemoveMember?.(member)}
                            aria-label="Retirer {member}"
                            title="Retirer du groupe"
                            class="p-2 rounded-xl bg-black/5 dark:bg-white/5 text-text-muted hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all flex-shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                          >
                            <UserMinus size={16} />
                          </button>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {:else}
                <div
                  class="rounded-[1.5rem] border border-dashed border-black/10 dark:border-white/20 bg-white/30 dark:bg-black/10 px-4 py-6 text-center text-sm font-medium text-text-muted"
                >
                  Aucun membre à afficher.
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Section Suppression (Pied du panneau) -->
        {#if onGroupDelete}
          <div
            class="mt-auto border-t border-black/5 dark:border-white/10 p-5 md:p-6 bg-white/40 dark:bg-black/30 backdrop-blur-md"
          >
            {#if !confirmDelete}
              <button
                onclick={() => {
                  confirmDelete = true;
                }}
                class="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 text-red-600 dark:text-red-400 font-bold bg-red-500/10 border border-red-500/20 rounded-2xl text-[0.95rem] hover:bg-red-500/20 active:scale-[0.98] transition-all outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <Trash2 size={18} strokeWidth={2.5} />
                Supprimer {isGroupConversation ? 'le groupe' : 'la discussion'}
              </button>
            {:else}
              <div class="flex flex-col gap-3" transition:fade={{ duration: 150 }}>
                <p
                  class="text-[0.8rem] font-bold uppercase tracking-wider text-red-500 text-center"
                >
                  Confirmer la suppression ?
                </p>
                <div class="flex gap-3">
                  <button
                    onclick={() => {
                      confirmDelete = false;
                    }}
                    class="flex-1 px-4 py-3.5 border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 rounded-2xl font-bold text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-[0.98] transition-all outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
                  >
                    Annuler
                  </button>
                  <button
                    onclick={() => {
                      onGroupDelete?.();
                      closePanel();
                    }}
                    class="flex-1 px-4 py-3.5 bg-red-500 text-white rounded-2xl font-bold hover:bg-red-600 active:scale-[0.98] transition-all shadow-md shadow-red-500/20 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Supprimer
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Modal d'invitation -->
  <Modal
    open={showInviteModal}
    onClose={() => {
      showInviteModal = false;
      newMembers = [];
    }}
    title="Ajouter des membres"
  >
    <div class="space-y-5 px-1">
      <p class="text-sm font-medium text-text-muted leading-relaxed">
        Sélectionnez un ou plusieurs utilisateurs à inviter dans <span
          class="font-bold text-text-main">{displayName}</span
        > en une seule opération.
      </p>

      <MultiUserSelector
        users={newMembers}
        onUsersChange={(users) => {
          newMembers = users;
        }}
        placeholder="Identifiant de l'utilisateur..."
      />

      <button
        onclick={handleInviteMembers}
        disabled={newMembers.length === 0}
        class="w-full py-3.5 bg-amber-500 text-[#151B2C] font-extrabold rounded-2xl hover:bg-amber-400 hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-amber-500/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 mt-2"
      >
        Envoyer l'invitation {newMembers.length > 0 ? `(${newMembers.length})` : ''}
      </button>
    </div>
  </Modal>
</header>
