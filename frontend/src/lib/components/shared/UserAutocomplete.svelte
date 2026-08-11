<script lang="ts">
  import { onDestroy } from 'svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { Search } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { filterUserSuggestions } from '$lib/utils/users/suggestionFilter';

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
    /** When true, the input resets after each selection (multi-add usage, e.g. MultiUserSelector). */
    clearOnSelect?: boolean;
    /**
     * User IDs to hide from the suggestion list.
     *
     * This is how an invitation surface says "these people are already here". It is deliberately
     * NOT a property of the picker itself: the same component is used to FIND a user - including
     * yourself - in contexts where excluding anyone would be wrong, so who may not be offered is
     * the caller's question, and only the caller can answer it.
     */
    excludeIds?: string[];
    /** When set, only users whose IDs are in this list appear in suggestions. */
    filterUserIds?: string[];
  }

  let {
    value: _value,
    onValueChange,
    onSelect,
    placeholder = m.user_search_placeholder(),
    inputId = 'user-autocomplete',
    onSubmit,
    clearOnSelect = false,
    excludeIds = [],
    filterUserIds,
  }: Props = $props();

  let results = $state<User[]>([]);
  let isLoading = $state(false);
  let showDropdown = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedIndex = $state(-1);
  let inputText = $state('');
  let selectedUser = $state<User | null>(null);
  let anchorEl = $state<HTMLElement | null>(null);
  let dropdownEl = $state<HTMLElement | null>(null);

  /**
   * What the user may actually pick: the server's answer, minus who this surface excludes.
   *
   * A PROJECTION, not a step inside `searchUsers`, so that a roster changing while the dropdown is
   * open takes effect immediately rather than on the next keystroke. The rule itself lives in
   * `filterUserSuggestions` because it is worth a test of its own.
   */
  const suggestions = $derived(filterUserSuggestions(results, { excludeIds, filterUserIds }));

  const listboxId = $derived(`${inputId}-listbox`);
  const optionId = (index: number) => `${inputId}-option-${index}`;

  /**
   * Position the portalled dropdown against the input.
   *
   * The list is rendered into `<body>` as `position: fixed` rather than absolutely inside the
   * field: this component is embedded in modal bodies and cards that clip their overflow, and
   * no z-index takes an element out of an ancestor that clips. Being portalled, it no longer
   * inherits the field's width either - hence `matchAnchorWidth`.
   */
  $effect(() => {
    if (!dropdownEl || !anchorEl) return;
    return bindFixedPopover(dropdownEl, {
      anchor: () => anchorEl,
      matchAnchorWidth: true,
      offset: 4,
      estimatedHeight: 192,
    });
  });

  // Cancel pending debounce/blur timers on unmount to avoid API calls on a destroyed component.
  onDestroy(() => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  async function searchUsers(query: string) {
    if (!query || query.length < 2) {
      results = [];
      showDropdown = false;
      return;
    }

    isLoading = true;
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        results = await res.json();
        showDropdown = suggestions.length > 0;
        selectedIndex = -1;
      }
    } catch (e) {
      console.error('Failed to search users:', e);
      results = [];
    } finally {
      isLoading = false;
    }
  }

  function handleInput(e: Event) {
    const newValue = (e.target as HTMLInputElement).value;
    // When user types, clear any previous selection - only explicit selection produces a valid id
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
    results = [];
    selectedIndex = -1;
    onSelect?.(user);
    if (clearOnSelect) {
      // Multi-add usage: the parent stored the pick via onSelect; reset for the next search.
      selectedUser = null;
      inputText = '';
      onValueChange('');
    }
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

<div class="relative" bind:this={anchorEl}>
  <span class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted">
    <Search size={15} />
  </span>
  <!--
    The ARIA 1.2 combobox pattern, and it is not decoration: without `aria-expanded` a screen
    reader never announces that suggestions appeared, and without `aria-activedescendant` the
    arrow keys move a highlight nobody is told about. It also gives automated checks a stable
    handle - `role="option"` - instead of matching on a Tailwind class or a portal's position.
  -->
  <input
    id={inputId}
    type="text"
    role="combobox"
    aria-expanded={showDropdown && suggestions.length > 0}
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-busy={isLoading}
    aria-activedescendant={selectedIndex >= 0 ? optionId(selectedIndex) : undefined}
    value={inputText}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onblur={handleBlur}
    onfocus={handleFocus}
    {placeholder}
    autocomplete="off"
    class="w-full pl-9 pr-4 py-2.5 bg-(--cn-surface) border border-cn-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45 focus:border-amber-400/60"
  />

  {#if isLoading}
    <div class="absolute right-3 top-1/2 -translate-y-1/2">
      <svg
        class="animate-spin h-4 w-4 text-amber-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
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
    <!-- Portalled so no embedding container can clip it; positioned by the effect above. -->
    <ul
      bind:this={dropdownEl}
      use:portal
      id={listboxId}
      role="listbox"
      aria-label={placeholder}
      class="fixed z-290 bg-white/95 dark:bg-gray-900/95 border border-white/60 dark:border-white/10 rounded-xl shadow-lg overflow-auto backdrop-blur-sm"
    >
      {#each suggestions as user, index (user.id)}
        <!--
          The option IS the `li`. Wrapping a `button` in it would put a generic element between the
          listbox and its options and break the relation the pattern depends on; the options are
          never focused anyway - the input keeps focus and points at one via `aria-activedescendant`.
          `onmousedown` rather than `onclick` because `handleBlur` fires first on a click.
        -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(index)}
          role="option"
          aria-selected={index === selectedIndex}
          class="px-4 py-2 text-left text-sm cursor-pointer hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors first:rounded-t-xl last:rounded-b-xl {index ===
          selectedIndex
            ? 'bg-amber-100/50 dark:bg-amber-900/30'
            : ''}"
          onmousedown={() => selectUser(user)}
        >
          <span class="font-medium text-text-main">{user.displayName || user.id}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
