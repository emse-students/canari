<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import AssociationsHeader from '$lib/components/associations/AssociationsHeader.svelte';
  import { onMount } from 'svelte';
  import {
    listAssociationDirectory,
    listMyAssociations,
    AssociationPermissionFlag,
    holdsBdeFlag,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import MyMembershipsSection from '$lib/components/associations/MyMembershipsSection.svelte';
  import AssociationTile from '$lib/components/associations/AssociationTile.svelte';
  import { groupAssociationsForSelect } from '$lib/associations/selectGroups';
  import { ChevronDown } from '@lucide/svelte';
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
      // Institutions and lists have their own tab (/institutions, /lists), each with its own "Mes ...".
      const [all, mine] = await Promise.all([
        listAssociationDirectory('association'),
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
  /** Only the reader's associations: institutions and lists have their own tab's "Mes ..." block. */
  const myAssos = $derived(groupAssociationsForSelect(myAssociations).assos);
  const activeAssociations = $derived(associations.filter((a) => !a.archived));
  const archivedAssociations = $derived(associations.filter((a) => a.archived));
</script>

<PageContainer width="grid">
  <AssociationsHeader
    section="associations"
    title={m.assoc_list_heading()}
    subtitle={m.assoc_list_subtitle()}
    {canCreate}
  />

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
      <MyMembershipsSection
        heading={m.assoc_list_mine_heading()}
        items={myAssos}
        href={(a) => `/associations/${encodeURIComponent(a.slug)}`}
      />

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
