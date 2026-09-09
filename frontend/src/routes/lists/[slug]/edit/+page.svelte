<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    mayActOnAssociation,
    AssociationPermissionFlag,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isAssociationSuperAdmin, isGlobalAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { Building2, Users, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
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
  /**
   * The same three tiers the association edit page gates on, read through the same helper. This
   * page used to spell the expression out by hand and omit the middle one, so a BDE `MANAGE_ASSO`
   * super-admin - whom the server grants `MANAGE_MEMBERS` on every association - was refused the
   * controls here. That omission is the exact drift `mayActOnAssociation` exists to end.
   */
  let permissionContext = $derived({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isAssociationSuperAdmin(),
    memberPermissions: myMembership?.permissions,
  });
  let canManageMembers = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_MEMBERS, permissionContext)
  );
  /**
   * Archiving is `PATCH :id { archived }`, admitted at `MANAGE_MEMBERS`; deleting is `DELETE :id`
   * behind a bare global-admin guard. The tab opens on the first, the delete card carries the
   * second - see the same pair on the association edit page.
   */
  let canArchiveList = $derived(canManageMembers);

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

<PageContainer>
  <PageHeader
    title={m.list_edit_page_title()}
    subtitle={list
      ? `@${list.slug}${list.promo ? ` · ${m.list_campaigns_heading({ year: list.promo })}` : ''}`
      : undefined}
    backHref="/lists/{encodeURIComponent(slug)}"
    backLabel={m.list_edit_back_to_public()}
  />

  <div class="space-y-6">
    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error && !list}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {:else if list}
      {#if error}
        <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
          {error}
        </div>
      {/if}

      <!-- Section tabs -->
      <nav
        data-swipe-nav-ignore
        class="border-cn-border/80 bg-cn-bg sticky top-0 z-30 -mx-4 border-y px-4 py-3 sm:mx-0 sm:rounded-2xl sm:border"
        aria-label={m.list_edit_sections_aria()}
      >
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            onclick={() => (editSection = 'profile')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
 {editSection === 'profile'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <Building2 size={17} />
            Profil
          </button>
          {#if canManageMembers}
            <button
              type="button"
              onclick={() => (editSection = 'members')}
              class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
 {editSection === 'members'
                ? 'bg-cn-yellow text-cn-ink shadow-sm'
                : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
            >
              <Users size={17} />
              {m.common_members_label()}
            </button>
          {/if}
          {#if canArchiveList}
            <button
              type="button"
              onclick={() => (editSection = 'danger')}
              class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
 {editSection === 'danger'
                ? 'bg-red-err/20 text-red-err border-red-err/30 border'
                : 'border-cn-border text-text-muted hover:text-red-err border bg-(--cn-surface)'}"
            >
              <TriangleAlert size={17} />
              {m.asso_edit_tab_danger()}
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

      {#if editSection === 'danger' && canArchiveList}
        <EditDangerTab
          asso={list}
          kind="list"
          canDelete={isGlobalAdminUser}
          onUpdated={(a) => (list = a)}
          onDeleted={() => goto('/lists')}
        />
      {/if}
    {/if}
  </div>
</PageContainer>
