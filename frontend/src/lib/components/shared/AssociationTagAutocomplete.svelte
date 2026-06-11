<script lang="ts">
  import { onDestroy } from 'svelte';
  import { searchAssociationTagCatalog } from '$lib/associations/api';
  import { Search, Tag } from '@lucide/svelte';

  interface Props {
    /** Association whose tag catalog is searched. */
    associationId: string;
    /** Selected tag name (empty when unset). */
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    inputId?: string;
    disabled?: boolean;
    /**
     * When true, a name not in the catalog may be confirmed on blur (new membership tags).
     * When false, only catalog picks are kept (cotisation pricing on forms).
     */
    allowCreate?: boolean;
  }

  let {
    associationId,
    value,
    onValueChange,
    placeholder = 'Rechercher un tag…',
    inputId = 'tag-autocomplete',
    disabled = false,
    allowCreate = false,
  }: Props = $props();

  let suggestions = $state<string[]>([]);
  let isLoading = $state(false);
  let showDropdown = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedIndex = $state(-1);
  let inputText = $state('');
  let selectedTag = $state<string | null>(null);
  let lastAssociationId = $state('');

  onDestroy(() => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  $effect(() => {
    if (!lastAssociationId) {
      lastAssociationId = associationId;
      return;
    }
    if (associationId !== lastAssociationId) {
      lastAssociationId = associationId;
      selectedTag = null;
      inputText = '';
      suggestions = [];
      showDropdown = false;
      if (value) onValueChange('');
    }
  });

  $effect(() => {
    if (value && value !== selectedTag) {
      selectedTag = value;
      inputText = value;
    }
    if (!value && selectedTag) {
      selectedTag = null;
      if (!inputText) inputText = '';
    }
  });

  const trimmedQuery = $derived(inputText.trim());
  const canCreateCurrent = $derived(
    allowCreate &&
      trimmedQuery.length > 0 &&
      !suggestions.some((t) => t.toLowerCase() === trimmedQuery.toLowerCase())
  );

  async function searchTags(query: string) {
    if (!associationId) {
      suggestions = [];
      showDropdown = false;
      return;
    }

    isLoading = true;
    try {
      suggestions = await searchAssociationTagCatalog(associationId, query);
      const q = query.trim().toLowerCase();
      const canCreate =
        allowCreate &&
        q.length > 0 &&
        !suggestions.some((t) => t.toLowerCase() === q);
      showDropdown = suggestions.length > 0 || canCreate;
      selectedIndex = -1;
    } catch (e) {
      console.error('[TagAutocomplete] search failed:', e);
      suggestions = [];
      showDropdown = allowCreate && query.trim().length > 0;
    } finally {
      isLoading = false;
    }
  }

  function handleInput(e: Event) {
    selectedTag = null;
    onValueChange('');
    inputText = (e.target as HTMLInputElement).value;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void searchTags(inputText);
    }, 250);
  }

  function selectTag(tag: string) {
    selectedTag = tag;
    inputText = tag;
    onValueChange(tag);
    showDropdown = false;
    suggestions = [];
    selectedIndex = -1;
  }

  function confirmCreate() {
    if (!trimmedQuery) return;
    selectTag(trimmedQuery);
  }

  function handleKeydown(e: KeyboardEvent) {
    const extraCreate = canCreateCurrent ? 1 : 0;
    const total = suggestions.length + extraCreate;

    if (!showDropdown || total === 0) {
      if (e.key === 'Enter' && allowCreate && trimmedQuery) {
        confirmCreate();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, total - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, -1);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          selectTag(suggestions[selectedIndex]);
        } else if (selectedIndex === suggestions.length && canCreateCurrent) {
          confirmCreate();
        } else if (allowCreate && trimmedQuery) {
          confirmCreate();
        }
        break;
      case 'Escape':
        showDropdown = false;
        selectedIndex = -1;
        break;
    }
  }

  function handleBlur() {
    setTimeout(() => {
      showDropdown = false;
      selectedIndex = -1;
      if (selectedTag && inputText === selectedTag) return;
      if (allowCreate && trimmedQuery) {
        selectTag(trimmedQuery);
        return;
      }
      selectedTag = null;
      inputText = '';
      onValueChange('');
    }, 150);
  }

  function handleFocus() {
    if (!associationId || disabled) return;
    void searchTags(inputText);
    if (suggestions.length > 0 || canCreateCurrent) showDropdown = true;
  }
</script>

<div class="space-y-1">
  <div class="relative">
    <span class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted">
      <Search size={15} />
    </span>
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
      disabled={disabled || !associationId}
      class="w-full pl-9 pr-4 py-2.5 bg-[var(--cn-surface)] border border-cn-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45 focus:border-amber-400/60 disabled:opacity-50 disabled:cursor-not-allowed"
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

    {#if showDropdown && (suggestions.length > 0 || canCreateCurrent)}
      <ul
        class="absolute z-50 w-full mt-1 bg-white/95 dark:bg-gray-900/95 border border-white/60 dark:border-white/10 rounded-xl shadow-lg max-h-48 overflow-auto backdrop-blur-sm"
      >
        {#each suggestions as tag, index (tag)}
          <li>
            <button
              type="button"
              class="w-full px-4 py-2 text-left text-sm hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors first:rounded-t-xl {index ===
              selectedIndex
                ? 'bg-amber-100/50 dark:bg-amber-900/30'
                : ''}"
              onmousedown={() => selectTag(tag)}
            >
              <span class="inline-flex items-center gap-2 font-mono text-text-main">
                <Tag size={14} class="shrink-0 text-text-muted" />
                {tag}
              </span>
            </button>
          </li>
        {/each}
        {#if canCreateCurrent}
          <li>
            <button
              type="button"
              class="w-full px-4 py-2 text-left text-sm hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors last:rounded-b-xl {selectedIndex ===
              suggestions.length
                ? 'bg-amber-100/50 dark:bg-amber-900/30'
                : ''}"
              onmousedown={confirmCreate}
            >
              <span class="text-text-main">Créer « <span class="font-mono">{trimmedQuery}</span> »</span>
            </button>
          </li>
        {/if}
      </ul>
    {/if}
  </div>

  {#if !associationId}
    <p class="text-xs text-text-muted ml-1">Sélectionnez d'abord l'association bénéficiaire.</p>
  {:else if !allowCreate}
    <p class="text-xs text-text-muted ml-1">Choisissez un tag existant dans la liste.</p>
  {:else if suggestions.length === 0 && !isLoading && trimmedQuery}
    <p class="text-xs text-text-muted ml-1">
      Aucun tag existant — vous pouvez en créer un nouveau (ex. cotisant:bde-2026-2027).
    </p>
  {/if}
</div>
