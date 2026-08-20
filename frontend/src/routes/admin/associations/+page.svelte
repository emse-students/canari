<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listAssociations, updateAssociation, type Association } from '$lib/associations/api';
  import { Building2, Search, ShieldCheck, LoaderCircle } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let associations = $state<Association[]>([]);
  let query = $state('');
  /** IDs whose BDE flag is currently being persisted (per-row spinner + disabled). */
  const savingIds = new SvelteSet<string>();

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...associations].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return sorted;
    return sorted.filter(
      (a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q)
    );
  });

  const bdeCount = $derived(associations.filter((a) => a.isBDE).length);

  async function load() {
    loading = true;
    error = null;
    try {
      associations = await listAssociations();
    } catch (e) {
      error = e instanceof Error ? e.message : m.admin_assoc_load_error();
    } finally {
      loading = false;
    }
  }

  /** Optimistically toggles the BDE flag and persists it, reverting on failure. */
  async function toggleBde(assoc: Association, next: boolean) {
    const previous = assoc.isBDE;
    associations = associations.map((a) => (a.id === assoc.id ? { ...a, isBDE: next } : a));
    savingIds.add(assoc.id);
    error = null;
    try {
      await updateAssociation(assoc.id, { isBDE: next });
    } catch (e) {
      // Revert on failure so the UI never lies about the persisted state.
      associations = associations.map((a) => (a.id === assoc.id ? { ...a, isBDE: previous } : a));
      error = e instanceof Error ? e.message : m.admin_assoc_update_error({ name: assoc.name });
    } finally {
      savingIds.delete(assoc.id);
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    void load();
  });
</script>

<div class="space-y-6">
  <header class="flex items-start gap-3">
    <span
      class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
    >
      <Building2 size={20} />
    </span>
    <div>
      <h2 class="text-text-main text-lg font-extrabold">{m.admin_assoc_title()}</h2>
      <p class="text-text-muted mt-0.5 text-sm">
        {m.admin_assoc_subtitle()}
      </p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="relative max-w-sm min-w-50 flex-1">
        <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
        <input
          type="text"
          bind:value={query}
          placeholder={m.admin_assoc_search_placeholder()}
          aria-label={m.admin_assoc_search_aria_label()}
          class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent py-2 pr-3 pl-9 text-sm focus:ring-2 focus:outline-none"
        />
      </div>
      <span class="text-text-muted inline-flex items-center gap-1.5 text-xs font-semibold">
        <ShieldCheck size={14} class="text-emerald-500" />
        {m.admin_assoc_bde_count_label({ bdeCount, total: associations.length })}
      </span>
    </div>

    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    <div
      class="border-cn-border divide-cn-border/70 divide-y overflow-hidden rounded-2xl border bg-(--cn-surface)"
    >
      {#if filtered.length === 0}
        <p class="text-text-muted px-4 py-8 text-center text-sm">{m.admin_assoc_empty()}</p>
      {:else}
        {#each filtered as assoc (assoc.id)}
          <div class="flex items-center justify-between gap-3 px-4 py-3">
            <div class="min-w-0">
              <span class="text-text-main block truncate text-sm font-semibold">{assoc.name}</span>
              <span class="text-text-muted block truncate text-xs">/{assoc.slug}</span>
            </div>
            <label class="flex shrink-0 cursor-pointer items-center gap-2">
              {#if savingIds.has(assoc.id)}
                <LoaderCircle size={14} class="text-cn-yellow animate-spin" />
              {/if}
              <span class="text-xs font-bold {assoc.isBDE ? 'text-green-ok' : 'text-text-muted'}">
                BDE
              </span>
              <input
                type="checkbox"
                checked={assoc.isBDE}
                disabled={savingIds.has(assoc.id)}
                onchange={(e) => toggleBde(assoc, (e.currentTarget as HTMLInputElement).checked)}
                class="border-cn-border text-cn-yellow focus:ring-cn-yellow h-4 w-4 rounded disabled:opacity-50"
                aria-label={m.admin_assoc_mark_bde_aria_label({ name: assoc.name })}
              />
            </label>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
