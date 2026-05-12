<script lang="ts">
  import {
    Clock,
    Trash2,
    LogOut,
    UserMinus,
    Check,
    UserPlus,
    Users,
    X,
    PencilLine,
    Shield,
  } from 'lucide-svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import Modal from '../shared/Modal.svelte';
  import MultiUserSelector from '../shared/MultiUserSelector.svelte';
  import { portal } from '$lib/actions/portal';
  import { fade, fly } from 'svelte/transition';

  /**
   * Props for the ChatGroupPanel component.
   * Renders the slide-in settings panel for a group or DM conversation, including
   * rename, member management, leave/delete actions, and the invite modal.
   */
  interface Props {
    /** Whether the panel is currently visible. */
    showPanel: boolean;
    /** Display name shown in the panel identity card and used to seed the rename input. */
    effectiveDisplayName: string;
    /** Raw user/contact ID used for the DM avatar. */
    contactName: string;
    /** Whether the MLS session is fully established. */
    isReady: boolean;
    /** Whether this is a group conversation (vs. a direct message). */
    isGroupConversation: boolean;
    /** ID of the currently authenticated user (used to label "Vous" in the member list). */
    currentUserId: string;
    /** List of member user IDs in the group. */
    groupMembers: string[];
    /** Callback to close the panel (parent clears showPanel). */
    onClose: () => void;
    /** Callback to rename the group, receiving the new trimmed name. */
    onRename?: (name: string) => void;
    /** Callback to remove a specific member from the group. */
    onRemoveMember?: (userId: string) => void;
    /** Callback to delete the group conversation. */
    onGroupDelete?: () => void;
    /** Callback fired when the current user leaves the group. */
    onGroupLeave?: () => void;
    /** Callback to invite new members by user ID array. */
    onInviteMembers?: (ids: string[]) => void;
  }

  let {
    showPanel,
    effectiveDisplayName,
    contactName,
    isReady,
    isGroupConversation,
    currentUserId,
    groupMembers,
    onClose,
    onRename,
    onRemoveMember,
    onGroupDelete,
    onGroupLeave,
    onInviteMembers,
  }: Props = $props();

  let confirmDelete = $state(false);
  let confirmLeave = $state(false);
  let showInviteModal = $state(false);
  let newMembers = $state<string[]>([]);
  let renameInput = $state('');

  // Reset internal state each time the panel is opened.
  $effect(() => {
    if (showPanel) {
      renameInput = effectiveDisplayName;
      confirmDelete = false;
      confirmLeave = false;
    }
  });

  const panelTitle = $derived(isGroupConversation ? 'Gestion du groupe' : 'Infos de la discussion');
  const panelSubtitle = $derived(
    isGroupConversation
      ? 'Organisez les membres, le nom et la suppression.'
      : 'Cette discussion est privée entre deux participants.'
  );

  function submitRename() {
    const name = renameInput.trim();
    if (name && name !== effectiveDisplayName) {
      onRename?.(name);
    }
    onClose();
  }

  function handleRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') onClose();
  }

  function closePanel() {
    confirmDelete = false;
    confirmLeave = false;
    onClose();
  }

  function handleInviteMembers() {
    if (newMembers.length > 0 && onInviteMembers) {
      onInviteMembers(newMembers);
      newMembers = [];
      showInviteModal = false;
    }
  }
</script>

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
        style="padding-top: max(1.25rem, env(safe-area-inset-top))"
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
      <div
        class="flex-1 min-h-0 overflow-y-auto p-5 md:p-6 flex flex-col gap-6"
        style="padding-bottom: {onGroupDelete
          ? '1.25rem'
          : 'max(1.25rem, env(safe-area-inset-bottom))'}"
      >
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
                onclick={() => { showInviteModal = true; }}
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

                      {#if onRemoveMember}
                        <button
                          onclick={() => onRemoveMember?.(member)}
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

      <!-- Section Quitter / Supprimer (Pied du panneau) -->
      {#if onGroupLeave || onGroupDelete}
        <div
          class="mt-auto border-t border-black/5 dark:border-white/10 p-5 md:p-6 bg-white/40 dark:bg-black/30 backdrop-blur-md flex flex-col gap-3"
          style="padding-bottom: max(1.25rem, env(safe-area-inset-bottom))"
        >
          {#if onGroupLeave && !confirmLeave && !confirmDelete}
            <button
              onclick={() => { confirmLeave = true; }}
              class="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 text-orange-600 dark:text-orange-400 font-bold bg-orange-500/10 border border-orange-500/20 rounded-2xl text-[0.95rem] hover:bg-orange-500/20 active:scale-[0.98] transition-all outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <LogOut size={18} strokeWidth={2.5} />
              Quitter le groupe
            </button>
          {/if}

          {#if confirmLeave}
            <div class="flex flex-col gap-3" transition:fade={{ duration: 150 }}>
              <p
                class="text-[0.8rem] font-bold uppercase tracking-wider text-orange-500 text-center"
              >
                Quitter ce groupe ?
              </p>
              <div class="flex gap-3">
                <button
                  onclick={() => { confirmLeave = false; }}
                  class="flex-1 px-4 py-3.5 border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 rounded-2xl font-bold text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-[0.98] transition-all outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
                >
                  Annuler
                </button>
                <button
                  onclick={() => { onGroupLeave?.(); closePanel(); }}
                  class="flex-1 px-4 py-3.5 bg-orange-500 text-white rounded-2xl font-bold hover:bg-orange-600 active:scale-[0.98] transition-all shadow-md shadow-orange-500/20 outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                >
                  Quitter
                </button>
              </div>
            </div>
          {/if}

          {#if onGroupDelete && !confirmLeave}
            {#if !confirmDelete}
              <button
                onclick={() => { confirmDelete = true; }}
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
                    onclick={() => { confirmDelete = false; }}
                    class="flex-1 px-4 py-3.5 border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 rounded-2xl font-bold text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-[0.98] transition-all outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
                  >
                    Annuler
                  </button>
                  <button
                    onclick={() => { onGroupDelete?.(); closePanel(); }}
                    class="flex-1 px-4 py-3.5 bg-red-500 text-white rounded-2xl font-bold hover:bg-red-600 active:scale-[0.98] transition-all shadow-md shadow-red-500/20 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Supprimer
                  </button>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Modal d'invitation -->
<Modal
  open={showInviteModal}
  onClose={() => { showInviteModal = false; newMembers = []; }}
  title="Ajouter des membres"
>
  <div class="space-y-5 px-1">
    <p class="text-sm font-medium text-text-muted leading-relaxed">
      Sélectionnez un ou plusieurs utilisateurs à inviter dans <span
        class="font-bold text-text-main">{effectiveDisplayName}</span
      > en une seule opération.
    </p>

    <MultiUserSelector
      users={newMembers}
      onUsersChange={(users) => { newMembers = users; }}
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
