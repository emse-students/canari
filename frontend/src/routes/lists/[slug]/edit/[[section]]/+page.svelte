<script lang="ts">
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    getMyBdeReach,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { resolveUserDisplayName, rosterDisplayName } from '$lib/utils/users/displayName';
  import { Building2, Users, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import EditProfileTab from '$lib/components/associations/edit/EditProfileTab.svelte';
  import EditMembersTab from '$lib/components/associations/edit/EditMembersTab.svelte';
  import EditDangerTab from '$lib/components/associations/edit/EditDangerTab.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import type { HubRow } from '$lib/components/navigation/breadcrumb';
  import {
    LIST_EDIT_SECTIONS,
    editRights,
    editSectionHref,
    editTrail,
    mayOpenEditSection,
    parseEditSection,
    visibleEditSections,
    type EditSection,
  } from '$lib/associations/editSections';
  import { wordingFor } from '$lib/associations/kindWording';

  let list = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let resolvedMemberNames = $state<Record<string, string>>({});
  let loading = $state(true);
  let error = $state('');
  /**
   * The open section is a ROUTE segment (`/lists/<slug>/edit/<section>`), never local state: Back
   * goes up one level, a reload keeps the place. `null` is the hub; a segment that is not one of the
   * list's three sections never reaches here - `+page.ts` redirects it.
   */
  let editSection = $derived<EditSection | null>(parseEditSection(page.params.section));

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());
  /**
   * The same three tiers the association edit page gates on, read through the same helper. This
   * page used to spell the expression out by hand and omit the middle one, so a BDE `MANAGE_ASSO`
   * super-admin - whom the server grants `MANAGE_MEMBERS` on every association - was refused the
   * controls here. That omission is the exact drift `mayActOnAssociation` exists to end.
   *
   * The super-admin tier is THIS list's (WP6c step 2): `MANAGE_ASSO` in the BDE of a space it
   * reaches, read from the server's `me/bde-reach` - a BDE of another space holds nothing here.
   */
  let superAdminOf = $state<string[]>([]);
  let isSuperAdminUser = $derived(!!list && superAdminOf.includes(list.id));
  let permissionContext = $derived({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isSuperAdminUser,
    memberPermissions: myMembership?.permissions,
  });
  let rights = $derived(editRights(permissionContext, 'list'));
  let canManageMembers = $derived(rights.members);
  /**
   * Archiving is `PATCH :id { archived }`, admitted at `MANAGE_MEMBERS`; deleting is `DELETE :id`
   * behind a bare global-admin guard. The tab opens on the first, the delete card carries the
   * second - see the same pair on the association edit page.
   */
  let canArchiveList = $derived(canManageMembers);
  /** Deleting is `DELETE :id`: a global admin, or MANAGE_ASSO in the BDE governing this list. */
  let canDeleteList = $derived(isGlobalAdminUser || isSuperAdminUser);

  const slug = $derived((page.params as Record<string, string>).slug);

  const SECTION_ICONS: Partial<Record<EditSection, HubRow['icon']>> = {
    profile: Building2,
    members: Users,
    danger: TriangleAlert,
  };

  /** The localized name of a section; a message must be read at render time, hence a function. */
  function sectionLabel(section: EditSection): string {
    switch (section) {
      case 'members':
        return m.common_members_label();
      case 'danger':
        return m.asso_edit_tab_danger();
      default:
        return m.asso_edit_tab_profile();
    }
  }

  /** The path to this page (see `editTrail`); every crumb is a link. */
  let crumbs = $derived(
    editTrail(slug, editSection, {
      directory: wordingFor('list').directoryLabel(),
      directoryHref: wordingFor('list').directoryHref,
      asso: list?.name,
      edit: m.list_edit_page_title(),
      section: editSection ? sectionLabel(editSection) : undefined,
      base: '/lists',
    })
  );

  /** One hub row per section the reader may open. */
  let hubRows = $derived(
    visibleEditSections(rights, LIST_EDIT_SECTIONS).map((section): HubRow => ({
      key: section,
      href: editSectionHref(slug, section, '/lists'),
      label: sectionLabel(section),
      icon: SECTION_ICONS[section]!,
      summary:
        section === 'members'
          ? m.asso_edit_hub_members_summary({ count: members.length })
          : undefined,
      tone: section === 'danger' ? 'danger' : 'default',
    }))
  );

  // A segment is user input: once the rights are known, a section its reader may not open is
  // replaced by the hub. Only for someone admitted to the area at all - `loadData` sends the rest
  // to the public page and a second redirect must not race it.
  let mayEnterArea = $derived(isGlobalAdminUser || !!myMembership?.isAdmin);
  $effect(() => {
    if (loading || !list || !editSection || !mayEnterArea) return;
    if (!mayOpenEditSection(editSection, rights)) {
      console.warn('[lists/edit] section refused, back to the hub', editSection);
      void goto(resolve(editSectionHref(slug, null, '/lists')), { replaceState: true });
    }
  });

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    void getMyBdeReach().then((reach) => (superAdminOf = reach.manageAsso));
    try {
      const a = await getAssociationBySlug(slug);
      // A regular association is managed from the association edit page.
      if (a.type !== 'list') {
        await goto(resolve(`/associations/${encodeURIComponent(slug)}/edit`), {
          replaceState: true,
        });
        return;
      }
      list = a;
      members = await listMembers(a.id);
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = rosterDisplayName(m);
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
        await goto(resolve(`/lists/${encodeURIComponent(slug)}`));
        return;
      }
    } catch {
      error = m.list_edit_load_error();
    } finally {
      loading = false;
    }
  }
</script>

<PageContainer>
  <PageHeader
    title={editSection ? sectionLabel(editSection) : m.list_edit_page_title()}
    subtitle={list
      ? `@${list.slug}${list.promo ? ` · ${m.list_campaigns_heading({ year: list.promo })}` : ''}`
      : undefined}
    {crumbs}
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

      {#if editSection === null}
        <SectionHub rows={hubRows} label={m.asso_edit_hub_label()} />
      {/if}

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
          canDelete={canDeleteList}
          onUpdated={(a) => (list = a)}
          onDeleted={() => goto('/lists')}
        />
      {/if}
    {/if}
  </div>
</PageContainer>
