<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { searchDirectory, type DirectoryUserRow } from '$lib/profile/api';
  import { listAssociations, type Association } from '$lib/associations/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { Search, Users, GraduationCap, Loader2 } from '@lucide/svelte';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { currentUserId } from '$lib/stores/user';

  const isLoggedIn = $derived(!!currentUserId());

  let query = $state('');
  let promoFilter = $state<number | ''>('');
  let formationFilter = $state('');
  let associationFilter = $state('');
  let associations = $state<Association[]>([]);

  let results = $state<DirectoryUserRow[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state('');
  let searched = $state(false);

  onMount(async () => {
    if (!currentUserId()) {
      await goto('/login?returnTo=/directory', { replaceState: true });
      return;
    }
    try {
      associations = await listAssociations();
    } catch {
      associations = [];
    }
  });

  async function handleSearch(e?: Event) {
    e?.preventDefault();
    loading = true;
    error = '';
    searched = true;
    try {
      const res = await searchDirectory({
        q: query.trim() || undefined,
        promo: promoFilter !== '' ? Number(promoFilter) : undefined,
        formation: formationFilter.trim() || undefined,
        associationId: associationFilter || undefined,
        limit: 30,
      });
      results = res.users;
      total = res.total;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de recherche';
      results = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  function displayName(user: DirectoryUserRow): string {
    return user.displayName?.trim() || getUserDisplayNameSync(user.id, user.id.slice(0, 8) + '…');
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-6">
  <div class="flex items-center gap-3">
    <Users class="h-7 w-7 text-cn-accent shrink-0" />
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Annuaire</h1>
      <p class="text-sm text-text-muted mt-0.5">
        Recherchez des membres par nom, promotion, cursus ou association
      </p>
    </div>
  </div>

  <form
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-5 space-y-4 shadow-sm"
    onsubmit={(e) => void handleSearch(e)}
  >
    <div>
      <label for="dir-q" class="text-xs font-semibold text-text-muted block mb-1">Nom</label>
      <div class="relative">
        <Search size={18} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          id="dir-q"
          type="search"
          bind:value={query}
          placeholder="Prénom, nom… (min. 2 caractères)"
          class="w-full rounded-xl border border-cn-border bg-transparent pl-10 pr-3 py-2.5 text-sm"
        />
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-3">
      <div>
        <label for="dir-promo" class="text-xs font-semibold text-text-muted block mb-1"
          >Promotion</label
        >
        <input
          id="dir-promo"
          type="number"
          min="1816"
          bind:value={promoFilter}
          placeholder="2024"
          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2.5 text-sm"
        />
      </div>
      <div>
        <label for="dir-formation" class="text-xs font-semibold text-text-muted block mb-1"
          >Cursus</label
        >
        <input
          id="dir-formation"
          type="text"
          bind:value={formationFilter}
          placeholder="ICM, GC…"
          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2.5 text-sm"
        />
      </div>
      <div>
        <label for="dir-asso" class="text-xs font-semibold text-text-muted block mb-1"
          >Association</label
        >
        <select
          id="dir-asso"
          bind:value={associationFilter}
          class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
        >
          <option value="">Toutes</option>
          {#each associations as a (a.id)}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <button
      type="submit"
      disabled={loading}
      class="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
    >
      {#if loading}
        <Loader2 size={16} class="animate-spin" />
      {:else}
        <Search size={16} />
      {/if}
      Rechercher
    </button>
  </form>

  {#if error}
    <p class="text-sm text-red-600">{error}</p>
  {:else if searched && !loading}
    <p class="text-sm text-text-muted">
      {total} résultat{total !== 1 ? 's' : ''}
      {#if total > results.length}
        (affichage des {results.length} premiers)
      {/if}
    </p>

    {#if results.length === 0}
      <div
        class="rounded-2xl border border-dashed border-cn-border px-4 py-10 text-center text-sm text-text-muted"
      >
        Aucun membre trouvé avec ces critères.
      </div>
    {:else}
      <ul class="space-y-2">
        {#each results as user (user.id)}
          <li>
            <a
              href="/profile/{encodeURIComponent(user.id)}"
              class="flex items-center gap-3 rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 px-4 py-3 hover:border-cn-yellow/40 transition-colors"
            >
              <div class="h-11 w-11 shrink-0 rounded-full overflow-hidden">
                <Avatar userId={user.id} fill shape="circle" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-text-main truncate">{displayName(user)}</p>
                <p class="text-xs text-text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {#if user.promo != null}
                    <span class="inline-flex items-center gap-1">
                      <GraduationCap size={12} />
                      Promo {user.promo}
                    </span>
                  {/if}
                  {#if user.formation}
                    <span>{user.formation}</span>
                  {/if}
                </p>
                {#if user.bio?.trim()}
                  <p class="text-xs text-text-muted mt-1 line-clamp-1">{user.bio}</p>
                {/if}
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
