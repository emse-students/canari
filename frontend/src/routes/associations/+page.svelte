<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    AssociationPermissionFlag,
    holdsBdeFlag,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationTile from '$lib/components/associations/AssociationTile.svelte';
  import { ChevronDown, ListChecks } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let associations = $state<Association[]>([]);
  let myAssociations = $state<Association[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showArchived = $state(false);
  let isLoggedIn = $derived(!!currentUserId());
  /** Associations are created by global admins or BDE members holding MANAGE_ASSO. */
  const canCreate = $derived(
    isGlobalAdmin() || holdsBdeFlag(myAssociations, AssociationPermissionFlag.MANAGE_ASSO)
  );

  onMount(async () => {
    try {
      const [all, mine] = await Promise.all([
        listAssociations('association'),
        isLoggedIn ? listMyAssociations() : Promise.resolve([]),
      ]);
      associations = all;
      myAssociations = mine;
    } catch (err) {
      error = m.assoc_list_load_error_fallback();
    } finally {
      loading = false;
    }
  });

  const myIds = $derived(new Set(myAssociations.map((a) => a.id)));
  const activeAssociations = $derived(associations.filter((a) => !a.archived));
  const archivedAssociations = $derived(associations.filter((a) => a.archived));

  /** Memberships route to /lists for promo lists, /associations otherwise. */
  function memberHref(a: Association): string {
    return a.type === 'list'
      ? `/lists/${encodeURIComponent(a.slug)}`
      : `/associations/${encodeURIComponent(a.slug)}`;
  }
</script>

<PageContainer width="grid">
  <PageHeader title={m.assoc_list_heading()} subtitle={m.assoc_list_subtitle()}>
    {#snippet actions()}
      <a
        href="/lists"
        class="border-cn-border text-text-main inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold transition-colors hover:bg-(--cn-surface)"
      >
        <ListChecks size={16} />
        {m.assoc_list_lists_btn()}
      </a>
      <a
        href="/calendar"
        class="border-cn-border text-text-main inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold transition-colors hover:bg-(--cn-surface)"
      >
        {m.assoc_list_global_calendar()}
      </a>
      {#if canCreate}
        <a
          href="/associations/new"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-sm transition-all"
        >
          {m.assoc_new_create_btn()}
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
      <!-- My associations -->
      {#if myAssociations.length > 0}
        <section>
          <h2 class="text-text-main mb-3 text-base font-bold">{m.assoc_list_mine_heading()}</h2>
          <div class={CARD_GRID}>
            {#each myAssociations as asso (asso.id)}
              <AssociationTile association={asso} href={memberHref(asso)} isMember />
            {/each}
          </div>
        </section>
      {/if}

      <!-- All associations -->
      <section>
        <h2 class="text-text-main mb-3 text-base font-bold">{m.assoc_list_all_heading()}</h2>
        {#if activeAssociations.length === 0}
          <div
            class="border-cn-border bg-cn-surface rounded-2xl border-2 border-dashed py-16 text-center"
          >
            <div class="mb-3 text-5xl">🏠</div>
            <h3 class="text-text-main mb-1 text-lg font-bold">{m.assoc_list_empty_title()}</h3>
            <p class="text-text-muted text-sm">{m.assoc_list_empty_desc()}</p>
          </div>
        {:else}
          <div class={CARD_GRID}>
            {#each activeAssociations as asso (asso.id)}
              <AssociationTile
                association={asso}
                href="/associations/{asso.slug}"
                isMember={myIds.has(asso.id)}
              />
            {/each}
          </div>
        {/if}
      </section>

      <!-- Archived associations (collapsed by default) -->
      {#if archivedAssociations.length > 0}
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
            {m.assoc_list_archived_heading({ count: archivedAssociations.length })}
          </button>
          {#if showArchived}
            <div class="mt-3 {CARD_GRID}">
              {#each archivedAssociations as asso (asso.id)}
                <AssociationTile association={asso} href="/associations/{asso.slug}" />
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</PageContainer>
