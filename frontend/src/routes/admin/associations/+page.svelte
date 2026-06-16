<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listAssociations, updateAssociation, type Association } from '$lib/associations/api';
  import { Building2, Search, Loader2, ShieldCheck } from '@lucide/svelte';
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
      associations = associations.map((a) =>
        a.id === assoc.id ? { ...a, isBDE: previous } : a
      );
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
    <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark">
      <Building2 size={20} />
    </span>
    <div>
      <h2 class="text-lg font-extrabold text-text-main">{m.admin_assoc_title()}</h2>
      <p class="text-sm text-text-muted mt-0.5">
        {m.admin_assoc_subtitle()}
      </p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
    </div>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="relative flex-1 min-w-[200px] max-w-sm">
        <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          bind:value={query}
          placeholder={m.admin_assoc_search_placeholder()}
          aria-label={m.admin_assoc_search_aria_label()}
          class="w-full rounded-xl border border-cn-border bg-transparent py-2 pl-9 pr-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        />
      </div>
      <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-text-muted">
        <ShieldCheck size={14} class="text-emerald-500" />
        {m.admin_assoc_bde_count_label({ bdeCount, total: associations.length })}
      </span>
    </div>

    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] divide-y divide-cn-border/70 overflow-hidden">
      {#if filtered.length === 0}
        <p class="px-4 py-8 text-center text-sm text-text-muted">{m.admin_assoc_empty()}</p>
      {:else}
        {#each filtered as assoc (assoc.id)}
          <div class="flex items-center justify-between gap-3 px-4 py-3">
            <div class="min-w-0">
              <span class="block truncate text-sm font-semibold text-text-main">{assoc.name}</span>
              <span class="block truncate text-xs text-text-muted">/{assoc.slug}</span>
            </div>
            <label class="flex shrink-0 cursor-pointer items-center gap-2">
              {#if savingIds.has(assoc.id)}
                <Loader2 size={14} class="animate-spin text-cn-yellow" />
              {/if}
              <span class="text-xs font-bold {assoc.isBDE ? 'text-emerald-600' : 'text-text-muted'}">
                BDE
              </span>
              <input
                type="checkbox"
                checked={assoc.isBDE}
                disabled={savingIds.has(assoc.id)}
                onchange={(e) => toggleBde(assoc, (e.currentTarget as HTMLInputElement).checked)}
                class="h-4 w-4 rounded border-cn-border text-cn-yellow focus:ring-cn-yellow disabled:opacity-50"
                aria-label={m.admin_assoc_mark_bde_aria_label({ name: assoc.name })}
              />
            </label>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
