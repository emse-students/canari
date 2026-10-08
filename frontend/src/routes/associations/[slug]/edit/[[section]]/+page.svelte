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
    isPaymentAccountReady,
    getMyBdeReach,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { resolveUserDisplayName, rosterDisplayName } from '$lib/utils/users/displayName';
  import {
    Users,
    CreditCard,
    Building2,
    TriangleAlert,
    FolderLock,
    ClipboardList,
    Users as UsersIcon,
    HandCoins,
    Share2,
    Handshake,
    Inbox,
    Globe,
  } from '@lucide/svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import type { Crumb, HubRow } from '$lib/components/navigation/breadcrumb';
  import {
    editRights,
    editTrail,
    editSectionHref,
    mayOpenEditSection,
    parseEditSection,
    visibleEditSections,
    type EditSection,
  } from '$lib/associations/editSections';
  import AssociationDocumentManager from '$lib/components/associations/AssociationDocumentManager.svelte';
  import EditProfileTab from '$lib/components/associations/edit/EditProfileTab.svelte';
  import EditMembersTab from '$lib/components/associations/edit/EditMembersTab.svelte';
  import EditAudienceTab from '$lib/components/associations/edit/EditAudienceTab.svelte';
  import EditDangerTab from '$lib/components/associations/edit/EditDangerTab.svelte';
  import EditBoutiqueTab from '$lib/components/associations/edit/EditBoutiqueTab.svelte';
  import EditAchatsTab from '$lib/components/associations/edit/EditAchatsTab.svelte';
  import EditFormsTab from '$lib/components/associations/edit/EditFormsTab.svelte';
  import EditCotisationsTab from '$lib/components/associations/edit/EditCotisationsTab.svelte';
  import EditDelegationTab from '$lib/components/associations/edit/EditDelegationTab.svelte';
  import EditPartnershipsTab from '$lib/components/associations/edit/EditPartnershipsTab.svelte';
  import EditProposalsTab from '$lib/components/associations/edit/EditProposalsTab.svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { wordingFor } from '$lib/associations/kindWording';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import LydiaBusinessOnboardingForm from '$lib/components/associations/edit/LydiaBusinessOnboardingForm.svelte';
  import { m } from '$lib/paraglide/messages';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((mb) => mb.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());
  /**
   * BDE super-admin OF THIS association (MANAGE_ASSO in the BDE of a space it reaches, WP6c step
   * 2): may administer it without being a member. `superAdminOf` is the server's `me/bde-reach`.
   */
  let superAdminOf = $state<string[]>([]);
  let isSuperAdminUser = $derived(!!asso && superAdminOf.includes(asso.id));

  /**
   * The wording of what is being edited - an association, a list or an institution. The ONE
   * source of every noun on this page (see `kindWording`); never a ternary at a call site.
   */
  let words = $derived(wordingFor(asso?.type ?? 'association'));

  /**
   * The payment provider core-service is configured to use (WP-LYDIA-1) is the shared store's
   * `current`: `null` while it loads or when the fetch failed, and NEVER a guess. A provider
   * -specific card is drawn only once it is known - a default here drew the wrong provider's
   * card for a deep link straight onto the payments tab.
   */
  let onlinePaymentsReady = $derived(
    !!asso && isPaymentAccountReady(asso, activePaymentProvider.current)
  );

  // The tab title names what is edited; the path alone cannot tell an institution from a club.
  $effect(() => {
    if (!asso) return;
    setPageTitle(words.editTitle());
    return () => setPageTitle(null);
  });

  /**
   * The open section is a ROUTE segment (`/edit/<section>`), never local state: Back goes up one
   * level, a reload keeps the place and a link can be shared. `null` is the hub. A segment that is
   * not a section never reaches here - `+page.ts` redirects it.
   */
  let editSection = $derived<EditSection | null>(parseEditSection(page.params.section));

  /**
   * The three tiers this page gates on, gathered once. `myMembership.permissions` is always
   * present for the caller's own row (`listMembers` returns it whatever the caller's rights), so
   * a `undefined` here means "not a member" and nothing else.
   */
  let permissionContext = $derived({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isSuperAdminUser,
    memberPermissions: myMembership?.permissions,
  });

  /** Every right the sections gate on - ONE rule, shared with the hub and the route guard. */
  let rights = $derived(editRights(permissionContext, asso?.type));
  let canManageDocuments = $derived(rights.documents);
  let canManageMembers = $derived(rights.members);
  let canManageProducts = $derived(rights.products);
  let canManageForms = $derived(rights.forms);
  let canManagePartnerships = $derived(rights.partnerships);
  /**
   * The proposal queue: republications (D38) and co-organisations (D39). The section key stays
   * `republications`: notifications already in people's lists deep-link to it.
   */
  let canHandleProposals = $derived(rights.proposals);
  /**
   * The super-admin tier drops out on its own: `MANAGE_STRIPE_CONNECT` is in
   * `SUPER_ADMIN_EXCLUDED_FLAGS`, so the exception is read from the same data the server reads it
   * from instead of being an omission in this expression.
   */
  let canManageStripeConnect = $derived(rights.stripeConnect);

  /** Paiements tab: boutique and/or the payment account. */
  let canManagePaymentsSection = $derived(canManageStripeConnect || canManageProducts);

  /**
   * The Danger tab holds TWO controls the server rights DIFFERENTLY, and gating the tab on the
   * stricter of the two hid the other one from everybody entitled to it.
   *
   * Archiving is `PATCH :id { archived }`, which the server admits through
   * `GlobalAdminOrAssociationRoleGuard` at `MANAGE_MEMBERS` - so an association's own admin holds
   * it, and so does a BDE `MANAGE_ASSO` super-admin, `MANAGE_MEMBERS` not being in
   * `SUPER_ADMIN_EXCLUDED_FLAGS`. Deleting is `DELETE :id` behind a bare `GlobalAdminGuard` and is
   * the platform administrator's alone. Both were behind `isGlobalAdminUser` here, which is how a
   * BDE member holding the power to administer associations found the section absent (reported
   * 2026-09-09).
   *
   * The tab therefore opens on the right to ARCHIVE, and the delete card carries its own tier.
   */
  let canArchiveAssociation = $derived(canManageMembers);
  /**
   * The delete card's own tier, and it is NOT the platform administrator's any more.
   *
   * `DELETE :id` moved to `GlobalAdminOrBdeSuperAdminGuard` on 2026-09-10 (user), so it now admits
   * exactly what CREATE has always admitted: a global admin, or a BDE member holding
   * `MANAGE_ASSO`. It is deliberately NOT `mayActOnAssociation`, because an association's own
   * admin never holds it, however many flags they have. Since WP6c step 2 the server checks it in
   * the handler, scoped: the BDE must govern THIS association (a space it reaches), which is what
   * `isSuperAdminUser` already reads.
   */
  let canDeleteAssociation = $derived(isGlobalAdminUser || isSuperAdminUser);
  /**
   * The audience tab (WP-B): the server admits a global admin, or a BDE star writing an association
   * or a list of its own campus; an institution's audience is a global admin's alone
   * (`AUDIENCE_INSTITUTION_ADMIN_ONLY`). A member of the association is never enough.
   */
  let canEditAudience = $derived(rights.audience);

  const slug = $derived((page.params as Record<string, string>).slug);

  const SECTION_ICONS: Record<EditSection, HubRow['icon']> = {
    profile: Building2,
    members: Users,
    payments: CreditCard,
    documents: FolderLock,
    achats: UsersIcon,
    cotisations: HandCoins,
    delegation: Share2,
    formulaires: ClipboardList,
    partnerships: Handshake,
    republications: Inbox,
    audience: Globe,
    danger: TriangleAlert,
  };

  /** The localized name of a section; a message must be read at render time, hence a function. */
  function sectionLabel(section: EditSection): string {
    switch (section) {
      case 'profile':
        return m.asso_edit_tab_profile();
      case 'members':
        return m.common_members_label();
      case 'payments':
        return m.asso_edit_tab_payments();
      case 'documents':
        return m.asso_edit_tab_documents();
      case 'achats':
        return m.asso_edit_tab_achats();
      case 'cotisations':
        return m.asso_edit_tab_cotisations();
      case 'delegation':
        return m.asso_edit_tab_delegation();
      case 'formulaires':
        return m.asso_edit_tab_formulaires();
      case 'partnerships':
        return m.asso_edit_tab_partenariats();
      case 'republications':
        return m.asso_edit_tab_proposals();
      case 'audience':
        return m.asso_edit_tab_audience();
      case 'danger':
        return m.asso_edit_tab_danger();
    }
  }

  /** The path to this page (see `editTrail`); every crumb is a link. */
  let crumbs = $derived(
    editTrail(slug, editSection, {
      directory: words.directoryLabel(),
      directoryHref: words.directoryHref,
      asso: asso?.name,
      edit: words.editTitle(),
      section: editSection ? sectionLabel(editSection) : undefined,
    })
  );

  /** One hub row per section the reader may open; a count only where the roster already has it. */
  let hubRows = $derived(
    visibleEditSections(rights).map((section): HubRow => ({
      key: section,
      href: editSectionHref(slug, section),
      label: sectionLabel(section),
      icon: SECTION_ICONS[section],
      summary:
        section === 'members'
          ? m.asso_edit_hub_members_summary({ count: members.length })
          : undefined,
      tone: section === 'danger' ? 'danger' : 'default',
    }))
  );

  // A segment is user input: once the rights are known, a section its reader may not open is
  // replaced by the hub. `loading` guards the moment `rights` is still the empty default.
  // Only for someone admitted to the area at all: a reader `loadData` is sending to the public page
  // must not be raced by a second redirect.
  let mayEnterArea = $derived(isGlobalAdminUser || isSuperAdminUser || !!myMembership?.isAdmin);
  $effect(() => {
    if (loading || !asso || !editSection || !mayEnterArea) return;
    if (!mayOpenEditSection(editSection, rights)) {
      console.warn('[associations/edit] section refused, back to the hub', editSection);
      void goto(resolve(editSectionHref(slug)), { replaceState: true });
    }
  });

  onMount(async () => {
    // Fetched on arrival, not on the first click of the payments tab: a deep link
    // (`/edit/payments`) draws that section with no click at all.
    void loadActivePaymentProvider();
    await loadData();
  });

  async function loadData() {
    loading = true;
    error = '';
    try {
      const a = await getAssociationBySlug(slug);
      asso = a;
      members = await listMembers(a.id);
      const names: Record<string, string> = {};
      for (const mb of members) {
        // Prefer the module cache (warm on SPA navigation), then the roster row's own columns.
        names[mb.userId] = rosterDisplayName(mb);
      }
      resolvedMemberNames = names;
      // Always resolve asynchronously - API displayName may be stale or be the bare userId.
      for (const mb of members) {
        resolveUserDisplayName(mb.userId).then((resolved) => {
          if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [mb.userId]: resolved };
        });
      }
      const uid = currentUserId();
      const mine = members.find((mb) => mb.userId === uid);
      // Await the BDE reach so the access decision is deterministic. It is THIS association's
      // super-admin tier (WP6c step 2): MANAGE_ASSO in the BDE of a space it reaches.
      superAdminOf = (await getMyBdeReach()).manageAsso;
      const canEdit = isGlobalAdmin() || isSuperAdminUser || (!!mine && mine.isAdmin);
      if (!canEdit) {
        await goto(resolve(`/associations/${encodeURIComponent(slug)}`));
        return;
      }
    } catch (err) {
      error = m.asso_edit_load_error();
    } finally {
      loading = false;
    }
  }
</script>

<PageContainer width="tool">
  <PageHeader
    title={editSection ? sectionLabel(editSection) : words.editTitle()}
    subtitle={asso ? `@${asso.slug}` : undefined}
    {crumbs}
  />

  <div class="space-y-6">
    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error && !asso}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {:else if asso}
      {#if error}
        <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
          {error}
        </div>
      {/if}

      {#if editSection === null}
        <SectionHub rows={hubRows} label={m.asso_edit_hub_label()} />
      {/if}

      {#if editSection === 'profile'}
        <EditProfileTab {asso} canEdit={canManageMembers} onUpdated={(a) => (asso = a)} />
      {/if}

      {#if editSection === 'payments' && canManagePaymentsSection && asso}
        <div class="space-y-6">
          {#if canManageStripeConnect && activePaymentProvider.current === null}
            <!-- Provider unknown: no provider-specific card until it is. -->
            <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
              <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
                <CreditCard size={20} />
                {m.asso_payments_section_title()}
              </h2>
              {#if activePaymentProvider.failed}
                <p class="text-red-err text-sm" role="alert">{m.asso_payments_provider_error()}</p>
                <button
                  type="button"
                  onclick={() => void loadActivePaymentProvider()}
                  class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold"
                >
                  {m.asso_payments_provider_retry()}
                </button>
              {:else}
                <p class="text-text-muted text-sm">{m.asso_payments_provider_loading()}</p>
              {/if}
            </div>
          {:else if canManageStripeConnect && activePaymentProvider.current === 'lydia'}
            <LydiaBusinessOnboardingForm
              {asso}
              onAccountCreated={(accountId, dashboardUrl) => {
                if (asso)
                  asso = { ...asso, lydiaAccountId: accountId, lydiaDashboardUrl: dashboardUrl };
              }}
              onValidated={() => {
                if (asso) asso = { ...asso, lydiaOnboardingComplete: true };
              }}
              onDisconnected={() => {
                if (asso)
                  asso = {
                    ...asso,
                    lydiaAccountId: null,
                    lydiaOnboardingComplete: false,
                    lydiaDashboardUrl: null,
                  };
              }}
            />
          {:else if canManageStripeConnect && activePaymentProvider.current === 'disabled'}
            <!-- Payments declared OFF platform-wide: the existing "not configured" state, never an
                 onboarding flow. -->
            <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
              <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
                <CreditCard size={20} />
                {m.asso_payments_section_title()}
              </h2>
              <p class="text-amber-warn text-sm">{m.asso_payments_unavailable()}</p>
            </div>
          {/if}
        </div>
      {/if}

      {#if editSection === 'members' && canManageMembers}
        <EditMembersTab {asso} bind:members bind:resolvedMemberNames />
      {/if}

      {#if editSection === 'documents' && canManageDocuments && asso}
        <div class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-6 shadow-sm">
          <div>
            <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
              <FolderLock size={20} />
              {m.asso_doc_vault_title()}
            </h2>
            <p class="text-text-muted mt-1 text-sm">
              {m.asso_doc_vault_desc()}
            </p>
          </div>
          <AssociationDocumentManager associationId={asso.id} />
        </div>
      {/if}

      {#if editSection === 'achats' && canManageProducts && asso}
        <EditAchatsTab {asso} />
      {/if}

      {#if editSection === 'cotisations' && (canManageMembers || canManageProducts) && asso}
        <EditCotisationsTab bind:asso {canManageMembers} {canManageProducts} />
      {/if}

      {#if editSection === 'payments' && canManagePaymentsSection && asso && canManageProducts}
        <EditBoutiqueTab {asso} {onlinePaymentsReady} {canManageStripeConnect} />
      {/if}

      {#if editSection === 'delegation' && canManageProducts && asso}
        <EditDelegationTab {asso} />
      {/if}

      {#if editSection === 'formulaires' && canManageForms && asso}
        <EditFormsTab
          {asso}
          {onlinePaymentsReady}
          {canManageStripeConnect}
          onGoToPayments={() => goto(resolve(editSectionHref(slug, 'payments')))}
        />
      {/if}

      {#if editSection === 'partnerships' && canManagePartnerships && asso}
        <EditPartnershipsTab {asso} />
      {/if}

      {#if editSection === 'republications' && canHandleProposals && asso}
        <EditProposalsTab {asso} />
      {/if}

      {#if editSection === 'audience' && canEditAudience}
        <EditAudienceTab {asso} isGlobalAdmin={isGlobalAdminUser} />
      {/if}

      {#if editSection === 'danger' && canArchiveAssociation}
        <EditDangerTab
          {asso}
          kind={asso.type}
          canDelete={canDeleteAssociation}
          onUpdated={(a) => (asso = a)}
          onDeleted={() => goto(resolve(words.directoryHref))}
        />
      {/if}
    {/if}
  </div>
</PageContainer>
