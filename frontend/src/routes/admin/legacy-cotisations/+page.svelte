<script lang="ts">
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    listLegacyCotisations,
    type LegacyCotisationAdminItem,
    type LegacyCotisationStatus,
  } from '$lib/associations/api';
  import { RefreshCw, Search, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  const PAGE_SIZE = 50;
  const SEARCH_DEBOUNCE_MS = 300;

  let ready = $state(false);
  let tab = $state<LegacyCotisationStatus>('pending');
  let search = $state('');
  let items = $state<LegacyCotisationAdminItem[]>([]);
  let total = $state(0);
  let hasMore = $state(false);
  let counts = $state({ pending: 0, claimed: 0, collisions: 0 });
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let sentinel = $state<HTMLElement | null>(null);

  /**
   * Loads one page. `replace` distinguishes a new query from a scroll: appending on a query change
   * would leave the previous tab's rows above the new ones, which reads as a single result set.
   */
  async function load(offset: number, replace: boolean) {
    if (replace) loading = true;
    else loadingMore = true;
    try {
      const page = await listLegacyCotisations({
        status: tab,
        search,
        offset,
        limit: PAGE_SIZE,
      });
      items = replace ? page.items : [...items, ...page.items];
      total = page.total;
      hasMore = page.hasMore;
      counts = page.counts;
      error = null;
    } catch (e) {
      console.error('[ADMIN][LEGACY] listing failed', e);
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  async function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    await load(items.length, false);
  }

  /** A tab click reloads straight away - routing it through the debounced effect read as a dead button. */
  function switchTab(next: LegacyCotisationStatus) {
    if (tab === next) return;
    tab = next;
    void load(0, true);
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      console.error('[ADMIN][LEGACY] non-global-admin blocked client-side, redirecting');
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
  });

  // Typing reloads from the top, debounced. This also carries the FIRST load: `ready` is a
  // dependency, so the effect re-runs the moment the guard admits the user, and that run fires
  // immediately because nothing has been typed yet.
  $effect(() => {
    const currentSearch = search;
    if (!ready) return;
    const timer = setTimeout(() => void load(0, true), currentSearch ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '200px' }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  }

  /** The claimant's own name, which is what tells a homonym apart from the source's spelling. */
  function claimantName(row: LegacyCotisationAdminItem): string {
    const name = [row.claimantFirstName, row.claimantLastName].filter(Boolean).join(' ');
    return name || (row.claimedByUserId?.slice(0, 8) ?? '');
  }

  const tabs: { key: LegacyCotisationStatus; label: () => string }[] = [
    { key: 'pending', label: () => m.admin_legacy_tab_pending({ count: counts.pending }) },
    { key: 'claimed', label: () => m.admin_legacy_tab_claimed({ count: counts.claimed }) },
    { key: 'collisions', label: () => m.admin_legacy_tab_collisions({ count: counts.collisions }) },
    { key: 'all', label: () => m.admin_legacy_tab_all() },
  ];
</script>

<svelte:head><title>{m.admin_legacy_page_title()}</title></svelte:head>

{#if ready}
  <PageHeader title={m.admin_legacy_title()} subtitle={m.admin_legacy_subtitle()}>
    {#snippet actions()}
      <button
        onclick={() => void load(0, true)}
        class="border-cn-border text-text-muted hover:border-cn-yellow hover:text-text-main flex items-center gap-1.5 rounded-lg border bg-(--cn-surface) px-3 py-1.5 text-sm transition-colors"
      >
        <RefreshCw size={14} />
        {m.common_refresh_button()}
      </button>
    {/snippet}
  </PageHeader>

  {#if error}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {error}
    </div>
  {/if}

  <div class="border-cn-border flex gap-1 rounded-xl border bg-(--cn-surface) p-1">
    {#each tabs as t (t.key)}
      <button
        onclick={() => switchTab(t.key)}
        class="flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors {tab ===
        t.key
          ? 'bg-cn-yellow text-cn-ink shadow-sm'
          : 'text-text-muted hover:text-text-main'}"
      >
        {t.label()}
      </button>
    {/each}
  </div>

  <div class="relative">
    <span class="text-text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2">
      <Search size={15} />
    </span>
    <input
      type="text"
      bind:value={search}
      placeholder={m.admin_legacy_search_placeholder()}
      class="border-cn-border w-full rounded-xl border bg-(--cn-surface) py-2.5 pr-4 pl-9 text-sm outline-none focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/45"
    />
  </div>

  {#if tab === 'collisions' && counts.collisions > 0}
    <div
      class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn flex items-start gap-2 rounded-xl border px-4 py-3 text-sm"
    >
      <TriangleAlert size={16} class="mt-0.5 shrink-0" />
      <span>{m.admin_legacy_collision_hint()}</span>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-10">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if items.length === 0}
    <p class="text-text-muted py-8 text-center text-sm">{m.admin_legacy_empty()}</p>
  {:else}
    <div class="border-cn-border overflow-x-auto rounded-xl border">
      <table class="w-full text-sm">
        <thead>
          <tr
            class="border-cn-border text-text-muted border-b bg-(--surface-elevated) text-xs font-semibold tracking-wide uppercase"
          >
            <th class="px-4 py-2.5 text-left">{m.admin_legacy_col_source()}</th>
            <th class="px-4 py-2.5 text-left">{m.admin_legacy_col_association()}</th>
            <th class="px-4 py-2.5 text-left">{m.admin_legacy_col_batch()}</th>
            <th class="px-4 py-2.5 text-left">{m.admin_legacy_col_status()}</th>
          </tr>
        </thead>
        <tbody>
          {#each items as row (row.id)}
            <tr
              class="border-cn-border border-b transition-colors last:border-0 {row.keyRowCount > 1
                ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_6%,var(--cn-surface))]'
                : 'bg-(--cn-surface) hover:bg-(--surface-elevated)'}"
            >
              <td class="px-4 py-3">
                <span class="text-text-main block font-medium">{row.sourceLabel}</span>
                <!-- The normalized key, because a claim that never fires is almost always a
                     difference between what the source wrote and what the key became. -->
                <span class="text-text-muted block font-mono text-xs">{row.matchKey}</span>
              </td>
              <td class="text-text-muted px-4 py-3">
                {row.associationName ?? row.associationId.slice(0, 8)}
                {#if row.variantKey}
                  <span class="text-text-muted block text-xs">{row.variantKey}</span>
                {/if}
              </td>
              <td class="text-text-muted px-4 py-3 font-mono text-xs">{row.sourceBatch}</td>
              <td class="px-4 py-3">
                {#if row.claimedByUserId}
                  <span class="text-text-main block">{claimantName(row)}</span>
                  <span class="text-text-muted block text-xs">
                    {row.disposition === 'already-held'
                      ? m.admin_legacy_status_already_held()
                      : m.admin_legacy_status_granted()}
                    {row.claimedAt ? ` - ${formatDate(row.claimedAt)}` : ''}
                  </span>
                {:else}
                  <span class="text-text-muted">{m.admin_legacy_status_pending()}</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div bind:this={sentinel} class="h-4"></div>
    {#if loadingMore}
      <div class="flex justify-center py-3">
        <div
          class="border-cn-yellow h-5 w-5 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {/if}
    <p class="text-text-muted text-right text-xs">
      {m.admin_legacy_total_label({ count: total })}
    </p>
  {/if}
{/if}
