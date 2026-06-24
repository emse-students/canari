<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    hasPermissionFlag,
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

  /** Lists are created by global admins or BDE members holding MANAGE_ASSO. */
  const canCreate = $derived(
    isGlobalAdmin() ||
      myAssociations.some(
        (a) => a.isBDE && hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.MANAGE_ASSO)
      )
  );
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <!-- Header -->
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <a
        href="/associations"
        class="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-main transition-colors"
      >
        <ArrowLeft size={15} />
        {m.assoc_list_heading()}
      </a>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight mt-1">{m.list_heading()}</h1>
      <p class="text-sm text-text-muted mt-1">{m.list_subtitle()}</p>
    </div>
    {#if canCreate}
      <a
        href="/lists/new"
        class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover"
      >
        {m.list_new_create_btn()}
      </a>
    {/if}
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
    <section>
      {#if activeLists.length === 0}
        <div
          class="text-center py-16 bg-[var(--cn-surface)]/60 rounded-2xl border-2 border-dashed border-cn-border"
        >
          <div class="text-5xl mb-3">📋</div>
          <h3 class="text-lg font-bold text-text-main mb-1">{m.list_empty_title()}</h3>
          <p class="text-sm text-text-muted">{m.list_empty_desc()}</p>
        </div>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          {#each activeLists as list (list.id)}
            <a
              href="/lists/{list.slug}"
              class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 hover:shadow-md transition-shadow block"
            >
              <div class="flex items-start gap-3">
                <AssociationAvatar name={list.name} logoUrl={list.logoUrl} size="lg" />
                <div class="min-w-0 flex-1">
                  <h3 class="font-bold text-text-main truncate">
                    {list.name}
                    {#if list.promo}
                      <span class="text-xs font-semibold text-text-muted">· {list.promo}</span>
                    {/if}
                  </h3>
                  {#if list.description?.trim()}
                    <div
                      class="mt-0.5 max-h-[2.75rem] overflow-hidden text-text-muted [&_.post-markdown]:text-sm [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                    >
                      <ProfileBioMarkdown source={list.description} />
                    </div>
                  {/if}
                  <p class="text-xs text-text-muted mt-1">
                    {(list.memberCount ?? 0) !== 1
                      ? m.assoc_member_count_many({ count: list.memberCount ?? 0 })
                      : m.assoc_member_count_one({ count: list.memberCount ?? 0 })}
                    {#if myIds.has(list.id)}
                      <span class="ml-1 text-cn-dark font-semibold">&#183; {m.assoc_list_member_badge()}</span>
                    {/if}
                  </p>
                </div>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Archived lists (collapsed by default) -->
    {#if archivedLists.length > 0}
      <section>
        <button
          type="button"
          onclick={() => (showArchived = !showArchived)}
          class="flex w-full items-center gap-2 text-base font-bold text-text-muted hover:text-text-main transition-colors"
          aria-expanded={showArchived}
        >
          <ChevronDown size={18} class="transition-transform {showArchived ? 'rotate-180' : ''}" />
          {m.list_archived_heading({ count: archivedLists.length })}
        </button>
        {#if showArchived}
          <div class="grid gap-4 sm:grid-cols-2 mt-3">
            {#each archivedLists as list (list.id)}
              <a
                href="/lists/{list.slug}"
                class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/60 p-5 opacity-75 hover:opacity-100 hover:shadow-md transition-all block"
              >
                <div class="flex items-start gap-3">
                  <AssociationAvatar name={list.name} logoUrl={list.logoUrl} size="lg" />
                  <div class="min-w-0 flex-1">
                    <h3 class="font-bold text-text-main truncate">
                      {list.name}
                      {#if list.promo}
                        <span class="text-xs font-semibold text-text-muted">· {list.promo}</span>
                      {/if}
                    </h3>
                    <p class="text-xs text-text-muted mt-1">
                      {(list.memberCount ?? 0) !== 1
                        ? m.assoc_member_count_many({ count: list.memberCount ?? 0 })
                        : m.assoc_member_count_one({ count: list.memberCount ?? 0 })}
                      <span class="ml-1 font-semibold">&#183; {m.assoc_list_archived_badge()}</span>
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
