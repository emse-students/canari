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

  function submitRename() {
    const name = renameInput.trim();
    if (name && name !== displayName) {
      onGroupRename?.(name);
    }
    showPanel = false;
  }

  function handleRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') showPanel = false;
  }
</script>

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

  <Modal
    open={showPanel}
    onClose={() => {
      showPanel = false;
    }}
    title="Parametres du groupe"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <label for="group-rename-input" class="text-xs text-text-muted font-medium"
          >Nom du groupe</label
        >
        <div class="flex gap-2">
          <input
            id="group-rename-input"
            type="text"
            bind:value={renameInput}
            onkeydown={handleRenameKey}
            class="flex-1 px-3 py-2 border border-cn-border rounded-xl text-sm outline-none bg-[var(--cn-bg)]"
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

      {#if groupMembers.length > 0}
        <div class="flex flex-col gap-1">
          <span class="text-xs text-text-muted font-medium inline-flex items-center gap-1">
            <Users size={12} /> Membres ({groupMembers.length})
          </span>
          <ul class="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
            {#each groupMembers as member (member)}
              <li
                class="flex items-center justify-between px-2.5 py-2 rounded-xl bg-[var(--cn-bg)]"
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
                    <span class="inline-flex items-center gap-1"
                      ><UserMinus size={12} /> Retirer</span
                    >
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if onGroupDelete}
        <div class="border-t border-cn-border pt-3">
          {#if !confirmDelete}
            <button
              onclick={() => {
                confirmDelete = true;
              }}
              class="w-full flex items-center justify-center gap-2 px-3 py-2 text-red-500 border border-red-200 rounded-lg text-sm hover:bg-red-50 transition-colors"
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
                  class="flex-1 px-3 py-1.5 border border-cn-border rounded-lg text-sm text-text-muted hover:bg-cn-bg"
                  >Annuler</button
                >
                <button
                  onclick={() => {
                    onGroupDelete?.();
                    showPanel = false;
                  }}
                  class="flex-1 px-3 py-1.5 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition-colors"
                  >Supprimer</button
                >
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </Modal>

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
