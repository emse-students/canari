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
  } from 'lucide-svelte';
  import Avatar from './Avatar.svelte';
  import Modal from './Modal.svelte';
  import MultiUserSelector from './MultiUserSelector.svelte';

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    onInviteMembers: (ids: string[]) => void;
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
    if (newMembers.length > 0) {
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
</script>

<svelte:window onkeydown={handlePanelKeydown} />

<header
  class="bg-[var(--surface-elevated)] px-3 md:px-6 py-3 border-b border-cn-border flex items-center gap-3 md:gap-4 relative backdrop-blur-sm"
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

  <button
    onclick={() => {
      showInviteModal = true;
    }}
    class="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--cn-bg)_85%,var(--cn-dark)_15%)] text-sm font-medium transition-colors"
  >
    <UserPlus size={16} />
    <span class="hidden md:inline">Ajouter</span>
  </button>

  <!-- Group settings button -->
  <button
    onclick={openPanel}
    aria-label="Paramètres du groupe"
    class="p-2 rounded-lg text-text-muted hover:bg-cn-bg hover:text-cn-dark transition-colors"
  >
    <Settings size={18} />
  </button>

  {#if showPanel}
    <button
      type="button"
      class="fixed inset-0 z-[210] bg-black/45 border-0"
      aria-label="Fermer les parametres du groupe"
      onclick={closePanel}
    ></button>

    <div
      role="dialog"
      aria-modal="true"
      aria-label="Parametres du groupe"
      class="fixed z-[220] inset-x-3 top-4 bottom-4 md:inset-x-auto md:right-8 md:top-20 md:bottom-auto md:w-[34rem] md:max-h-[85dvh] bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
    >
      <div class="px-4 md:px-5 py-3 border-b border-cn-border flex items-center justify-between">
        <h3 class="text-base font-semibold text-cn-dark">Parametres du groupe</h3>
        <button
          onclick={closePanel}
          class="p-1.5 rounded-lg hover:bg-cn-bg transition-colors text-text-muted hover:text-cn-dark"
          aria-label="Fermer"
        >
          <X size={16} />
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-5 py-4 flex flex-col gap-4">
        <div class="rounded-xl border border-cn-border bg-cn-bg p-3 flex flex-col gap-2">
          <label for="group-rename-input" class="text-xs text-text-muted font-semibold">Nom du groupe</label>
          <div class="flex gap-2">
            <input
              id="group-rename-input"
              type="text"
              bind:value={renameInput}
              onkeydown={handleRenameKey}
              class="flex-1 px-3 py-2 border border-cn-border rounded-xl text-sm outline-none bg-[var(--cn-surface)] text-cn-dark"
            />
            <button
              onclick={submitRename}
              class="p-2 bg-cn-dark text-white rounded-xl hover:bg-gray-800 transition-colors"
              aria-label="Valider le renommage"
            >
              <Check size={14} />
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-xs text-text-muted font-semibold inline-flex items-center gap-1">
            <Users size={12} /> Membres ({groupMembers.length})
          </span>

          {#if groupMembers.length > 0}
            <ul class="flex flex-col gap-2 max-h-[38dvh] overflow-y-auto pr-1">
              {#each groupMembers as member (member)}
                <li
                  class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-cn-bg border border-cn-border/70"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <Avatar userId={member} size="sm" />
                    <span class="text-sm text-cn-dark truncate">{member}</span>
                  </div>

                  {#if onGroupRemoveMember}
                    <button
                      onclick={() => {
                        onGroupRemoveMember?.(member);
                      }}
                      aria-label="Retirer {member}"
                      class="px-2.5 py-1.5 text-xs rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors flex-shrink-0"
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
            <div class="rounded-xl border border-dashed border-cn-border px-3 py-4 text-sm text-text-muted">
              Aucun membre a afficher.
            </div>
          {/if}
        </div>
      </div>

      {#if onGroupDelete}
        <div class="border-t border-cn-border px-4 md:px-5 py-3 bg-[var(--cn-surface)]">
          {#if !confirmDelete}
            <button
              onclick={() => {
                confirmDelete = true;
              }}
              class="w-full flex items-center justify-center gap-2 px-3 py-2 text-red-500 border border-red-200 rounded-xl text-sm hover:bg-red-50 transition-colors"
            >
              <Trash2 size={14} /> Supprimer le groupe
            </button>
          {:else}
            <div class="flex flex-col gap-2">
              <p class="text-xs text-red-600 text-center">Confirmer la suppression ?</p>
              <div class="flex gap-2">
                <button
                  onclick={() => {
                    confirmDelete = false;
                  }}
                  class="flex-1 px-3 py-2 border border-cn-border rounded-xl text-sm text-text-muted hover:bg-cn-bg"
                >
                  Annuler
                </button>
                <button
                  onclick={() => {
                    onGroupDelete?.();
                    closePanel();
                  }}
                  class="flex-1 px-3 py-2 bg-red-500 text-white rounded-xl text-sm hover:bg-red-600 transition-colors"
                >
                  Supprimer
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
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
        class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Inviter {newMembers.length > 0 ? `(${newMembers.length})` : ''}
      </button>
    </div>
  </Modal>
</header>
