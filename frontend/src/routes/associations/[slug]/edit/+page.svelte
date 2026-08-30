<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    startConnectAccountOnboarding,
    fetchConnectAccountStatus,
    openConnectAccountDashboard,
    disconnectConnectAccount,
    formatConnectAccountAmount,
    isConnectAccountReady,
    fetchActivePaymentProvider,
    type ConnectAccountStatusResult,
    type PaymentProviderId,
    mayActOnAssociation,
    ensureAssociationSuperAdmin,
    AssociationPermissionFlag,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    Users,
    CreditCard,
    ArrowLeft,
    Building2,
    TriangleAlert,
    FolderLock,
    RefreshCw,
    Clock,
    ClipboardList,
    Wallet,
    ArrowUpRight,
    Users as UsersIcon,
    HandCoins,
    Share2,
    Handshake,
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
  import EditPartnershipsTab from '$lib/components/associations/edit/EditPartnershipsTab.svelte';
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
  /** BDE super-admin (MANAGE_ASSO): may administer this association without being a member. */
  let isSuperAdminUser = $derived(isAssociationSuperAdmin());

  let onboardingLoading = $state(false);
  let dashboardLoading = $state(false);
  let disconnecting = $state(false);
  let connectAccountStatus = $state<ConnectAccountStatusResult | null>(null);
  let statusLoading = $state(false);
  /** Which payment provider core-service is configured to use (WP-LYDIA-1) - defaults to 'stripe' until fetched. */
  let activePaymentProvider = $state<PaymentProviderId>('stripe');

  let onlinePaymentsReady = $derived(
    isConnectAccountReady(connectAccountStatus) || !!asso?.stripeOnboardingComplete
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
    | 'partnerships'
    | 'danger'
  >('profile');

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

  let canManageDocuments = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_DOCUMENTS, permissionContext)
  );
  let canManageMembers = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_MEMBERS, permissionContext)
  );
  let canManageProducts = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_PRODUCTS, permissionContext)
  );
  let canManageForms = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_FORMS, permissionContext)
  );
  let canManagePartnerships = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_PARTNERSHIPS, permissionContext)
  );
  /**
   * The super-admin tier drops out on its own: `MANAGE_STRIPE_CONNECT` is in
   * `SUPER_ADMIN_EXCLUDED_FLAGS`, so the exception is read from the same data the server reads it
   * from instead of being an omission in this expression.
   */
  let canManageStripeConnect = $derived(
    mayActOnAssociation(AssociationPermissionFlag.MANAGE_STRIPE_CONNECT, permissionContext)
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
        void pollOnboardingCompletion();
      } else {
        console.log('[Payments] Returned from Stripe - onboarding already complete in DB.');
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
      error = err instanceof Error ? err.message : m.asso_edit_load_error();
    } finally {
      loading = false;
    }
  }

  /** Fetches which payment provider is active, once per page visit (it's server config, not per-association). */
  async function refreshActivePaymentProvider() {
    try {
      activePaymentProvider = await fetchActivePaymentProvider();
    } catch (err) {
      console.warn('[Payments] Failed to load active provider, defaulting to stripe:', err);
      activePaymentProvider = 'stripe';
    }
  }

  /** Loads live Stripe Connect status from core-service (MANAGE_STRIPE_CONNECT). */
  async function refreshConnectAccountStatus() {
    if (!asso || !canManageStripeConnect) return;
    statusLoading = true;
    try {
      const live = await fetchConnectAccountStatus(asso.id);
      connectAccountStatus = live;
      console.log(
        `[Payments] Connect status - status=${live.status} charges=${live.chargesEnabled ?? false} dbComplete=${live.dbOnboardingComplete ?? false}`
      );
      if (isConnectAccountReady(live) && !asso.stripeOnboardingComplete) {
        const refreshed = await getAssociationBySlug(slug);
        asso = refreshed;
        connectAccountStatus = {
          ...live,
          dbOnboardingComplete: refreshed.stripeOnboardingComplete,
        };
      }
    } catch (err) {
      console.warn('[Payments] Failed to load Connect status:', err);
    } finally {
      statusLoading = false;
    }
  }

  /** Opens the association Stripe Dashboard (payouts / bank account) in the system browser. */
  async function handleOpenProviderDashboard() {
    if (!asso) return;
    dashboardLoading = true;
    try {
      const url = await openConnectAccountDashboard(asso.id);
      const { navigateExternal } = await import('$lib/utils/openExternal');
      await navigateExternal(url);
    } catch (err) {
      console.error('[Payments] Failed to open dashboard:', err);
      error = err instanceof Error ? err.message : m.asso_payments_dashboard_open_error();
    } finally {
      dashboardLoading = false;
    }
  }

  /** Unlinks the Stripe Connect account from this association so onboarding can be restarted. */
  async function handleDisconnectAccount() {
    if (!asso) return;
    if (
      !(await showConfirm(m.asso_payments_disconnect_confirm(), {
        danger: true,
        confirmLabel: m.asso_payments_disconnect_button(),
      }))
    )
      return;
    disconnecting = true;
    try {
      await disconnectConnectAccount(asso.id);
      console.log(`[Payments] Disconnected Connect account for association ${asso.id}`);
      asso = { ...asso, stripeAccountId: null, stripeOnboardingComplete: false };
      connectAccountStatus = null;
    } catch (err) {
      console.error('[Payments] Failed to disconnect Connect account:', err);
      error = err instanceof Error ? err.message : m.asso_payments_disconnect_error();
    } finally {
      disconnecting = false;
    }
  }

  async function handleStartOnboarding() {
    if (!asso) return;
    onboardingLoading = true;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const base = `${origin}/associations/${encodeURIComponent(asso.slug)}/edit`;
    console.log(
      `[Payments] Starting onboarding - asso=${asso.id} accountId=${asso.stripeAccountId ?? 'new'}`
    );
    try {
      const result = await startConnectAccountOnboarding(
        asso.id,
        asso.stripeAccountId ?? undefined,
        {
          returnUrl: `${base}?stripe_return=1`,
          refreshUrl: `${base}?stripe_return=1`,
        }
      );
      console.log(
        `[Payments] Onboarding URL received - accountId=${result.accountId} url=${result.url}`
      );
      if (result.accountId) {
        asso = { ...asso, stripeAccountId: result.accountId };
      }
      window.location.href = result.url;
    } catch (err) {
      console.error('[Payments] Failed to start onboarding:', err);
      error = err instanceof Error ? err.message : m.asso_payments_onboarding_error();
      onboardingLoading = false;
    }
  }

  /** Polls the association until stripeOnboardingComplete=true or timeout (max 30 s). */
  async function pollOnboardingCompletion() {
    const MAX_ATTEMPTS = 10;
    const DELAY_MS = 3000;
    console.log('[Payments] Returned from Stripe - waiting for webhook confirmation (max 30 s)…');
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      try {
        const refreshed = await getAssociationBySlug(slug);
        console.log(
          `[Payments] Poll ${i}/${MAX_ATTEMPTS} - stripeOnboardingComplete=${refreshed.stripeOnboardingComplete}`
        );
        if (refreshed.stripeOnboardingComplete) {
          asso = refreshed;
          console.log('[Payments] Stripe connection confirmed - onboarding complete.');
          await refreshConnectAccountStatus();
          return;
        }
        asso = refreshed;
        await refreshConnectAccountStatus();
        if (connectAccountStatus?.status === 'active') {
          asso = await getAssociationBySlug(slug);
          return;
        }
      } catch (e) {
        console.warn(`[Payments] Poll ${i} failed:`, e);
      }
    }
    console.warn(
      '[Payments] Webhook not received after 30 s - check the Stripe dashboard and STRIPE_WEBHOOK_SECRET config.'
    );
  }
</script>

<div class="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
  <a
    href="/associations/{encodeURIComponent(slug)}"
    class="text-text-muted hover:text-text-main inline-flex items-center gap-2 text-sm transition-colors"
  >
    <ArrowLeft size={16} />
    {m.asso_edit_page_back()}
  </a>

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
    <header class="space-y-1">
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">
        {m.asso_edit_page_title()}
      </h1>
      <p class="text-text-muted text-sm">@{asso.slug}</p>
    </header>

    {#if error}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {/if}

    <!-- Section tabs -->
    <nav
      data-swipe-nav-ignore
      class="border-cn-border/80 sticky top-0 z-30 -mx-4 border-y bg-(--cn-bg)/95 px-4 py-3 backdrop-blur-md sm:mx-0 sm:rounded-2xl sm:border"
      aria-label="Edit sections"
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
          {m.asso_edit_tab_profile()}
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
        {#if canManagePaymentsSection}
          <button
            type="button"
            onclick={() => {
              editSection = 'payments';
              void refreshActivePaymentProvider();
              if (canManageStripeConnect) void refreshConnectAccountStatus();
            }}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'payments'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <CreditCard size={17} />
            {m.asso_edit_tab_payments()}
          </button>
        {/if}
        {#if canManageDocuments}
          <button
            type="button"
            onclick={() => (editSection = 'documents')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'documents'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <FolderLock size={17} />
            {m.asso_edit_tab_documents()}
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => (editSection = 'achats')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'achats'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <UsersIcon size={17} />
            {m.asso_edit_tab_achats()}
          </button>
        {/if}
        {#if (canManageMembers || canManageProducts) && asso}
          <button
            type="button"
            onclick={() => (editSection = 'cotisations')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'cotisations'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <HandCoins size={17} />
            {m.asso_edit_tab_cotisations()}
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => (editSection = 'delegation')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'delegation'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <Share2 size={17} />
            {m.asso_edit_tab_delegation()}
          </button>
        {/if}
        {#if canManageForms}
          <button
            type="button"
            onclick={() => (editSection = 'formulaires')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'formulaires'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <ClipboardList size={17} />
            {m.asso_edit_tab_formulaires()}
          </button>
        {/if}
        {#if canManagePartnerships}
          <button
            type="button"
            onclick={() => (editSection = 'partnerships')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'partnerships'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <Handshake size={17} />
            {m.asso_edit_tab_partenariats()}
          </button>
        {/if}
        {#if isGlobalAdminUser}
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
      <EditProfileTab {asso} canEdit={canManageMembers} onUpdated={(a) => (asso = a)} />
    {/if}

    {#if editSection === 'payments' && canManagePaymentsSection && asso}
      <div class="space-y-6">
        {#if canManageStripeConnect && activePaymentProvider === 'lydia'}
          <LydiaBusinessOnboardingForm
            {asso}
            onAccountCreated={(accountId) => {
              if (asso) asso = { ...asso, lydiaAccountId: accountId };
            }}
            onDisconnected={() => {
              if (asso) asso = { ...asso, lydiaAccountId: null, lydiaOnboardingComplete: false };
            }}
          />
        {:else if canManageStripeConnect}
          <div
            class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
                <CreditCard size={20} />
                {m.asso_payments_section_title()}
              </h2>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onclick={() => void refreshConnectAccountStatus()}
                  disabled={statusLoading}
                  class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  <RefreshCw size={14} class={statusLoading ? 'animate-spin' : ''} />
                  {m.common_refresh_button()}
                </button>
                {#if asso.stripeAccountId}
                  <button
                    type="button"
                    onclick={() => void handleDisconnectAccount()}
                    disabled={disconnecting}
                    class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    {disconnecting
                      ? m.asso_payments_disconnect_loading()
                      : m.asso_payments_disconnect_button()}
                  </button>
                {/if}
              </div>
            </div>

            {#if statusLoading && !connectAccountStatus}
              <p class="text-text-muted text-sm">{m.asso_payments_status_verifying()}</p>
            {:else if connectAccountStatus?.status === 'active' || onlinePaymentsReady}
              <p class="text-green-ok text-sm font-semibold">{m.asso_payments_connected_label()}</p>
              <p class="text-text-muted text-xs">
                {m.asso_payments_connected_desc()}
              </p>
              {#if connectAccountStatus?.balance}
                <div class="border-cn-border bg-cn-bg/50 space-y-3 rounded-xl border p-4">
                  <p class="text-text-main flex items-center gap-2 text-sm font-bold">
                    <Wallet size={18} class="text-cn-dark" />
                    {m.asso_payments_balance_title()}
                  </p>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <p class="text-text-muted text-xs">{m.asso_payments_balance_available()}</p>
                      <p class="text-text-main text-lg font-extrabold tabular-nums">
                        {formatConnectAccountAmount(
                          connectAccountStatus.balance.availableCents,
                          connectAccountStatus.balance.currency
                        )}
                      </p>
                    </div>
                    <div>
                      <p class="text-text-muted text-xs">{m.asso_payments_balance_pending()}</p>
                      <p class="text-text-muted text-lg font-extrabold tabular-nums">
                        {formatConnectAccountAmount(
                          connectAccountStatus.balance.pendingCents,
                          connectAccountStatus.balance.currency
                        )}
                      </p>
                    </div>
                  </div>
                  <p class="text-text-muted text-xs leading-relaxed">
                    {m.asso_payments_balance_pending_note()}
                  </p>
                  {#if connectAccountStatus.payoutsEnabled !== false}
                    <button
                      type="button"
                      onclick={() => void handleOpenProviderDashboard()}
                      disabled={dashboardLoading}
                      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 sm:w-auto"
                    >
                      {#if dashboardLoading}
                        <RefreshCw size={16} class="animate-spin" />
                        {m.asso_payments_manage_payouts_loading()}
                      {:else}
                        <ArrowUpRight size={16} />
                        {m.asso_payments_manage_payouts_button()}
                      {/if}
                    </button>
                  {/if}
                </div>
              {:else if asso.stripeAccountId}
                <button
                  type="button"
                  onclick={() => void handleOpenProviderDashboard()}
                  disabled={dashboardLoading}
                  class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {m.asso_payments_manage_payouts_link()}
                </button>
              {/if}
            {:else if connectAccountStatus?.status === 'pending'}
              <div
                class="space-y-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
              >
                <p class="flex items-center gap-2 text-sm font-semibold">
                  <Clock size={18} class="shrink-0" />
                  {m.asso_payments_verification_pending_title()}
                </p>
                <p class="text-sm leading-relaxed">
                  {m.asso_payments_verification_pending_desc()}
                </p>
                {#if connectAccountStatus.pendingVerification && connectAccountStatus.pendingVerification.length > 0}
                  <p class="text-xs text-sky-800/80 dark:text-sky-200/80">
                    {m.asso_payments_verification_items({
                      count: connectAccountStatus.pendingVerification.length,
                    })}
                  </p>
                {/if}
              </div>
            {:else if connectAccountStatus?.status === 'restricted'}
              <div
                class="border-red-err/30 bg-red-err/10 text-red-err space-y-1 rounded-xl border px-4 py-3 text-sm"
              >
                <p class="font-semibold">{m.asso_payments_restricted_title()}</p>
                <p>
                  {m.asso_payments_restricted_prefix()}<a
                    href="https://dashboard.stripe.com/connect/accounts/{asso.stripeAccountId}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-semibold underline">{m.asso_payments_restricted_dashboard_link()}</a
                  >{m.asso_payments_restricted_suffix()}
                </p>
              </div>
            {:else if connectAccountStatus?.status === 'unavailable'}
              <p class="text-amber-warn text-sm">{m.asso_payments_unavailable()}</p>
            {:else}
              <p class="text-text-muted text-sm leading-relaxed">
                {#if asso.stripeAccountId}
                  {m.asso_payments_complete_setup()}
                {:else}
                  {m.asso_payments_connect_account()}
                {/if}
              </p>
              {#if connectAccountStatus?.status === 'onboarding_required' || !asso.stripeAccountId}
                <button
                  type="button"
                  onclick={handleStartOnboarding}
                  disabled={onboardingLoading}
                  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
                >
                  {onboardingLoading
                    ? m.asso_payments_onboarding_loading()
                    : asso.stripeAccountId
                      ? m.asso_payments_continue_setup_button()
                      : m.asso_payments_configure_button()}
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
      <div class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
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
      <EditBoutiqueTab
        {asso}
        {onlinePaymentsReady}
        payoutAccountPending={connectAccountStatus?.status === 'pending'}
        {canManageStripeConnect}
      />
    {/if}

    {#if editSection === 'delegation' && canManageProducts && asso}
      <EditDelegationTab {asso} />
    {/if}

    {#if editSection === 'formulaires' && canManageForms && asso}
      <EditFormsTab
        {asso}
        {onlinePaymentsReady}
        {canManageStripeConnect}
        onGoToPayments={() => (editSection = 'payments')}
      />
    {/if}

    {#if editSection === 'partnerships' && canManagePartnerships && asso}
      <EditPartnershipsTab {asso} />
    {/if}

    {#if editSection === 'danger' && isGlobalAdminUser}
      <EditDangerTab {asso} onUpdated={(a) => (asso = a)} onDeleted={() => goto('/associations')} />
    {/if}
  {/if}
</div>
