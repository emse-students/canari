<script lang="ts">
  import { onMount } from 'svelte';
  import { listAssociations, type Association } from '$lib/associations/api';
  import { X, Users } from '@lucide/svelte';

  interface Props {
    /** Selected co-owner association IDs (bindable). */
    selectedIds: string[];
    /** Association excluded from candidates (the event's primary owner). */
    excludeId?: string;
    /** Section heading shown above the picker. */
    label?: string;
  }

  let {
    selectedIds = $bindable([]),
    excludeId = '',
    label = 'Associations partenaires (optionnel)',
  }: Props = $props();

  let allAssociations = $state<Association[]>([]);
  let searchQuery = $state('');
  let dropdownOpen = $state(false);

  onMount(async () => {
    try {
      allAssociations = await listAssociations();
    } catch {
      allAssociations = [];
    }
  });

  const candidates = $derived(
    allAssociations.filter(
      (a) =>
        a.id !== excludeId &&
        !selectedIds.includes(a.id) &&
        (searchQuery.trim() === '' || a.name.toLowerCase().includes(searchQuery.toLowerCase()))
    )
  );

  const selected = $derived(allAssociations.filter((a) => selectedIds.includes(a.id)));

  function add(id: string) {
    if (!selectedIds.includes(id)) selectedIds = [...selectedIds, id];
    searchQuery = '';
    dropdownOpen = false;
  }

  function remove(id: string) {
    selectedIds = selectedIds.filter((x) => x !== id);
  }
</script>

<div class="border-cn-border/70 bg-cn-bg/30 space-y-2 rounded-xl border p-3">
  <p class="text-text-muted flex items-center gap-1 text-xs font-bold tracking-wide uppercase">
    <Users size={14} />
    {label}
  </p>
  {#if selected.length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each selected as asso (asso.id)}
        <span
          class="border-cn-border text-text-main inline-flex items-center gap-1 rounded-full border bg-(--cn-surface) px-2.5 py-1 text-xs font-semibold"
        >
          {#if asso.color}
            <span class="inline-block h-2 w-2 shrink-0 rounded-full" style="background:{asso.color}"
            ></span>
          {/if}
          {asso.name}
          <button
            type="button"
            onclick={() => remove(asso.id)}
            class="text-text-muted ml-0.5 transition-colors hover:text-red-500"
            aria-label="Retirer {asso.name}"
          >
            <X size={12} />
          </button>
        </span>
      {/each}
    </div>
  {/if}
  <div class="relative">
    <input
      type="text"
      placeholder="Rechercher une association…"
      bind:value={searchQuery}
      onfocus={() => (dropdownOpen = true)}
      onblur={() => setTimeout(() => (dropdownOpen = false), 150)}
      class="border-cn-border text-text-main placeholder:text-text-muted w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
    />
    {#if dropdownOpen && candidates.length > 0}
      <ul
        class="border-cn-border absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border bg-white/95 shadow-lg backdrop-blur-xl dark:bg-black/90"
      >
        {#each candidates.slice(0, 12) as asso (asso.id)}
          <li>
            <button
              type="button"
              onmousedown={(e) => {
                e.preventDefault();
                add(asso.id);
              }}
              class="text-text-main hover:bg-cn-yellow/10 flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
            >
              {#if asso.color}
                <span
                  class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style="background:{asso.color}"
                ></span>
              {/if}
              {asso.name}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
