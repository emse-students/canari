<script lang="ts">
  import { X, Plus } from 'lucide-svelte';

  interface Props {
    users: string[];
    onUsersChange: (users: string[]) => void;
    placeholder?: string;
  }

  let { users, onUsersChange, placeholder = 'Ajouter un utilisateur...' }: Props = $props();

  let inputValue = $state('');

  function addUser() {
    const val = inputValue.trim().toLowerCase();
    if (val && !users.includes(val)) {
      onUsersChange([...users, val]);
      inputValue = '';
    }
  }

  function removeUser(userToRemove: string) {
    onUsersChange(users.filter((u) => u !== userToRemove));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addUser();
    }
  }
</script>

<div class="space-y-3">
  <div class="flex gap-2">
    <input
      type="text"
      bind:value={inputValue}
      onkeydown={handleKeydown}
      {placeholder}
      class="flex-1 px-4 py-2 bg-cn-bg border border-transparent focus:border-cn-border rounded-xl text-sm outline-none transition-colors"
    />
    <button
      onclick={addUser}
      disabled={!inputValue.trim()}
      class="p-2 sm:px-4 bg-cn-dark text-cn-yellow rounded-xl hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      aria-label="Ajouter"
    >
      <Plus size={20} />
    </button>
  </div>

  {#if users.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each users as user (user)}
        <div
          class="flex items-center gap-1 pl-3 pr-1 py-1 bg-cn-bg text-cn-dark rounded-full text-sm"
        >
          <span>{user}</span>
          <button
            onclick={() => removeUser(user)}
            class="p-1 hover:bg-gray-200 rounded-full transition-colors"
            aria-label={`Retirer ${user}`}
          >
            <X size={14} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
