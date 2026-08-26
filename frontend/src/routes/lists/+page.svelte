<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    holdsBdeFlag,
    AssociationPermissionFlag,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { ChevronDown, ArrowLeft } from '@lucide/svelte';
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
      error = err instanceof Error ? err.message : m.list_load_error_fallback();
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

<div class="mx-auto max-w-4xl space-y-8 px-4 py-6 sm:px-6">
  <!-- Header -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <a
        href="/associations"
        class="text-text-muted hover:text-text-main inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeft size={15} />
        {m.assoc_list_heading()}
      </a>
      <h1 class="text-text-main mt-1 text-2xl font-extrabold tracking-tight">{m.list_heading()}</h1>
      <p class="text-text-muted mt-1 text-sm">{m.list_subtitle()}</p>
    </div>
    {#if canCreate}
      <a
        href="/lists/new"
        class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-sm transition-all"
      >
        {m.list_new_create_btn()}
      </a>
    {/if}
  </div>

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
        class="border-cn-border rounded-2xl border-2 border-dashed bg-(--cn-surface)/60 py-16 text-center"
      >
        <div class="mb-3 text-5xl">📋</div>
        <h3 class="text-text-main mb-1 text-lg font-bold">{m.list_empty_title()}</h3>
        <p class="text-text-muted text-sm">{m.list_empty_desc()}</p>
      </div>
    {:else}
      {#each shelves as shelf (shelf.year)}
        <section class="space-y-3">
          <h2
            class="text-text-muted flex items-center gap-3 text-sm font-extrabold tracking-wide uppercase"
          >
            <span class="whitespace-nowrap">
              {shelf.year === 0
                ? m.list_misc_heading()
                : m.list_campaigns_heading({ year: shelf.year })}
            </span>
            <span class="bg-cn-border h-px flex-1"></span>
          </h2>
          <div class="grid gap-4 sm:grid-cols-2">
            {#each shelf.items as list (list.id)}
              <a
                href="/lists/{list.slug}"
                class="border-cn-border block rounded-2xl border bg-(--cn-surface) p-5 transition-shadow hover:shadow-md"
              >
                <div class="flex items-start gap-3">
                  <AssociationAvatar name={list.name} logoUrl={list.logoUrl} size="lg" />
                  <div class="min-w-0 flex-1">
                    {#if list.parentName}
                      <div class="text-cn-dark text-[0.7rem] font-bold tracking-wide uppercase">
                        {list.parentName}
                      </div>
                    {/if}
                    <h3 class="text-text-main truncate font-bold">{list.name}</h3>
                    {#if list.description?.trim()}
                      <div
                        class="text-text-muted mt-0.5 max-h-[2.75rem] overflow-hidden [&_.post-markdown]:text-sm [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                      >
                        <ProfileBioMarkdown source={list.description} compact />
                      </div>
                    {/if}
                    {#if myIds.has(list.id)}
                      <p class="text-cn-dark mt-1 text-xs font-semibold">
                        {m.assoc_list_member_badge()}
                      </p>
                    {/if}
                  </div>
                </div>
              </a>
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
          <ChevronDown size={18} class="transition-transform {showArchived ? 'rotate-180' : ''}" />
          {m.list_archived_heading({ count: archivedLists.length })}
        </button>
        {#if showArchived}
          <div class="mt-3 grid gap-4 sm:grid-cols-2">
            {#each archivedLists as list (list.id)}
              <a
                href="/lists/{list.slug}"
                class="border-cn-border block rounded-2xl border bg-(--cn-surface)/60 p-5 opacity-75 transition-all hover:opacity-100 hover:shadow-md"
              >
                <div class="flex items-start gap-3">
                  <AssociationAvatar name={list.name} logoUrl={list.logoUrl} size="lg" />
                  <div class="min-w-0 flex-1">
                    {#if list.parentName}
                      <div class="text-text-muted text-[0.7rem] font-bold tracking-wide uppercase">
                        {list.parentName}
                      </div>
                    {/if}
                    <h3 class="text-text-main truncate font-bold">
                      {list.name}
                      {#if list.promo}
                        <span class="text-text-muted text-xs font-semibold">· {list.promo}</span>
                      {/if}
                    </h3>
                    <p class="text-text-muted mt-1 text-xs font-semibold">
                      {m.assoc_list_archived_badge()}
                    </p>
                  </div>
                </div>
              </a>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>
