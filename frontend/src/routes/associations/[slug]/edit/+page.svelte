<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    startStripeOnboarding,
    fetchStripeConnectStatus,
    openStripeConnectDashboard,
    formatStripeConnectAmount,
    isStripeConnectReady,
    type StripeConnectStatusResult,
    hasPermissionFlag,
    ensureAssociationSuperAdmin,
    AssociationPermissionFlag,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    Users,
    CreditCard,
    ArrowLeft,
    Building2,
    AlertTriangle,
    FolderLock,
    RefreshCw,
    Clock,
    ClipboardList,
    Wallet,
    ArrowUpRight,
    Users as UsersIcon,
    HandCoins,
    Share2,
  } from '@lucide/svelte';
  import AssociationDocumentManager from '$lib/components/associations/AssociationDocumentManager.svelte';
  import EditProfileTab from '$lib/components/associations/edit/EditProfileTab.svelte';
  import EditMembersTab from '$lib/components/associations/edit/EditMembersTab.svelte';
  import EditDangerTab from '$lib/components/associations/edit/EditDangerTab.svelte';
  import EditBoutiqueTab from '$lib/components/associations/edit/EditBoutiqueTab.svelte';
  import EditAchatsTab from '$lib/components/associations/edit/EditAchatsTab.svelte';
  import EditFormsTab from '$lib/components/associations/edit/EditFormsTab.svelte';
  import EditCotisationsTab from '$lib/components/associations/edit/EditCotisationsTab.svelte';
  import EditDelegationTab from '$lib/components/associations/edit/EditDelegationTab.svelte';
  import { m } from '$lib/paraglide/messages';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((mb) => mb.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());
  /** BDE super-admin (MANAGE_ASSO): may administer this association without being a member. */
  let isSuperAdminUser = $derived(isAssociationSuperAdmin());

  let stripeLoading = $state(false);
  let stripeDashboardLoading = $state(false);
  let stripeConnectStatus = $state<StripeConnectStatusResult | null>(null);
  let stripeStatusLoading = $state(false);

  let stripePaymentsReady = $derived(
    isStripeConnectReady(stripeConnectStatus) || !!asso?.stripeOnboardingComplete
  );

  let editSection = $state<
    | 'profile'
    | 'members'
    | 'documents'
    | 'achats'
    | 'cotisations'
    | 'payments'
    | 'delegation'
    | 'formulaires'
    | 'danger'
  >('profile');

  let canManageDocuments = $derived(
    isGlobalAdminUser ||
      isSuperAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(
          myMembership.permissions ?? 0,
          AssociationPermissionFlag.MANAGE_DOCUMENTS
        ))
  );

  let canManageMembers = $derived(
    isGlobalAdminUser ||
      isSuperAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_MEMBERS))
  );

  let canManageProducts = $derived(
    isGlobalAdminUser ||
      isSuperAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_PRODUCTS))
  );

  let canManageForms = $derived(
    isGlobalAdminUser ||
      isSuperAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_FORMS))
  );

  let canManageStripeConnect = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(
          myMembership.permissions ?? 0,
          AssociationPermissionFlag.MANAGE_STRIPE_CONNECT
        ))
  );

  /** Paiements tab: boutique and/or Stripe Connect. */
  let canManagePaymentsSection = $derived(canManageStripeConnect || canManageProducts);

  const slug = $derived((page.params as Record<string, string>).slug);

  onMount(async () => {
    await loadData();
    // Detect return from Stripe Connect onboarding and poll for webhook confirmation.
    if (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('stripe_return') === '1' &&
      asso
    ) {
      // Clean up the URL param without triggering a navigation.
      const clean = window.location.pathname;
      window.history.replaceState(null, '', clean);
      if (!asso.stripeOnboardingComplete) {
        void pollStripeCompletion();
      } else {
        console.log('[Stripe] Returned from Stripe - onboarding already complete in DB.');
      }
    }
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
        // Prefer the module cache (warm on SPA navigation), then displayName from API.
        names[mb.userId] = getUserDisplayNameSync(mb.userId) || mb.displayName?.trim() || mb.userId;
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
      // Await the BDE super-admin probe so the access decision is deterministic.
      const superAdmin = await ensureAssociationSuperAdmin();
      const canEdit = isGlobalAdmin() || superAdmin || (!!mine && mine.isAdmin);
      if (!canEdit) {
        await goto(`/associations/${encodeURIComponent(slug)}`);
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Association not found';
    } finally {
      loading = false;
    }
  }

  /** Loads live Stripe Connect status from core-service (MANAGE_STRIPE_CONNECT). */
  async function refreshStripeConnectStatus() {
    if (!asso || !canManageStripeConnect) return;
    stripeStatusLoading = true;
    try {
      const live = await fetchStripeConnectStatus(asso.id);
      stripeConnectStatus = live;
      console.log(
        `[Stripe] Connect status - status=${live.status} charges=${live.chargesEnabled ?? false} dbComplete=${live.dbOnboardingComplete ?? false}`
      );
      if (isStripeConnectReady(live) && !asso.stripeOnboardingComplete) {
        const refreshed = await getAssociationBySlug(slug);
        asso = refreshed;
        stripeConnectStatus = { ...live, dbOnboardingComplete: refreshed.stripeOnboardingComplete };
      }
    } catch (err) {
      console.warn('[Stripe] Failed to load Connect status:', err);
    } finally {
      stripeStatusLoading = false;
    }
  }

  /** Opens the association Stripe Dashboard (payouts / bank account) in the system browser. */
  async function handleOpenStripeDashboard() {
    if (!asso) return;
    stripeDashboardLoading = true;
    try {
      const url = await openStripeConnectDashboard(asso.id);
      const { navigateExternal } = await import('$lib/utils/openExternal');
      await navigateExternal(url);
    } catch (err) {
      console.error('[Stripe] Failed to open dashboard:', err);
      error = err instanceof Error ? err.message : 'Failed to open Stripe';
    } finally {
      stripeDashboardLoading = false;
    }
  }

  async function handleStripeOnboarding() {
    if (!asso) return;
    stripeLoading = true;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const base = `${origin}/associations/${encodeURIComponent(asso.slug)}/edit`;
    console.log(
      `[Stripe] Starting onboarding - asso=${asso.id} accountId=${asso.stripeAccountId ?? 'new'}`
    );
    try {
      const result = await startStripeOnboarding(asso.id, asso.stripeAccountId ?? undefined, {
        returnUrl: `${base}?stripe_return=1`,
        refreshUrl: `${base}?stripe_return=1`,
      });
      console.log(
        `[Stripe] Onboarding URL received - accountId=${result.accountId} url=${result.url}`
      );
      if (result.accountId) {
        asso = { ...asso, stripeAccountId: result.accountId };
      }
      window.location.href = result.url;
    } catch (err) {
      console.error('[Stripe] Failed to start onboarding:', err);
      error = err instanceof Error ? err.message : 'Stripe error';
      stripeLoading = false;
    }
  }

  /** Polls the association until stripeOnboardingComplete=true or timeout (max 30 s). */
  async function pollStripeCompletion() {
    const MAX_ATTEMPTS = 10;
    const DELAY_MS = 3000;
    console.log('[Stripe] Returned from Stripe - waiting for webhook confirmation (max 30 s)…');
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      try {
        const refreshed = await getAssociationBySlug(slug);
        console.log(
          `[Stripe] Poll ${i}/${MAX_ATTEMPTS} - stripeOnboardingComplete=${refreshed.stripeOnboardingComplete}`
        );
        if (refreshed.stripeOnboardingComplete) {
          asso = refreshed;
          console.log('[Stripe] Stripe connection confirmed - onboarding complete.');
          await refreshStripeConnectStatus();
          return;
        }
        asso = refreshed;
        await refreshStripeConnectStatus();
        if (stripeConnectStatus?.status === 'active') {
          asso = await getAssociationBySlug(slug);
          return;
        }
      } catch (e) {
        console.warn(`[Stripe] Poll ${i} failed:`, e);
      }
    }
    console.warn(
      '[Stripe] Webhook not received after 30 s - check the Stripe dashboard and STRIPE_WEBHOOK_SECRET config.'
    );
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-6">
  <a
    href="/associations/{encodeURIComponent(slug)}"
    class="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text-main transition-colors"
  >
    <ArrowLeft size={16} />
    {m.asso_edit_page_back()}
  </a>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error && !asso}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if asso}
    <header class="space-y-1">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">{m.asso_edit_page_title()}</h1>
      <p class="text-sm text-text-muted">@{asso.slug}</p>
    </header>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <!-- Section tabs -->
    <nav
      data-swipe-nav-ignore
      class="sticky top-0 z-30 -mx-4 px-4 py-3 bg-[var(--cn-bg)]/95 backdrop-blur-md border-y border-cn-border/80 sm:border sm:rounded-2xl sm:mx-0"
      aria-label="Edit sections"
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
          {m.asso_edit_tab_profile()}
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
            {m.common_members_label()}
          </button>
        {/if}
        {#if canManagePaymentsSection}
          <button
            type="button"
            onclick={() => {
              editSection = 'payments';
              if (canManageStripeConnect) void refreshStripeConnectStatus();
            }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'payments'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <CreditCard size={17} />
            {m.asso_edit_tab_payments()}
          </button>
        {/if}
        {#if canManageDocuments}
          <button
            type="button"
            onclick={() => (editSection = 'documents')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'documents'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <FolderLock size={17} />
            {m.asso_edit_tab_documents()}
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => (editSection = 'achats')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'achats'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <UsersIcon size={17} />
            {m.asso_edit_tab_achats()}
          </button>
        {/if}
        {#if (canManageMembers || canManageProducts) && asso}
          <button
            type="button"
            onclick={() => (editSection = 'cotisations')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'cotisations'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <HandCoins size={17} />
            {m.asso_edit_tab_cotisations()}
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => (editSection = 'delegation')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'delegation'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <Share2 size={17} />
            {m.asso_edit_tab_delegation()}
          </button>
        {/if}
        {#if canManageForms}
          <button
            type="button"
            onclick={() => (editSection = 'formulaires')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'formulaires'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <ClipboardList size={17} />
            {m.asso_edit_tab_formulaires()}
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
            {m.asso_edit_tab_danger()}
          </button>
        {/if}
      </div>
    </nav>

    {#if editSection === 'profile'}
      <EditProfileTab {asso} canEdit={canManageMembers} onUpdated={(a) => (asso = a)} />
    {/if}

    {#if editSection === 'payments' && canManagePaymentsSection && asso}
      <div class="space-y-6">
        {#if canManageStripeConnect}
          <div
            class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
          >
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <h2 class="text-lg font-bold text-text-main flex items-center gap-2 tracking-tight">
                <CreditCard size={20} />
                Stripe Connect
              </h2>
              <button
                type="button"
                onclick={() => void refreshStripeConnectStatus()}
                disabled={stripeStatusLoading}
                class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg disabled:opacity-50"
              >
                <RefreshCw size={14} class={stripeStatusLoading ? 'animate-spin' : ''} />
                {m.common_refresh_button()}
              </button>
            </div>

            {#if stripeStatusLoading && !stripeConnectStatus}
              <p class="text-sm text-text-muted">{m.asso_stripe_status_verifying()}</p>
            {:else if stripeConnectStatus?.status === 'active' || stripePaymentsReady}
              <p class="text-sm text-green-600 font-semibold">{m.asso_stripe_connected_label()}</p>
              <p class="text-xs text-text-muted">
                {m.asso_stripe_connected_desc()}
              </p>
              {#if stripeConnectStatus?.balance}
                <div
                  class="rounded-xl border border-cn-border bg-cn-bg/50 p-4 space-y-3"
                >
                  <p class="text-sm font-bold text-text-main flex items-center gap-2">
                    <Wallet size={18} class="text-cn-dark" />
                    {m.asso_stripe_balance_title()}
                  </p>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <p class="text-xs text-text-muted">{m.asso_stripe_balance_available()}</p>
                      <p class="text-lg font-extrabold text-text-main tabular-nums">
                        {formatStripeConnectAmount(
                          stripeConnectStatus.balance.availableCents,
                          stripeConnectStatus.balance.currency
                        )}
                      </p>
                    </div>
                    <div>
                      <p class="text-xs text-text-muted">{m.asso_stripe_balance_pending()}</p>
                      <p class="text-lg font-extrabold text-text-muted tabular-nums">
                        {formatStripeConnectAmount(
                          stripeConnectStatus.balance.pendingCents,
                          stripeConnectStatus.balance.currency
                        )}
                      </p>
                    </div>
                  </div>
                  <p class="text-xs text-text-muted leading-relaxed">
                    {m.asso_stripe_balance_pending_note()}
                  </p>
                  {#if stripeConnectStatus.payoutsEnabled !== false}
                    <button
                      type="button"
                      onclick={() => void handleOpenStripeDashboard()}
                      disabled={stripeDashboardLoading}
                      class="inline-flex items-center justify-center gap-2 w-full sm:w-auto rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
                    >
                      {#if stripeDashboardLoading}
                        <RefreshCw size={16} class="animate-spin" />
                        {m.asso_stripe_manage_payouts_loading()}
                      {:else}
                        <ArrowUpRight size={16} />
                        {m.asso_stripe_manage_payouts_button()}
                      {/if}
                    </button>
                  {/if}
                </div>
              {:else if asso.stripeAccountId}
                <button
                  type="button"
                  onclick={() => void handleOpenStripeDashboard()}
                  disabled={stripeDashboardLoading}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg disabled:opacity-50"
                >
                  {m.asso_stripe_manage_payouts_link()}
                </button>
              {/if}
            {:else if stripeConnectStatus?.status === 'pending'}
              <div
                class="rounded-xl border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100 px-4 py-3 space-y-2"
              >
                <p class="text-sm font-semibold flex items-center gap-2">
                  <Clock size={18} class="shrink-0" />
                  {m.asso_stripe_verification_pending_title()}
                </p>
                <p class="text-sm leading-relaxed">
                  {m.asso_stripe_verification_pending_desc()}
                </p>
                {#if stripeConnectStatus.pendingVerification && stripeConnectStatus.pendingVerification.length > 0}
                  <p class="text-xs text-sky-800/80 dark:text-sky-200/80">
                    {m.asso_stripe_verification_items({ count: stripeConnectStatus.pendingVerification.length })}
                  </p>
                {/if}
              </div>
            {:else if stripeConnectStatus?.status === 'restricted'}
              <div
                class="rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm space-y-1"
              >
                <p class="font-semibold">{m.asso_stripe_restricted_title()}</p>
                <p>
                  {m.asso_stripe_restricted_prefix()}<a
                    href="https://dashboard.stripe.com/connect/accounts/{asso.stripeAccountId}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-semibold underline">{m.asso_stripe_restricted_dashboard_link()}</a
                  >{m.asso_stripe_restricted_suffix()}
                </p>
              </div>
            {:else if stripeConnectStatus?.status === 'unavailable'}
              <p class="text-sm text-amber-700">{m.asso_stripe_unavailable()}</p>
            {:else}
              <p class="text-sm text-text-muted leading-relaxed">
                {#if asso.stripeAccountId}
                  {m.asso_stripe_complete_setup()}
                {:else}
                  {m.asso_stripe_connect_account()}
                {/if}
              </p>
              {#if stripeConnectStatus?.status === 'onboarding_required' || !asso.stripeAccountId}
                <button
                  type="button"
                  onclick={handleStripeOnboarding}
                  disabled={stripeLoading}
                  class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 shadow-sm"
                >
                  {stripeLoading
                    ? m.asso_stripe_onboarding_loading()
                    : asso.stripeAccountId
                      ? m.asso_stripe_continue_setup_button()
                      : m.asso_stripe_configure_button()}
                </button>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if editSection === 'members' && canManageMembers}
      <EditMembersTab {asso} bind:members bind:resolvedMemberNames />
    {/if}

    {#if editSection === 'documents' && canManageDocuments && asso}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div>
          <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
            <FolderLock size={20} />
            {m.asso_doc_vault_title()}
          </h2>
          <p class="text-sm text-text-muted mt-1">
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
      <EditBoutiqueTab
        {asso}
        {stripePaymentsReady}
        stripePending={stripeConnectStatus?.status === 'pending'}
        {canManageStripeConnect}
      />
    {/if}

    {#if editSection === 'delegation' && canManageProducts && asso}
      <EditDelegationTab {asso} />
    {/if}

    {#if editSection === 'formulaires' && canManageForms && asso}
      <EditFormsTab
        {asso}
        {stripePaymentsReady}
        {canManageStripeConnect}
        onGoToPayments={() => (editSection = 'payments')}
      />
    {/if}

    {#if editSection === 'danger' && isGlobalAdminUser}
      <EditDangerTab
        {asso}
        onUpdated={(a) => (asso = a)}
        onDeleted={() => goto('/associations')}
      />
    {/if}
  {/if}
</div>
