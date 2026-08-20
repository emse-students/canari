<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociations,
    listMyAssociations,
    AssociationPermissionFlag,
    hasPermissionFlag,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
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
    isGlobalAdmin() ||
      myAssociations.some(
        (a) =>
          a.isBDE && hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.MANAGE_ASSO)
      )
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
      error = err instanceof Error ? err.message : m.assoc_list_load_error_fallback();
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

<div class="mx-auto max-w-4xl space-y-8 px-4 py-6 sm:px-6">
  <!-- Header -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">
        {m.assoc_list_heading()}
      </h1>
      <p class="text-text-muted mt-1 text-sm">{m.assoc_list_subtitle()}</p>
    </div>
    <div class="flex items-center gap-2">
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
          class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-sm transition-all"
        >
          {m.assoc_new_create_btn()}
        </a>
      {/if}
    </div>
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
    <!-- My associations -->
    {#if myAssociations.length > 0}
      <section>
        <h2 class="text-text-main mb-3 text-base font-bold">{m.assoc_list_mine_heading()}</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          {#each myAssociations as asso (asso.id)}
            <a
              href={memberHref(asso)}
              class="border-cn-border block rounded-2xl border bg-(--cn-surface) p-5 transition-shadow hover:shadow-md"
            >
              <div class="flex items-start gap-3">
                <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                <div class="min-w-0 flex-1">
                  <h3 class="text-text-main truncate font-bold">{asso.name}</h3>
                  {#if asso.type === 'list'}
                    <span
                      class="text-cn-dark bg-cn-dark/10 rounded-full px-2 py-0.5 text-xs font-semibold"
                    >
                      Liste{asso.promo ? ` ${asso.promo}` : ''}
                    </span>
                  {/if}
                  {#if asso.role}
                    <span
                      class="text-cn-dark bg-cn-yellow/20 rounded-full px-2 py-0.5 text-xs font-semibold"
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
      <h2 class="text-text-main mb-3 text-base font-bold">{m.assoc_list_all_heading()}</h2>
      {#if activeAssociations.length === 0}
        <div
          class="border-cn-border rounded-2xl border-2 border-dashed bg-(--cn-surface)/60 py-16 text-center"
        >
          <div class="mb-3 text-5xl">🏠</div>
          <h3 class="text-text-main mb-1 text-lg font-bold">{m.assoc_list_empty_title()}</h3>
          <p class="text-text-muted text-sm">{m.assoc_list_empty_desc()}</p>
        </div>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          {#each activeAssociations as asso (asso.id)}
            <a
              href="/associations/{asso.slug}"
              class="border-cn-border block rounded-2xl border bg-(--cn-surface) p-5 transition-shadow hover:shadow-md"
            >
              <div class="flex items-start gap-3">
                <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                <div class="min-w-0 flex-1">
                  <h3 class="text-text-main truncate font-bold">{asso.name}</h3>
                  {#if asso.description?.trim()}
                    <div
                      class="text-text-muted mt-0.5 max-h-[2.75rem] overflow-hidden [&_.post-markdown]:text-sm [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                    >
                      <ProfileBioMarkdown source={asso.description} />
                    </div>
                  {/if}
                  <p class="text-text-muted mt-1 text-xs">
                    {(asso.memberCount ?? 0) !== 1
                      ? m.assoc_member_count_many({ count: asso.memberCount ?? 0 })
                      : m.assoc_member_count_one({ count: asso.memberCount ?? 0 })}
                    {#if myIds.has(asso.id)}
                      <span class="text-cn-dark ml-1 font-semibold"
                        >&#183; {m.assoc_list_member_badge()}</span
                      >
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
          class="text-text-muted hover:text-text-main flex w-full items-center gap-2 text-base font-bold transition-colors"
          aria-expanded={showArchived}
        >
          <ChevronDown size={18} class="transition-transform {showArchived ? 'rotate-180' : ''}" />
          {m.assoc_list_archived_heading({ count: archivedAssociations.length })}
        </button>
        {#if showArchived}
          <div class="mt-3 grid gap-4 sm:grid-cols-2">
            {#each archivedAssociations as asso (asso.id)}
              <a
                href="/associations/{asso.slug}"
                class="border-cn-border block rounded-2xl border bg-(--cn-surface)/60 p-5 opacity-75 transition-all hover:opacity-100 hover:shadow-md"
              >
                <div class="flex items-start gap-3">
                  <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
                  <div class="min-w-0 flex-1">
                    <h3 class="text-text-main truncate font-bold">{asso.name}</h3>
                    <p class="text-text-muted mt-1 text-xs">
                      {(asso.memberCount ?? 0) !== 1
                        ? m.assoc_member_count_many({ count: asso.memberCount ?? 0 })
                        : m.assoc_member_count_one({ count: asso.memberCount ?? 0 })}
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
