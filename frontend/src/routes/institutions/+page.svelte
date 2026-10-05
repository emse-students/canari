<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import {
    listAssociationDirectory,
    listMyAssociations,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId } from '$lib/stores/user';
  import AssociationTile from '$lib/components/associations/AssociationTile.svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let institutions = $state<Association[]>([]);
  let myAssociations = $state<Association[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showArchived = $state(false);
  let isLoggedIn = $derived(!!currentUserId());

  // The same directory as /associations and /lists, narrowed by type: a reader sees the
  // institutions whose rules reach their spaces plus those they belong to (D37). A new institution
  // has no rule, so it is listed for its members only until an admin ticks the /admin/spaces grid.
  onMount(async () => {
    try {
      const [all, mine] = await Promise.all([
        listAssociationDirectory('institution'),
        isLoggedIn ? listMyAssociations() : Promise.resolve([]),
      ]);
      institutions = all;
      myAssociations = mine;
    } catch (err) {
      Log.d('institutions.load failed', err);
      error = m.inst_load_error_fallback();
    } finally {
      loading = false;
    }
  });

  const myIds = $derived(new Set(myAssociations.map((a) => a.id)));
  const active = $derived(institutions.filter((a) => !a.archived));
  const archived = $derived(institutions.filter((a) => a.archived));
</script>

<PageContainer width="grid">
  <PageHeader
    title={m.inst_heading()}
    subtitle={m.inst_subtitle()}
    backHref="/associations"
    backLabel={m.assoc_list_heading()}
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
      {#if active.length === 0}
        <div
          class="border-cn-border bg-cn-surface rounded-2xl border-2 border-dashed py-16 text-center"
        >
          <div class="mb-3 text-5xl">🏛️</div>
          <h3 class="text-text-main mb-1 text-lg font-bold">{m.inst_empty_title()}</h3>
          <p class="text-text-muted text-sm">{m.inst_empty_desc()}</p>
        </div>
      {:else}
        <div class={CARD_GRID}>
          {#each active as inst (inst.id)}
            <AssociationTile
              association={inst}
              href="/associations/{encodeURIComponent(inst.slug)}"
              isMember={myIds.has(inst.id)}
            />
          {/each}
        </div>
      {/if}

      {#if archived.length > 0}
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
            {m.inst_archived_heading({ count: archived.length })}
          </button>
          {#if showArchived}
            <div class="mt-3 {CARD_GRID}">
              {#each archived as inst (inst.id)}
                <AssociationTile
                  association={inst}
                  href="/associations/{encodeURIComponent(inst.slug)}"
                />
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</PageContainer>
