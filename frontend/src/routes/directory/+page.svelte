<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { searchDirectory, type DirectoryUserRow } from '$lib/profile/api';
  import { listAssociations, type Association } from '$lib/associations/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { Search, Users, GraduationCap, Loader2 } from '@lucide/svelte';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { currentUserId } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';

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
      error = err instanceof Error ? err.message : m.directory_search_error_fallback();
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

<div class="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
  <div class="flex items-center gap-3">
    <Users class="text-cn-accent h-7 w-7 shrink-0" />
    <div>
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">{m.directory_heading()}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {m.directory_subtitle()}
      </p>
    </div>
  </div>

  <form
    class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/90 p-5 shadow-sm"
    onsubmit={(e) => void handleSearch(e)}
  >
    <div>
      <label for="dir-q" class="text-text-muted mb-1 block text-xs font-semibold"
        >{m.directory_label_name()}</label
      >
      <div class="relative">
        <Search size={18} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
        <input
          id="dir-q"
          type="search"
          bind:value={query}
          placeholder={m.directory_name_placeholder()}
          class="border-cn-border w-full rounded-xl border bg-transparent py-2.5 pr-3 pl-10 text-sm"
        />
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-3">
      <div>
        <label for="dir-promo" class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.directory_label_promo()}</label
        >
        <input
          id="dir-promo"
          type="number"
          min="1816"
          bind:value={promoFilter}
          placeholder="2024"
          class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
        />
      </div>
      <div>
        <label for="dir-formation" class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.directory_label_formation()}</label
        >
        <input
          id="dir-formation"
          type="text"
          bind:value={formationFilter}
          placeholder="ICM, GC…"
          class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
        />
      </div>
      <div>
        <label for="dir-asso" class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.directory_label_association()}</label
        >
        <select
          id="dir-asso"
          bind:value={associationFilter}
          class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm"
        >
          <option value="">{m.directory_asso_all()}</option>
          {#each associations as a (a.id)}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <button
      type="submit"
      disabled={loading}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50 sm:w-auto"
    >
      {#if loading}
        <Loader2 size={16} class="animate-spin" />
      {:else}
        <Search size={16} />
      {/if}
      {m.directory_search_btn()}
    </button>
  </form>

  {#if error}
    <p class="text-red-err text-sm">{error}</p>
  {:else if searched && !loading}
    <p class="text-text-muted text-sm">
      {total !== 1
        ? m.directory_results_count_many({ count: total })
        : m.directory_results_count_one({ count: total })}
      {#if total > results.length}
        {m.directory_results_truncated({ count: results.length })}
      {/if}
    </p>

    {#if results.length === 0}
      <div
        class="border-cn-border text-text-muted rounded-2xl border border-dashed px-4 py-10 text-center text-sm"
      >
        {m.directory_empty_result()}
      </div>
    {:else}
      <ul class="space-y-2">
        {#each results as user (user.id)}
          <li>
            <a
              href="/profile/{encodeURIComponent(user.id)}"
              class="border-cn-border hover:border-cn-yellow/40 flex items-center gap-3 rounded-2xl border bg-(--cn-surface)/90 px-4 py-3 transition-colors"
            >
              <div class="h-11 w-11 shrink-0 overflow-hidden rounded-full">
                <Avatar userId={user.id} fill shape="circle" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-text-main truncate text-sm font-bold">{displayName(user)}</p>
                <p
                  class="text-text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                >
                  {#if user.promo != null}
                    <span class="inline-flex items-center gap-1">
                      <GraduationCap size={12} />
                      {m.directory_user_promo({ year: user.promo })}
                    </span>
                  {/if}
                  {#if user.formation}
                    <span>{user.formation}</span>
                  {/if}
                </p>
                {#if user.bio?.trim()}
                  <p class="text-text-muted mt-1 line-clamp-1 text-xs">{user.bio}</p>
                {/if}
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
