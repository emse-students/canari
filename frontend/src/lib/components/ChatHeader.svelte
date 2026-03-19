<script lang="ts">
  import {
    ChevronLeft,
    PanelLeft,
    LockKeyhole,
    Clock,
    Settings,
    Trash2,
    UserMinus,
    Check,
    UserPlus,
    Users,
    X,
    PencilLine,
    Shield,
  } from 'lucide-svelte';
  import Avatar from './Avatar.svelte';
  import Modal from './Modal.svelte';
  import MultiUserSelector from './MultiUserSelector.svelte';
  import { portal } from '$lib/actions/portal';

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    isGroupConversation?: boolean;
    onInviteMembers?: (ids: string[]) => void;
    onBack?: () => void;
    onOpenConversations?: () => void;
    // Group management
    groupMembers?: string[];
    onGroupRename?: (name: string) => void;
    onGroupDelete?: () => void;
    onGroupRemoveMember?: (userId: string) => void;
  }

  let {
    contactName,
    displayName,
    isReady,
    isGroupConversation = true,
    onInviteMembers,
    onBack,
    onOpenConversations,
    groupMembers = [],
    onGroupRename,
    onGroupDelete,
    onGroupRemoveMember,
  }: Props = $props();

  let showPanel = $state(false);
  let showInviteModal = $state(false);
  let newMembers = $state<string[]>([]);
  let renameInput = $state('');
  let confirmDelete = $state(false);

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
      ? 'Organisez les membres, le nom et la suppression dans un seul panneau.'
      : 'Cette discussion est privee entre deux participants.'
  );
</script>

<svelte:window onkeydown={handlePanelKeydown} />

<header
  class="bg-white/40 dark:bg-gray-900/50 px-3 md:px-6 py-3 border-b border-white/50 dark:border-white/10 flex items-center gap-3 md:gap-4 relative backdrop-blur-md"
>
  <div class="flex items-center gap-1 md:hidden">
    {#if onOpenConversations}
      <button
        onclick={onOpenConversations}
        aria-label="Ouvrir les conversations"
        class="p-1.5 text-cn-dark"
      >
        <PanelLeft size={20} />
      </button>
    {/if}

    <!-- Back button (mobile) -->
    {#if onBack}
      <button onclick={onBack} aria-label="Retour au menu" class="p-1.5 text-cn-dark">
        <ChevronLeft size={22} />
      </button>
    {/if}
  </div>

  <Avatar userId={contactName} size="lg" />

  <!-- Meta -->
  <div class="flex-1 min-w-0">
    <h2 class="text-base md:text-lg font-semibold text-cn-dark mb-1 truncate">{displayName}</h2>
    <span
      class="inline-flex items-center gap-1.5 text-[0.7rem] md:text-xs font-semibold {isReady
        ? 'text-green-500'
        : 'text-amber-600'}"
    >
      {#if isReady}
        <LockKeyhole size={14} /> Bout-en-bout vérifié
      {:else}
        <Clock size={14} /> Négociation cryptographique...
      {/if}
    </span>
  </div>

  <!-- Group settings button -->
  <button
    onclick={openPanel}
    aria-label={isGroupConversation ? 'Paramètres du groupe' : 'Paramètres de la discussion'}
    class="p-2 rounded-lg text-text-muted hover:bg-white/40 dark:hover:bg-black/35 hover:text-cn-dark transition-colors"
  >
    <Settings size={18} />
  </button>

  {#if showPanel}
    <div use:portal class="fixed inset-0 z-[260] pointer-events-none">
      <button
        type="button"
        class="absolute inset-0 bg-slate-950/45 backdrop-blur-sm border-0 pointer-events-auto"
        aria-label="Fermer les parametres du groupe"
        onclick={closePanel}
      ></button>

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Parametres du groupe"
        class="absolute pointer-events-auto inset-x-3 top-4 bottom-4 md:inset-x-auto md:right-8 md:top-20 md:bottom-auto md:w-[34rem] md:max-h-[85dvh] bg-white/70 dark:bg-slate-950/80 border border-white/55 dark:border-white/10 rounded-3xl shadow-[0_28px_90px_rgba(2,6,23,0.45)] backdrop-blur-xl flex flex-col overflow-hidden text-text-main"
      >
        <div
          class="px-4 md:px-6 py-4 border-b border-white/60 dark:border-white/10 flex items-start justify-between gap-3"
        >
          <div class="min-w-0">
            <h3 class="text-lg font-extrabold text-cn-dark truncate">{panelTitle}</h3>
            <p class="text-xs text-text-muted mt-1">{panelSubtitle}</p>
          </div>
          <button
            onclick={closePanel}
            class="p-2 rounded-xl bg-white/65 dark:bg-black/35 border border-white/60 dark:border-white/10 text-text-muted hover:text-cn-dark hover:bg-white/90 dark:hover:bg-black/55 transition-colors"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 flex flex-col gap-5">
          <div
            class="rounded-2xl border border-white/60 dark:border-white/10 bg-white/65 dark:bg-black/25 px-4 py-3 flex items-center gap-3"
          >
            <Avatar userId={contactName} size="lg" />
            <div class="min-w-0 flex-1">
              <div class="text-base font-bold text-cn-dark truncate">{displayName}</div>
              <div class="text-xs text-text-muted mt-0.5 inline-flex items-center gap-1.5">
                {#if isReady}
                  <Shield size={12} class="text-emerald-500" />
                  Groupe pret, securise et synchronise
                {:else}
                  <Clock size={12} class="text-amber-500" />
                  Synchronisation en cours
                {/if}
              </div>
            </div>
          </div>

          {#if isGroupConversation}
            <div
              class="rounded-2xl border border-white/60 dark:border-white/10 bg-white/55 dark:bg-black/25 p-4 flex flex-col gap-2"
            >
              <label
                for="group-rename-input"
                class="text-xs text-text-muted font-semibold inline-flex items-center gap-1.5"
              >
                <PencilLine size={12} /> Renommer le groupe
              </label>
              <div class="flex gap-2.5">
                <input
                  id="group-rename-input"
                  type="text"
                  bind:value={renameInput}
                  onkeydown={handleRenameKey}
                  class="flex-1 px-3 py-2.5 border border-white/65 dark:border-white/10 rounded-xl text-sm outline-none bg-white/70 dark:bg-black/35 text-text-main focus:ring-2 focus:ring-amber-400/40"
                />
                <button
                  onclick={submitRename}
                  class="inline-flex items-center gap-1.5 px-3 py-2.5 bg-amber-500 text-white rounded-xl hover:bg-amber-400 transition-colors"
                  aria-label="Valider le renommage"
                >
                  <Check size={14} />
                  Valider
                </button>
              </div>
            </div>
          {:else}
            <div
              class="rounded-2xl border border-white/60 dark:border-white/10 bg-white/55 dark:bg-black/25 p-3 text-sm text-text-muted"
            >
              Cette discussion privee est entre deux participants.
            </div>
          {/if}

          {#if isGroupConversation}
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-text-muted font-semibold inline-flex items-center gap-1">
                  <Users size={12} /> Membres ({groupMembers.length})
                </span>
                <button
                  type="button"
                  onclick={() => {
                    showInviteModal = true;
                  }}
                  class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-semibold hover:bg-amber-400 transition-colors"
                >
                  <UserPlus size={12} />
                  Ajouter
                </button>
              </div>

              {#if groupMembers.length > 0}
                <ul class="flex flex-col gap-2 max-h-[38dvh] overflow-y-auto pr-1.5">
                  {#each groupMembers as member (member)}
                    <li
                      class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-white/70 dark:bg-black/30 border border-white/60 dark:border-white/10"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <Avatar userId={member} size="sm" />
                        <span class="text-sm text-text-main truncate">{member}</span>
                      </div>

                      {#if onGroupRemoveMember}
                        <button
                          onclick={() => {
                            onGroupRemoveMember?.(member);
                          }}
                          aria-label="Retirer {member}"
                          class="px-2.5 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors flex-shrink-0"
                        >
                          <span class="inline-flex items-center gap-1">
                            <UserMinus size={12} /> Retirer
                          </span>
                        </button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <div
                  class="rounded-xl border border-dashed border-white/60 dark:border-white/20 px-3 py-4 text-sm text-text-muted"
                >
                  Aucun membre a afficher.
                </div>
              {/if}
            </div>
          {/if}
        </div>

        {#if isGroupConversation && onGroupDelete}
          <div
            class="border-t border-white/60 dark:border-white/10 px-4 md:px-6 py-4 bg-white/45 dark:bg-black/30"
          >
            {#if !confirmDelete}
              <button
                onclick={() => {
                  confirmDelete = true;
                }}
                class="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-red-600 border border-red-400/45 rounded-xl text-sm hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={14} />
                Supprimer le groupe
              </button>
            {:else}
              <div class="flex flex-col gap-2">
                <p class="text-xs text-red-500 text-center">Confirmer la suppression ?</p>
                <div class="flex gap-2">
                  <button
                    onclick={() => {
                      confirmDelete = false;
                    }}
                    class="flex-1 px-3 py-2.5 border border-white/60 dark:border-white/20 rounded-xl text-sm text-text-main hover:bg-white/60 dark:hover:bg-white/10"
                  >
                    Annuler
                  </button>
                  <button
                    onclick={() => {
                      onGroupDelete?.();
                      closePanel();
                    }}
                    class="flex-1 px-3 py-2.5 bg-red-500 text-white rounded-xl text-sm hover:bg-red-600 transition-colors"
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

  <Modal
    open={showInviteModal}
    onClose={() => {
      showInviteModal = false;
      newMembers = [];
    }}
    title={`Ajouter des membres a ${displayName}`}
  >
    <div class="space-y-4">
      <p class="text-sm text-text-muted">
        Selectionnez plusieurs utilisateurs a inviter en une seule operation.
      </p>

      <MultiUserSelector
        users={newMembers}
        onUsersChange={(users) => {
          newMembers = users;
        }}
        placeholder="Identifiant utilisateur..."
      />

      <button
        onclick={handleInviteMembers}
        disabled={newMembers.length === 0}
        class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Inviter {newMembers.length > 0 ? `(${newMembers.length})` : ''}
      </button>
    </div>
  </Modal>
</header>
