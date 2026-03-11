<script lang="ts">
  import {
    ChevronLeft,
    LockKeyhole,
    Clock,
    Settings,
    Trash2,
    UserMinus,
    Check,
    UserPlus,
    Users,
  } from 'lucide-svelte';
  import Modal from './Modal.svelte';
  import MultiUserSelector from './MultiUserSelector.svelte';

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    // inviteMemberInput is kept for compat interface but we use internal logic now
    inviteMemberInput?: string;
    onInviteInputChange?: (value: string) => void;
    // Updated to accept multiple
    onInviteMembers: (ids: string[]) => void;

    onBack?: () => void;
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
    groupMembers = [],
    onGroupRename,
    onGroupDelete,
    onGroupRemoveMember,
  }: Props = $props();

  const avatarLetter = $derived(contactName[0]?.toUpperCase() || '?');

  let showPanel = $state(false);
  let showInviteModal = $state(false);

  // Rename state
  let renameInput = $state('');

  // Invite state
  let newMembers = $state<string[]>([]);

  let confirmDelete = $state(false);

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

  function handleInvite() {
    if (newMembers.length > 0) {
      onInviteMembers(newMembers);
      newMembers = [];
      showInviteModal = false;
    }
  }
</script>

<header
  class="bg-white/80 backdrop-blur-md px-6 py-3 border-b border-cn-border flex items-center gap-4 relative z-20"
>
  <!-- Back button (mobile) -->
  {#if onBack}
    <button onclick={onBack} aria-label="Retour au menu" class="md:hidden p-1 text-cn-dark">
      <ChevronLeft size={24} />
    </button>
  {/if}

  <!-- Avatar -->
  <div
    class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center font-extrabold flex-shrink-0 shadow-sm"
  >
    {avatarLetter}
  </div>

  <!-- Meta -->
  <div class="flex-1 min-w-0">
    <h2 class="text-lg font-semibold text-cn-dark mb-0.5 truncate">{displayName}</h2>
    <span
      class="inline-flex items-center gap-1.5 text-xs font-semibold {isReady
        ? 'text-green-600'
        : 'text-amber-600'}"
    >
      {#if isReady}
        <LockKeyhole size={12} /> Chiffré
      {:else}
        <Clock size={12} /> Initialisation...
      {/if}
    </span>
  </div>

  <!-- Actions -->
  <div class="flex items-center gap-2">
    <!-- Invite Member Button -->
    <button
      onclick={() => (showInviteModal = true)}
      class="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-cn-bg hover:bg-gray-200 text-sm font-medium transition-colors"
    >
      <UserPlus size={18} />
      <span class="hidden md:inline">Ajouter</span>
    </button>

    <!-- Settings / Info -->
    <button
      onclick={openPanel}
      class="p-2 rounded-xl hover:bg-gray-100 text-gray-600 transition-colors"
    >
      <Settings size={20} />
    </button>
  </div>
</header>

<!-- Invite Modal -->
<Modal
  open={showInviteModal}
  onClose={() => (showInviteModal = false)}
  title={`Ajouter des membres à ${displayName}`}
>
  <div class="space-y-4">
    <p class="text-sm text-gray-500">
      Les nouveaux membres auront accès aux messages échangés à partir de maintenant.
    </p>

    <MultiUserSelector
      users={newMembers}
      onUsersChange={(u) => (newMembers = u)}
      placeholder="Identifiant utilisateur..."
    />

    <button
      onclick={handleInvite}
      disabled={newMembers.length === 0}
      class="w-full py-2.5 bg-cn-dark text-cn-yellow font-semibold rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Inviter {newMembers.length > 0 ? `(${newMembers.length})` : ''}
    </button>
  </div>
</Modal>

<!-- Settings Modal (reusing the panel logic but in a Modal for consistency?)
     The original code used a custom overlay. Let's stick closer to original "panel" behavior
     but maybe distinct from the Invite modal.
     Actually, let's just keep the original "Panel" as a Modal as well, it's cleaner.
-->
<Modal open={showPanel} onClose={() => (showPanel = false)} title="Paramètres du groupe">
  <div class="space-y-6">
    <!-- Groupe Name -->
    <div class="space-y-2">
      <label class="text-sm font-medium text-gray-700">Nom du groupe</label>
      <div class="flex gap-2">
        <input
          type="text"
          bind:value={renameInput}
          onkeydown={handleRenameKey}
          class="flex-1 px-4 py-2 bg-cn-bg rounded-xl text-sm"
        />
        <button
          onclick={submitRename}
          disabled={renameInput === displayName}
          class="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm disabled:opacity-50"
        >
          <Check size={18} />
        </button>
      </div>
    </div>

    <!-- Members List -->
    {#if groupMembers.length > 0}
      <div class="space-y-2">
        <h3 class="text-sm font-medium text-gray-700 flex items-center gap-2">
          <Users size={16} /> Membres ({groupMembers.length})
        </h3>
        <div class="max-h-48 overflow-y-auto bg-cn-bg rounded-xl p-2 space-y-1">
          {#each groupMembers as member (member)}
            <div class="flex items-center justify-between p-2 bg-white rounded-lg shadow-sm">
              <span class="text-sm font-medium">{member}</span>
              {#if onGroupRemoveMember && member.toLowerCase() !== contactName.toLowerCase()}
                <!-- contactName is basically current user in some contexts? No wait. -->
                <button
                  onclick={() => onGroupRemoveMember(member)}
                  class="text-red-500 hover:text-red-700 p-1"
                  title="Retirer du groupe"
                >
                  <UserMinus size={16} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Danger Zone -->
    <div class="pt-4 border-t border-gray-100">
      {#if !confirmDelete}
        <button
          onclick={() => (confirmDelete = true)}
          class="w-full flex items-center justify-center gap-2 p-3 text-red-600 hover:bg-red-50 rounded-xl transition-colors font-medium border border-red-100"
        >
          <Trash2 size={18} /> Supprimer le groupe
        </button>
      {:else}
        <div class="space-y-2 text-center animation-fade-in">
          <p class="text-sm text-red-600 font-medium">
            Êtes-vous sûr ? Cette action est irréversible.
          </p>
          <div class="flex gap-2">
            <button
              onclick={() => (confirmDelete = false)}
              class="flex-1 py-2 bg-gray-100 text-gray-700 rounded-xl font-medium"
            >
              Annuler
            </button>
            <button
              onclick={onGroupDelete}
              class="flex-1 py-2 bg-red-600 text-white rounded-xl font-medium hover:bg-red-700"
            >
              Confirmer
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
