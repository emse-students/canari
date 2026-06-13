<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { ChevronDown, ListChecks } from '@lucide/svelte';

  let associations = $state<Association[]>([]);
  let myAssociations = $state<Association[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showArchived = $state(false);
  let isLoggedIn = $derived(!!currentUserId());
  let isAdmin = $derived(isGlobalAdmin());

  onMount(async () => {
    try {
      const [all, mine] = await Promise.all([
        listAssociations('association'),
        isLoggedIn ? listMyAssociations() : Promise.resolve([]),
      ]);
      associations = all;
      myAssociations = mine;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger les associations';
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

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <!-- Header -->
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Associations</h1>
      <p class="text-sm text-text-muted mt-1">Découvrez les associations de la communauté</p>
    </div>
    <div class="flex items-center gap-2">
      <a
        href="/lists"
        class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
      >
        <ListChecks size={16} />
        Listes
      </a>
      <a
        href="/calendar"
        class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
      >
        Agenda global
      </a>
      {#if isAdmin}
        <a
          href="/associations/new"
          class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover"
        >
          Créer une association
        </a>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else}
    <!-- My associations -->
    {#if myAssociations.length > 0}
      <section>
        <h2 class="text-base font-bold text-text-main mb-3">Mes associations</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          {#each myAssociations as asso (asso.id)}
            <a
              href={memberHref(asso)}
              class="rounded-2xl border border-cn-border bg-white/80 p-5 hover:shadow-md transition-shadow block"
            >
              <div class="flex items-start gap-3">
                <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                <div class="min-w-0 flex-1">
                  <h3 class="font-bold text-text-main truncate">{asso.name}</h3>
                  {#if asso.type === 'list'}
                    <span
                      class="text-xs font-semibold text-cn-dark bg-cn-dark/10 px-2 py-0.5 rounded-full"
                    >
                      Liste{asso.promo ? ` ${asso.promo}` : ''}
                    </span>
                  {/if}
                  {#if asso.role}
                    <span
                      class="text-xs font-semibold text-cn-dark bg-cn-yellow/20 px-2 py-0.5 rounded-full"
                    >
                      {asso.role}
                    </span>
                  {/if}
                </div>
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <!-- All associations -->
    <section>
      <h2 class="text-base font-bold text-text-main mb-3">Toutes les associations</h2>
      {#if activeAssociations.length === 0}
        <div
          class="text-center py-16 bg-white/50 backdrop-blur-xl rounded-2xl border-2 border-dashed border-cn-border"
        >
          <div class="text-5xl mb-3">🏠</div>
          <h3 class="text-lg font-bold text-text-main mb-1">Aucune association</h3>
          <p class="text-sm text-text-muted">Soyez le premier à créer une association !</p>
        </div>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          {#each activeAssociations as asso (asso.id)}
            <a
              href="/associations/{asso.slug}"
              class="rounded-2xl border border-cn-border bg-white/80 p-5 hover:shadow-md transition-shadow block"
            >
              <div class="flex items-start gap-3">
                <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                <div class="min-w-0 flex-1">
                  <h3 class="font-bold text-text-main truncate">{asso.name}</h3>
                  {#if asso.description?.trim()}
                    <div
                      class="mt-0.5 max-h-[2.75rem] overflow-hidden text-text-muted [&_.post-markdown]:text-sm [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                    >
                      <ProfileBioMarkdown source={asso.description} />
                    </div>
                  {/if}
                  <p class="text-xs text-text-muted mt-1">
                    {asso.memberCount ?? 0} membre{(asso.memberCount ?? 0) !== 1 ? 's' : ''}
                    {#if myIds.has(asso.id)}
                      <span class="ml-1 text-cn-dark font-semibold">· Membre</span>
                    {/if}
                  </p>
                </div>
              </div>
            </a>
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
          class="flex w-full items-center gap-2 text-base font-bold text-text-muted hover:text-text-main transition-colors"
          aria-expanded={showArchived}
        >
          <ChevronDown
            size={18}
            class="transition-transform {showArchived ? 'rotate-180' : ''}"
          />
          Anciennes associations ({archivedAssociations.length})
        </button>
        {#if showArchived}
          <div class="grid gap-4 sm:grid-cols-2 mt-3">
            {#each archivedAssociations as asso (asso.id)}
              <a
                href="/associations/{asso.slug}"
                class="rounded-2xl border border-cn-border bg-white/50 p-5 opacity-75 hover:opacity-100 hover:shadow-md transition-all block"
              >
                <div class="flex items-start gap-3">
                  <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                  <div class="min-w-0 flex-1">
                    <h3 class="font-bold text-text-main truncate">{asso.name}</h3>
                    <p class="text-xs text-text-muted mt-1">
                      {asso.memberCount ?? 0} membre{(asso.memberCount ?? 0) !== 1 ? 's' : ''}
                      <span class="ml-1 font-semibold">· Archivée</span>
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
