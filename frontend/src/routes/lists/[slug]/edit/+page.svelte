<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    hasPermissionFlag,
    AssociationPermissionFlag,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { ArrowLeft, Building2, Users, AlertTriangle } from '@lucide/svelte';
  import EditProfileTab from '$lib/components/associations/edit/EditProfileTab.svelte';
  import EditMembersTab from '$lib/components/associations/edit/EditMembersTab.svelte';
  import EditDangerTab from '$lib/components/associations/edit/EditDangerTab.svelte';

  let list = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let resolvedMemberNames = $state<Record<string, string>>({});
  let loading = $state(true);
  let error = $state('');
  let editSection = $state<'profile' | 'members' | 'danger'>('profile');

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());
  let canManageMembers = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_MEMBERS))
  );

  const slug = $derived((page.params as Record<string, string>).slug);

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    try {
      const a = await getAssociationBySlug(slug);
      // A regular association is managed from the association edit page.
      if (a.type !== 'list') {
        await goto(`/associations/${encodeURIComponent(slug)}/edit`, { replaceState: true });
        return;
      }
      list = a;
      members = await listMembers(a.id);
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = getUserDisplayNameSync(m.userId) || m.displayName?.trim() || m.userId;
      }
      resolvedMemberNames = names;
      for (const m of members) {
        resolveUserDisplayName(m.userId).then((resolved) => {
          if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
        });
      }
      const mine = members.find((m) => m.userId === currentUserId());
      const canEdit = isGlobalAdmin() || (!!mine && mine.isAdmin);
      if (!canEdit) {
        await goto(`/lists/${encodeURIComponent(slug)}`);
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Liste introuvable';
    } finally {
      loading = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-6">
  <a
    href="/lists/{encodeURIComponent(slug)}"
    class="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text-main transition-colors"
  >
    <ArrowLeft size={16} />
    Retour à la page publique
  </a>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error && !list}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if list}
    <header class="space-y-1">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Gestion de la liste</h1>
      <p class="text-sm text-text-muted">@{list.slug}{list.promo ? ` · Promo ${list.promo}` : ''}</p>
    </header>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <!-- Section tabs -->
    <nav
      data-swipe-nav-ignore
      class="sticky top-0 z-30 -mx-4 px-4 py-3 bg-[var(--cn-bg)]/95 backdrop-blur-md border-y border-cn-border/80 sm:border sm:rounded-2xl sm:mx-0"
      aria-label="Sections édition"
    >
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => (editSection = 'profile')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {editSection === 'profile'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Building2 size={17} />
          Profil
        </button>
        {#if canManageMembers}
          <button
            type="button"
            onclick={() => (editSection = 'members')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'members'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <Users size={17} />
            Membres
          </button>
        {/if}
        {#if isGlobalAdminUser}
          <button
            type="button"
            onclick={() => (editSection = 'danger')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'danger'
              ? 'bg-red-100 text-red-800 border border-red-200'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-red-700'}"
          >
            <AlertTriangle size={17} />
            Danger
          </button>
        {/if}
      </div>
    </nav>

    {#if editSection === 'profile'}
      <EditProfileTab asso={list} canEdit={canManageMembers} onUpdated={(a) => (list = a)} />
    {/if}

    {#if editSection === 'members' && canManageMembers}
      <EditMembersTab asso={list} bind:members bind:resolvedMemberNames />
    {/if}

    {#if editSection === 'danger' && isGlobalAdminUser}
      <EditDangerTab
        asso={list}
        kind="list"
        onUpdated={(a) => (list = a)}
        onDeleted={() => goto('/lists')}
      />
    {/if}
  {/if}
</div>
