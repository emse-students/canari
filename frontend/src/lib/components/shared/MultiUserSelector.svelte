<script lang="ts">
  import { X, Plus } from '@lucide/svelte';
  import UserName from './UserName.svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';

  interface User {
    id: string;
    displayName: string | null;
  }

  interface Props {
    /** Array of currently selected user IDs. */
    users: string[];
    /** Called with the updated list whenever a user is added or removed. */
    onUsersChange: (users: string[]) => void;
    /** Placeholder text shown in the search input. */
    placeholder?: string;
  }

  let { users, onUsersChange, placeholder = 'Ajouter un utilisateur...' }: Props = $props();

  let inputValue = $state('');
  let suggestions = $state<User[]>([]);
  let isLoading = $state(false);
  let showDropdown = $state(false);
  let selectedIndex = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function searchUsers(query: string) {
    if (!query || query.length < 2) {
      suggestions = [];
      showDropdown = false;
      return;
    }
    isLoading = true;
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const all: User[] = await res.json();
        suggestions = all.filter((u) => !users.includes(u.id));
        showDropdown = suggestions.length > 0;
        selectedIndex = -1;
      }
    } catch (e) {
      console.error('Failed to search users:', e);
      suggestions = [];
    } finally {
      isLoading = false;
    }
  }

  function handleInput(e: Event) {
    inputValue = (e.target as HTMLInputElement).value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void searchUsers(inputValue), 300);
  }

  function addUser(id?: string) {
    const val = (id ?? inputValue).trim().toLowerCase();
    if (val && !users.includes(val)) {
      onUsersChange([...users, val]);
    }
    inputValue = '';
    suggestions = [];
    showDropdown = false;
    selectedIndex = -1;
  }

  function selectSuggestion(user: User) {
    addUser(user.id);
  }

  function removeUser(userToRemove: string) {
    onUsersChange(users.filter((u) => u !== userToRemove));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (showDropdown && suggestions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, -1);
          return;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0 && suggestions[selectedIndex]) {
            selectSuggestion(suggestions[selectedIndex]);
          } else {
            addUser();
          }
          return;
        case 'Escape':
          showDropdown = false;
          selectedIndex = -1;
          return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      addUser();
    }
  }

  function handleBlur() {
    setTimeout(() => {
      showDropdown = false;
      selectedIndex = -1;
    }, 150);
  }

  function handleFocus() {
    if (suggestions.length > 0) showDropdown = true;
  }
</script>

<div class="space-y-3">
  <div class="flex gap-2">
    <div class="relative flex-1">
      <input
        type="text"
        value={inputValue}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onblur={handleBlur}
        onfocus={handleFocus}
        {placeholder}
        autocomplete="off"
        class="w-full px-4 py-2 bg-cn-bg border border-transparent focus:border-cn-border rounded-xl text-sm outline-none transition-colors"
      />
      {#if isLoading}
        <div class="absolute right-3 top-1/2 -translate-y-1/2">
          <svg
            class="animate-spin h-4 w-4 text-amber-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            ></path>
          </svg>
        </div>
      {/if}
      {#if showDropdown && suggestions.length > 0}
        <ul
          class="absolute z-50 left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-cn-border rounded-xl shadow-lg overflow-hidden"
        >
          {#each suggestions as user, i (user.id)}
            <li>
              <button
                type="button"
                class="w-full text-left px-4 py-2.5 text-sm hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors {i ===
                selectedIndex
                  ? 'bg-amber-50 dark:bg-amber-900/20'
                  : ''}"
                onmousedown={() => selectSuggestion(user)}
              >
                <span class="font-medium">{user.displayName ?? user.id}</span>
                {#if user.displayName && user.displayName !== user.id}
                  <span class="ml-1 text-text-muted">@{user.id}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <button
      onclick={() => addUser()}
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
          <UserName userId={user} class="text-sm font-medium" />
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
