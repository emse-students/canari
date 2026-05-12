<script lang="ts">
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';

  interface User {
    id: string;
    displayName: string | null;
  }

  interface Props {
    /** Currently selected user ID (empty string when nothing is selected). */
    value: string;
    /** Called with the resolved user ID whenever the selection changes. */
    onValueChange: (value: string) => void;
    /** Optional callback fired when a suggestion is chosen from the dropdown. */
    onSelect?: (user: User) => void;
    /** Placeholder text shown in the text input. */
    placeholder?: string;
    /** HTML id attribute for the underlying input element. */
    inputId?: string;
    /** Called when the user presses Enter with a valid selection. */
    onSubmit?: () => void;
  }

  let {
    value: _value,
    onValueChange,
    onSelect,
    placeholder = 'Rechercher un utilisateur…',
    inputId = 'user-autocomplete',
    onSubmit,
  }: Props = $props();

  let suggestions = $state<User[]>([]);
  let isLoading = $state(false);
  let showDropdown = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedIndex = $state(-1);
  let inputText = $state('');
  let selectedUser = $state<User | null>(null);

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
        suggestions = await res.json();
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
    const newValue = (e.target as HTMLInputElement).value;
    // When user types, clear any previous selection — only explicit selection produces a valid id
    selectedUser = null;
    onValueChange('');
    inputText = newValue;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void searchUsers(newValue);
    }, 300);
  }

  function selectUser(user: User) {
    selectedUser = user;
    inputText = user.displayName || user.id;
    onValueChange(user.id);
    showDropdown = false;
    suggestions = [];
    selectedIndex = -1;
    onSelect?.(user);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!showDropdown || suggestions.length === 0) {
      if (e.key === 'Enter') {
        // Only allow submit when a user was explicitly selected
        if (selectedUser) onSubmit?.();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, -1);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && suggestions[selectedIndex]) {
          selectUser(suggestions[selectedIndex]);
        } else {
          // Do not submit when no selection is made
          // (parent will receive an empty id while typing)
        }
        break;
      case 'Escape':
        showDropdown = false;
        selectedIndex = -1;
        break;
    }
  }

  function handleBlur() {
    // Delay to allow click on suggestion
    setTimeout(() => {
      showDropdown = false;
      selectedIndex = -1;
      // If the input no longer matches the selected user's display name, clear selection
      if (!selectedUser || inputText !== (selectedUser.displayName || selectedUser.id)) {
        selectedUser = null;
        onValueChange('');
      }
    }, 150);
  }

  function handleFocus() {
    if (suggestions.length > 0) {
      showDropdown = true;
    }
  }
</script>

<div class="relative">
  <input
    id={inputId}
    type="text"
    value={inputText}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onblur={handleBlur}
    onfocus={handleFocus}
    {placeholder}
    autocomplete="off"
    class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
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
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
    </div>
  {/if}

  {#if showDropdown && suggestions.length > 0}
    <ul
      class="absolute z-50 w-full mt-1 bg-white/95 dark:bg-gray-900/95 border border-white/60 dark:border-white/10 rounded-xl shadow-lg max-h-48 overflow-auto backdrop-blur-sm"
    >
      {#each suggestions as user, index (user.id)}
        <li>
          <button
            type="button"
            class="w-full px-4 py-2 text-left text-sm hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors first:rounded-t-xl last:rounded-b-xl {index ===
            selectedIndex
              ? 'bg-amber-100/50 dark:bg-amber-900/30'
              : ''}"
            onmousedown={() => selectUser(user)}
          >
            <span class="font-medium text-text-main">{user.displayName || user.id}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
