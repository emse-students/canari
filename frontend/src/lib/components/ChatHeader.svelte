<script lang="ts">
  import {
    ChevronLeft,
    PanelLeft,
    LockKeyhole,
    Clock,
    Settings,
    X,
    Trash2,
    UserMinus,
    Check,
  } from 'lucide-svelte';
  import Avatar from './Avatar.svelte';

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    inviteMemberInput: string;
    onInviteInputChange: (value: string) => void;
    onInviteMember: () => void;
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
    inviteMemberInput,
    onInviteInputChange,
    onInviteMember,
    onBack,
    onOpenConversations,
    groupMembers = [],
    onGroupRename,
    onGroupDelete,
    onGroupRemoveMember,
  }: Props = $props();

  let showPanel = $state(false);
  let renameInput = $state('');
  let confirmDelete = $state(false);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && inviteMemberInput.trim()) {
      onInviteMember();
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

<header class="bg-[var(--surface-elevated)] px-3 md:px-6 py-3 border-b border-cn-border flex items-center gap-3 md:gap-4 relative backdrop-blur-sm">
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

  <!-- Invite -->
  <div class="hidden lg:flex gap-2">
    <input
      type="text"
      value={inviteMemberInput}
      oninput={(e) => onInviteInputChange(e.currentTarget.value)}
      onkeydown={handleKeydown}
      placeholder="Ajouter au groupe..."
      class="px-3 py-2 border border-cn-border rounded-xl text-sm w-40 outline-none bg-[var(--cn-surface)]"
    />
    <button
      onclick={onInviteMember}
      class="px-3 py-2 bg-cn-dark text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition-colors"
    >
      Inviter
    </button>
  </div>

  <!-- Group settings button -->
  <button
    onclick={openPanel}
    aria-label="Paramètres du groupe"
    class="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-cn-dark transition-colors"
  >
    <Settings size={18} />
  </button>

  <!-- Group management panel (dropdown) -->
  {#if showPanel}
    <!-- Backdrop -->
    <button
      class="fixed inset-0 z-30 cursor-default bg-transparent border-0"
      onclick={() => {
        showPanel = false;
      }}
      aria-label="Fermer le panneau"
    ></button>

    <div class="fixed inset-0 z-40 p-3 md:absolute md:inset-auto md:p-0 md:top-full md:right-0 md:mt-1 md:w-[24rem]">
      <div
        class="h-full md:h-auto bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-lg p-4 md:p-5 flex flex-col gap-4 overflow-y-auto"
      >
      <!-- Close -->
      <div class="flex items-center justify-between">
        <span class="text-sm font-semibold text-cn-dark">Paramètres du groupe</span>
        <button
          onclick={() => {
            showPanel = false;
          }}
          class="text-gray-400 hover:text-cn-dark p-1 rounded-lg hover:bg-cn-bg"
        >
          <X size={16} />
        </button>
      </div>

      <!-- Rename -->
      <div class="flex flex-col gap-1">
        <label for="group-rename-input" class="text-xs text-gray-500 font-medium"
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

      <!-- Members list -->
      <div class="lg:hidden flex flex-col gap-2 border-t border-cn-border pt-3">
        <span class="text-xs text-gray-500 font-medium">Inviter un membre</span>
        <div class="flex gap-2">
          <input
            type="text"
            value={inviteMemberInput}
            oninput={(e) => onInviteInputChange(e.currentTarget.value)}
            onkeydown={handleKeydown}
            placeholder="Pseudo..."
            class="flex-1 px-3 py-2 border border-cn-border rounded-xl text-sm outline-none bg-[var(--cn-bg)]"
          />
          <button
            onclick={onInviteMember}
            class="px-3 py-2 bg-cn-dark text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition-colors"
          >
            Inviter
          </button>
        </div>
      </div>

      {#if groupMembers.length > 0}
        <div class="flex flex-col gap-1">
          <span class="text-xs text-gray-500 font-medium">Membres ({groupMembers.length})</span>
          <ul class="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
            {#each groupMembers as member (member)}
              <li class="flex items-center justify-between px-2.5 py-2 rounded-xl bg-[var(--cn-bg)]">
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
                    <span class="inline-flex items-center gap-1"><UserMinus size={12} /> Retirer</span>
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Delete group -->
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
                  class="flex-1 px-3 py-1.5 border border-cn-border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
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
    </div>
  {/if}
</header>
