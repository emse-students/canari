<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    holdsBdeFlag,
    AssociationPermissionFlag,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationTile from '$lib/components/associations/AssociationTile.svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let lists = $state<Association[]>([]);
  let myAssociations = $state<Association[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showArchived = $state(false);
  let isLoggedIn = $derived(!!currentUserId());

  onMount(async () => {
    try {
      const [all, mine] = await Promise.all([
        listAssociations('list'),
        isLoggedIn ? listMyAssociations() : Promise.resolve([]),
      ]);
      lists = all;
      myAssociations = mine;
    } catch (err) {
      Log.d('lists.load failed', err);
      error = m.list_load_error_fallback();
    } finally {
      loading = false;
    }
  });

  const myIds = $derived(new Set(myAssociations.map((a) => a.id)));
  const activeLists = $derived(lists.filter((a) => !a.archived));
  const archivedLists = $derived(lists.filter((a) => a.archived));

  /**
   * Active lists grouped into per-campaign-year "shelves": most recent year on
   * top, lists with no year collected under a trailing "Divers" shelf. Pure page
   * sections (no accordion) so the whole directory reads like trophy shelves.
   */
  const shelves = $derived.by(() => {
    const byYear: Record<number, Association[]> = {};
    for (const list of activeLists) {
      const key = list.promo ?? 0;
      (byYear[key] ??= []).push(list);
    }
    return Object.entries(byYear)
      .map(([year, items]) => ({
        year: Number(year),
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.year - a.year); // recent first; year 0 (Divers) lands last
  });

  /** Lists are created by global admins or BDE members holding MANAGE_ASSO. */
  const canCreate = $derived(
    isGlobalAdmin() || holdsBdeFlag(myAssociations, AssociationPermissionFlag.MANAGE_ASSO)
  );
</script>

<PageContainer width="grid">
  <PageHeader
    title={m.list_heading()}
    subtitle={m.list_subtitle()}
    backHref="/associations"
    backLabel={m.assoc_list_heading()}
  >
    {#snippet actions()}
      {#if canCreate}
        <a
          href="/lists/new"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-sm transition-all"
        >
          {m.list_new_create_btn()}
        </a>
      {/if}
    {/snippet}
  </PageHeader>

  <div class="space-y-8">
    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {:else}
      {#if activeLists.length === 0}
        <div
          class="border-cn-border bg-cn-surface rounded-2xl border-2 border-dashed py-16 text-center"
        >
          <div class="mb-3 text-5xl">📋</div>
          <h3 class="text-text-main mb-1 text-lg font-bold">{m.list_empty_title()}</h3>
          <p class="text-text-muted text-sm">{m.list_empty_desc()}</p>
        </div>
      {:else}
        {#each shelves as shelf (shelf.year)}
          <section class="space-y-3">
            <h2
              class="text-text-muted flex items-center gap-3 text-sm font-bold tracking-wide uppercase"
            >
              <span class="whitespace-nowrap">
                {shelf.year === 0
                  ? m.list_misc_heading()
                  : m.list_campaigns_heading({ year: shelf.year })}
              </span>
              <span class="bg-cn-border h-px flex-1"></span>
            </h2>
            <div class={CARD_GRID}>
              {#each shelf.items as list (list.id)}
                <AssociationTile
                  association={list}
                  href="/lists/{list.slug}"
                  isMember={myIds.has(list.id)}
                />
              {/each}
            </div>
          </section>
        {/each}
      {/if}

      <!-- Archived lists (collapsed by default) -->
      {#if archivedLists.length > 0}
        <section>
          <button
            type="button"
            onclick={() => (showArchived = !showArchived)}
            class="text-text-muted hover:text-text-main flex w-full items-center gap-2 text-base font-bold transition-colors"
            aria-expanded={showArchived}
          >
            <ChevronDown
              size={18}
              class="transition-transform {showArchived ? 'rotate-180' : ''}"
            />
            {m.list_archived_heading({ count: archivedLists.length })}
          </button>
          {#if showArchived}
            <div class="mt-3 {CARD_GRID}">
              {#each archivedLists as list (list.id)}
                <AssociationTile association={list} href="/lists/{list.slug}" />
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</PageContainer>
