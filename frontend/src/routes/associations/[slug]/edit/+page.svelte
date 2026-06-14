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
    listAssociationProductsForManage,
    listAssociationPurchases,
    grantProductPurchase,
    listAssociationForms,
    type Association,
    type AssociationMember,
    type AssociationProduct,
    type AssociationPurchase,
    type AssociationForm,
  } from '$lib/associations/api';
  import {
    listPendingCashSubmissions,
    validateCashSubmission,
    cancelCashSubmission,
    type PendingCashSubmission,
  } from '$lib/forms/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
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
    Gift,
  } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import AssociationDocumentManager from '$lib/components/associations/AssociationDocumentManager.svelte';
  import EditProfileTab from '$lib/components/associations/edit/EditProfileTab.svelte';
  import EditMembersTab from '$lib/components/associations/edit/EditMembersTab.svelte';
  import EditDangerTab from '$lib/components/associations/edit/EditDangerTab.svelte';
  import EditBoutiqueTab from '$lib/components/associations/edit/EditBoutiqueTab.svelte';
  import { hasPermissionFlag, AssociationPermissionFlag } from '$lib/associations/api';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());

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
    | 'payments'
    | 'formulaires'
    | 'danger'
  >('profile');

  let canManageDocuments = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(
          myMembership.permissions ?? 0,
          AssociationPermissionFlag.MANAGE_DOCUMENTS
        ))
  );

  let canManageMembers = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_MEMBERS))
  );

  let canManageProducts = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_PRODUCTS))
  );

  let canManageForms = $derived(
    isGlobalAdminUser ||
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

  // ── Achats state (products list shared with the grant form) ────────────────
  let products = $state<AssociationProduct[]>([]);
  let purchases = $state<AssociationPurchase[]>([]);
  let purchasesLoading = $state(false);
  let purchasesError = $state('');
  let purchaseFilterProductId = $state('');
  let grantUserId = $state('');
  let grantProductId = $state('');
  let grantAmountEuros = $state<number | ''>('');
  let grantingProduct = $state(false);
  const grantSelectedProduct = $derived(products.find((p) => p.id === grantProductId));
  const grantNeedsAmount = $derived(
    grantSelectedProduct != null && grantSelectedProduct.amountCents == null
  );
  const filteredPurchases = $derived(
    purchaseFilterProductId
      ? purchases.filter((p) => p.productId === purchaseFilterProductId)
      : purchases
  );

  // ── Formulaires state ────────────────────────────────────────────────────
  let forms = $state<AssociationForm[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  let pendingCash = $state<Record<string, PendingCashSubmission[]>>({});
  /** True when at least one association form requires online payment (basePrice > 0). */
  let hasPaidForms = $derived(forms.some((f) => f.basePrice > 0));

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
        console.log('[Stripe] Retour Stripe - onboarding déjà marqué complet en DB.');
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
      for (const m of members) {
        // Prefer the module cache (warm on SPA navigation), then displayName from API
        names[m.userId] = getUserDisplayNameSync(m.userId) || m.displayName?.trim() || m.userId;
      }
      resolvedMemberNames = names;
      // Always resolve asynchronously - API displayName may be stale or be the bare userId
      for (const m of members) {
        resolveUserDisplayName(m.userId).then((resolved) => {
          if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
        });
      }
      const uid = currentUserId();
      const mine = members.find((m) => m.userId === uid);
      const canEdit = isGlobalAdmin() || (!!mine && mine.isAdmin);
      if (!canEdit) {
        await goto(`/associations/${encodeURIComponent(slug)}`);
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Association introuvable';
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
        `[Stripe] Statut Connect - status=${live.status} charges=${live.chargesEnabled ?? false} dbComplete=${live.dbOnboardingComplete ?? false}`
      );
      if (isStripeConnectReady(live) && !asso.stripeOnboardingComplete) {
        const refreshed = await getAssociationBySlug(slug);
        asso = refreshed;
        stripeConnectStatus = { ...live, dbOnboardingComplete: refreshed.stripeOnboardingComplete };
      }
    } catch (err) {
      console.warn('[Stripe] Impossible de charger le statut Connect:', err);
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
      console.error('[Stripe] Impossible d’ouvrir le tableau de bord:', err);
      error = err instanceof Error ? err.message : 'Impossible d’ouvrir Stripe';
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
      `[Stripe] Lancement onboarding - asso=${asso.id} accountId=${asso.stripeAccountId ?? 'nouveau'}`
    );
    try {
      const result = await startStripeOnboarding(asso.id, asso.stripeAccountId ?? undefined, {
        returnUrl: `${base}?stripe_return=1`,
        refreshUrl: `${base}?stripe_return=1`,
      });
      console.log(
        `[Stripe] URL onboarding reçue - accountId=${result.accountId} url=${result.url}`
      );
      if (result.accountId) {
        asso = { ...asso, stripeAccountId: result.accountId };
      }
      window.location.href = result.url;
    } catch (err) {
      console.error('[Stripe] Échec démarrage onboarding:', err);
      error = err instanceof Error ? err.message : 'Erreur Stripe';
      stripeLoading = false;
    }
  }

  /** Polls the association until stripeOnboardingComplete=true or timeout (max 30 s). */
  async function pollStripeCompletion() {
    const MAX_ATTEMPTS = 10;
    const DELAY_MS = 3000;
    console.log('[Stripe] Retour depuis Stripe - attente confirmation webhook (max 30 s)…');
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      try {
        const refreshed = await getAssociationBySlug(slug);
        console.log(
          `[Stripe] Poll ${i}/${MAX_ATTEMPTS} - stripeOnboardingComplete=${refreshed.stripeOnboardingComplete} chargesEnabled=${refreshed.stripeOnboardingComplete}`
        );
        if (refreshed.stripeOnboardingComplete) {
          asso = refreshed;
          console.log('[Stripe] ✓ Connexion Stripe confirmée - onboarding complet.');
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
        console.warn(`[Stripe] Poll ${i} échoué:`, e);
      }
    }
    console.warn(
      '[Stripe] Webhook non reçu après 30 s - vérifier le dashboard Stripe et la config STRIPE_WEBHOOK_SECRET.'
    );
  }

  async function loadPurchases() {
    if (!asso) return;
    purchasesLoading = true;
    purchasesError = '';
    try {
      const [prods, rows] = await Promise.all([
        listAssociationProductsForManage(asso.id),
        listAssociationPurchases(asso.id),
      ]);
      products = prods;
      purchases = rows;
    } catch (e) {
      purchasesError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      purchasesLoading = false;
    }
  }

  function purchaseBuyerName(purchase: AssociationPurchase): string {
    if (purchase.firstName || purchase.lastName) {
      return `${purchase.firstName ?? ''} ${purchase.lastName ?? ''}`.trim();
    }
    return purchase.userId.slice(0, 8) + '…';
  }

  function paymentMethodLabel(method: AssociationPurchase['paymentMethod']): string {
    if (method === 'cash') return 'Espèces / manuel';
    if (method === 'stripe') return 'Stripe';
    return method;
  }

  async function handleGrantProduct() {
    if (!asso || !grantUserId.trim() || !grantProductId) return;
    if (grantNeedsAmount && grantAmountEuros === '') {
      purchasesError = 'Indiquez le montant payé pour ce produit.';
      return;
    }
    grantingProduct = true;
    purchasesError = '';
    try {
      await grantProductPurchase(asso.id, grantProductId, {
        userId: grantUserId.trim(),
        ...(grantNeedsAmount && grantAmountEuros !== ''
          ? { amountCents: Math.round(Number(grantAmountEuros) * 100) }
          : {}),
      });
      grantUserId = '';
      grantProductId = '';
      grantAmountEuros = '';
      await loadPurchases();
    } catch (e) {
      purchasesError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      grantingProduct = false;
    }
  }

  async function loadForms() {
    if (!asso) return;
    formsLoading = true;
    formsError = '';
    try {
      forms = await listAssociationForms(asso.id);
      const cashMap: Record<string, PendingCashSubmission[]> = {};
      await Promise.all(
        forms
          .filter((f) => f.allowCashPayment)
          .map(async (f) => {
            try {
              cashMap[f.id] = await listPendingCashSubmissions(f.id);
            } catch {
              cashMap[f.id] = [];
            }
          })
      );
      pendingCash = cashMap;
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      formsLoading = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-6">
  <a
    href="/associations/{encodeURIComponent(slug)}"
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
  {:else if error && !asso}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if asso}
    <header class="space-y-1">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Gestion de l'association</h1>
      <p class="text-sm text-text-muted">@{asso.slug}</p>
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
            Paiements
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
            Documents
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => {
              editSection = 'achats';
              void loadPurchases();
            }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'achats'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <UsersIcon size={17} />
            Achats
          </button>
        {/if}
        {#if canManageForms}
          <button
            type="button"
            onclick={() => {
              editSection = 'formulaires';
              void loadForms();
            }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'formulaires'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <ClipboardList size={17} />
            Formulaires
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
                Actualiser
              </button>
            </div>

            {#if stripeStatusLoading && !stripeConnectStatus}
              <p class="text-sm text-text-muted">Vérification du statut Stripe…</p>
            {:else if stripeConnectStatus?.status === 'active' || stripePaymentsReady}
              <p class="text-sm text-green-600 font-semibold">Stripe Connect activé</p>
              <p class="text-xs text-text-muted">
                Les paiements en ligne (formulaires, boutique) sont disponibles.
              </p>
              {#if stripeConnectStatus?.balance}
                <div
                  class="rounded-xl border border-cn-border bg-cn-bg/50 p-4 space-y-3"
                >
                  <p class="text-sm font-bold text-text-main flex items-center gap-2">
                    <Wallet size={18} class="text-cn-dark" />
                    Solde
                  </p>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <p class="text-xs text-text-muted">Disponible</p>
                      <p class="text-lg font-extrabold text-text-main tabular-nums">
                        {formatStripeConnectAmount(
                          stripeConnectStatus.balance.availableCents,
                          stripeConnectStatus.balance.currency
                        )}
                      </p>
                    </div>
                    <div>
                      <p class="text-xs text-text-muted">En attente</p>
                      <p class="text-lg font-extrabold text-text-muted tabular-nums">
                        {formatStripeConnectAmount(
                          stripeConnectStatus.balance.pendingCents,
                          stripeConnectStatus.balance.currency
                        )}
                      </p>
                    </div>
                  </div>
                  <p class="text-xs text-text-muted leading-relaxed">
                    Les fonds « en attente » seront disponibles après le délai de traitement Stripe.
                    Les virements se gèrent sur le tableau de bord Stripe de l'association (compte
                    Standard).
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
                        Ouverture…
                      {:else}
                        <ArrowUpRight size={16} />
                        Gérer les virements sur Stripe
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
                  Gérer les virements sur Stripe →
                </button>
              {/if}
            {:else if stripeConnectStatus?.status === 'pending'}
              <div
                class="rounded-xl border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100 px-4 py-3 space-y-2"
              >
                <p class="text-sm font-semibold flex items-center gap-2">
                  <Clock size={18} class="shrink-0" />
                  Vérification en cours chez Stripe
                </p>
                <p class="text-sm leading-relaxed">
                  Votre dossier a bien été transmis. Stripe valide généralement le compte sous
                  quelques heures à quelques jours ouvrés - aucune action n’est requise de votre
                  part pour l’instant.
                </p>
                {#if stripeConnectStatus.pendingVerification && stripeConnectStatus.pendingVerification.length > 0}
                  <p class="text-xs text-sky-800/80 dark:text-sky-200/80">
                    Éléments en cours de vérification : {stripeConnectStatus.pendingVerification
                      .length}
                  </p>
                {/if}
              </div>
            {:else if stripeConnectStatus?.status === 'restricted'}
              <div
                class="rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm space-y-1"
              >
                <p class="font-semibold">Compte Stripe restreint</p>
                <p>
                  Stripe a limité ce compte Connect. Consultez le
                  <a
                    href="https://dashboard.stripe.com/connect/accounts/{asso.stripeAccountId}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-semibold underline">tableau de bord Stripe</a
                  >
                  ou contactez le support Stripe.
                </p>
              </div>
            {:else if stripeConnectStatus?.status === 'unavailable'}
              <p class="text-sm text-amber-700">Stripe n’est pas configuré sur le serveur.</p>
            {:else}
              <p class="text-sm text-text-muted leading-relaxed">
                {#if asso.stripeAccountId}
                  Terminez la configuration sur Stripe ou attendez la validation si vous venez de
                  soumettre votre dossier.
                {:else}
                  Connectez un compte Stripe pour les paiements des formulaires, de la boutique et
                  des billetteries de cette association.
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
                    ? 'Redirection…'
                    : asso.stripeAccountId
                      ? 'Continuer la configuration'
                      : 'Configurer Stripe'}
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
            Coffre documentaire
          </h2>
          <p class="text-sm text-text-muted mt-1">
            Documents chiffrés côté client (AES-256-GCM). Seuls les membres avec accès "Documents"
            peuvent les télécharger. Le serveur ne voit jamais le contenu en clair.
          </p>
        </div>
        <AssociationDocumentManager associationId={asso.id} />
      </div>
    {/if}

    {#if editSection === 'achats' && canManageProducts && asso}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
              <UsersIcon size={20} />
              Achats et acheteurs
            </h2>
            <p class="text-sm text-text-muted mt-1">
              Historique des paiements boutique et formulaires payants. Attribuez un produit
              manuellement (espèces, paiement antérieur à Canari).
            </p>
          </div>
          <div class="w-full sm:w-64 space-y-1">
            <label for="purchase-filter" class="text-xs font-semibold text-text-muted"
              >Filtrer par produit</label
            >
            <select
              id="purchase-filter"
              bind:value={purchaseFilterProductId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
            >
              <option value="">Tous les achats</option>
              {#each products as product (product.id)}
                <option value={product.id}>{product.name}</option>
              {/each}
            </select>
          </div>
        </div>

        <form
          class="rounded-xl border border-cn-border bg-cn-bg/40 p-4 space-y-4"
          onsubmit={(e) => {
            e.preventDefault();
            void handleGrantProduct();
          }}
        >
          <h3 class="text-sm font-bold text-text-main flex items-center gap-2">
            <Gift size={16} />
            Attribuer un produit
          </h3>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="sm:col-span-2">
              <label for="grant-user" class="text-xs font-semibold text-text-muted block mb-1"
                >Utilisateur</label
              >
              <UserAutocomplete
                value={grantUserId}
                onValueChange={(v) => (grantUserId = v)}
                placeholder="Rechercher un utilisateur…"
                inputId="grant-user"
                onSubmit={handleGrantProduct}
              />
            </div>
            <div>
              <label for="grant-product" class="text-xs font-semibold text-text-muted block mb-1"
                >Produit</label
              >
              <select
                id="grant-product"
                bind:value={grantProductId}
                class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
                required
              >
                <option value="">Choisir…</option>
                {#each products as product (product.id)}
                  <option value={product.id}>{product.name}</option>
                {/each}
              </select>
            </div>
            {#if grantNeedsAmount}
              <div>
                <label for="grant-amount" class="text-xs font-semibold text-text-muted block mb-1"
                  >Montant payé (€)</label
                >
                <input
                  id="grant-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  bind:value={grantAmountEuros}
                  placeholder="0.00"
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2.5 text-sm"
                  required
                />
              </div>
            {/if}
          </div>
          <p class="text-xs text-text-muted">
            {#if grantSelectedProduct?.type === 'membership' && grantSelectedProduct.grantedTagName}
              Le tag <span class="font-mono">{grantSelectedProduct.grantedTagName}</span> sera
              accordé automatiquement.
            {:else if grantSelectedProduct?.type === 'balance_topup'}
              Les recharges Cercle ne sont pas créditées automatiquement — utilisez l’interface
              Cercle si nécessaire.
            {:else}
              L’achat apparaîtra dans l’historique comme un paiement manuel.
            {/if}
          </p>
          <button
            type="submit"
            disabled={grantingProduct || !grantUserId.trim() || !grantProductId}
            class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            {grantingProduct ? 'Attribution…' : 'Attribuer comme acheté'}
          </button>
        </form>

        {#if purchasesError}
          <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
            {purchasesError}
          </div>
        {/if}

        {#if purchasesLoading}
          <div class="flex justify-center py-8">
            <div
              class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {:else if filteredPurchases.length === 0}
          <p class="text-sm text-text-muted text-center py-8">Aucun achat enregistré.</p>
        {:else}
          <div class="overflow-x-auto rounded-xl border border-cn-border/70">
            <table class="w-full text-sm">
              <thead class="bg-cn-bg/60 text-left text-xs font-bold uppercase tracking-wide text-text-muted">
                <tr>
                  <th class="px-4 py-3">Date</th>
                  <th class="px-4 py-3">Acheteur</th>
                  <th class="px-4 py-3">Article</th>
                  <th class="px-4 py-3">Type</th>
                  <th class="px-4 py-3">Paiement</th>
                  <th class="px-4 py-3 text-right">Montant</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-cn-border/50">
                {#each filteredPurchases as purchase (purchase.id)}
                  <tr class="bg-cn-bg/20 hover:bg-cn-bg/40">
                    <td class="px-4 py-3 text-text-muted whitespace-nowrap">
                      {new Date(purchase.paidAt).toLocaleString('fr-FR')}
                    </td>
                    <td class="px-4 py-3 font-medium text-text-main">
                      {purchaseBuyerName(purchase)}
                    </td>
                    <td class="px-4 py-3 text-text-main">{purchase.productName}</td>
                    <td class="px-4 py-3">
                      <span
                        class="rounded-full px-2 py-0.5 text-xs font-semibold {purchase.source ===
                        'product'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-sky-100 text-sky-700'}"
                      >
                        {purchase.source === 'product' ? 'Boutique' : 'Formulaire'}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-text-muted">
                      {paymentMethodLabel(purchase.paymentMethod)}
                    </td>
                    <td class="px-4 py-3 text-right font-semibold tabular-nums">
                      {(purchase.amountCents / 100).toFixed(2)} €
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-text-muted text-right">
            {filteredPurchases.length} achat{filteredPurchases.length > 1 ? 's' : ''}
          </p>
        {/if}
      </div>
    {/if}

    {#if editSection === 'payments' && canManagePaymentsSection && asso && canManageProducts}
      <EditBoutiqueTab
        {asso}
        {stripePaymentsReady}
        stripePending={stripeConnectStatus?.status === 'pending'}
        {canManageStripeConnect}
      />
    {/if}

    {#if editSection === 'formulaires' && canManageForms && asso}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div>
          <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
            <ClipboardList size={20} />
            Formulaires
          </h2>
          <p class="text-sm text-text-muted mt-1">
            Formulaires liés à cette association. Validez les paiements en espèces en attente.
          </p>
        </div>

        {#if hasPaidForms && !stripePaymentsReady}
          <div
            class="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 flex items-start gap-2.5"
          >
            <AlertTriangle size={15} class="shrink-0 mt-0.5" />
            <span>
              {#if canManageStripeConnect}
                Certains formulaires sont payants mais <strong
                  >Stripe Connect n'est pas encore configuré</strong
                >. Les paiements en ligne ne fonctionneront pas tant que vous n'aurez pas
                <button
                  type="button"
                  class="underline font-semibold hover:no-underline"
                  onclick={() => {
                    editSection = 'payments';
                  }}>configuré Stripe dans l'onglet Paiements</button
                >.
              {:else}
                Certains formulaires sont payants mais <strong
                  >Stripe Connect n'est pas configuré</strong
                >. Demandez à un responsable disposant de l'accès <em>Gérer Stripe Connect</em> de l'activer.
              {/if}
            </span>
          </div>
        {/if}

        {#if formsError}
          <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
            {formsError}
          </div>
        {/if}

        {#if formsLoading}
          <div class="flex justify-center py-8">
            <div
              class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {:else if forms.length === 0}
          <p class="text-sm text-text-muted text-center py-8">
            Aucun formulaire lié à cette association.
          </p>
        {:else}
          <ul class="space-y-4">
            {#each forms as form (form.id)}
              <li class="rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-4 space-y-3">
                <div class="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <p class="font-semibold text-sm text-text-main">{form.title}</p>
                    {#if form.description}
                      <p class="text-xs text-text-muted mt-0.5 line-clamp-2">{form.description}</p>
                    {/if}
                    <p class="text-xs text-text-muted mt-1 flex items-center gap-1.5 flex-wrap">
                      {form.basePrice > 0 ? `${(form.basePrice / 100).toFixed(2)} €` : 'Gratuit'}
                      {form.allowCashPayment ? ' · Espèces acceptées' : ''}
                      {#if form.basePrice > 0 && !stripePaymentsReady}
                        <span
                          class="inline-flex items-center gap-1 text-amber-700 font-medium"
                          title="Stripe Connect non configuré - les paiements en ligne sont inactifs"
                        >
                          <AlertTriangle size={11} />
                          Stripe non configuré
                        </span>
                      {/if}
                    </p>
                  </div>
                  <a
                    href="/forms/{form.id}"
                    class="text-xs font-semibold text-cn-yellow hover:underline shrink-0"
                    target="_blank"
                    rel="noopener noreferrer">Voir le formulaire ↗</a
                  >
                </div>

                {#if pendingCash[form.id]?.length}
                  <div class="border-t border-cn-border/50 pt-3 space-y-2">
                    <p class="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle size={13} />
                      {pendingCash[form.id].length} paiement{pendingCash[form.id].length > 1
                        ? 's'
                        : ''} en attente de validation
                    </p>
                    <ul class="space-y-2">
                      {#each pendingCash[form.id] as sub (sub.id)}
                        <li
                          class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2"
                        >
                          <div class="min-w-0 flex-1">
                            <p class="text-xs font-semibold text-text-main truncate">
                              {sub.userId}
                            </p>
                            <p class="text-xs text-text-muted">
                              {(sub.totalPaid / 100).toFixed(2)} € · {new Date(
                                sub.createdAt
                              ).toLocaleDateString('fr-FR')}
                            </p>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onclick={async () => {
                                try {
                                  await validateCashSubmission(form.id, sub.id);
                                  pendingCash = {
                                    ...pendingCash,
                                    [form.id]: pendingCash[form.id].filter((s) => s.id !== sub.id),
                                  };
                                } catch (e) {
                                  formsError = e instanceof Error ? e.message : 'Erreur';
                                }
                              }}
                              class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                              >Valider</button
                            >
                            <button
                              type="button"
                              onclick={async () => {
                                if (
                                  !(await showConfirm('Annuler ce paiement ?', {
                                    danger: true,
                                    confirmLabel: 'Annuler le paiement',
                                    cancelLabel: 'Non',
                                  }))
                                )
                                  return;
                                try {
                                  await cancelCashSubmission(form.id, sub.id);
                                  pendingCash = {
                                    ...pendingCash,
                                    [form.id]: pendingCash[form.id].filter((s) => s.id !== sub.id),
                                  };
                                } catch (e) {
                                  formsError = e instanceof Error ? e.message : 'Erreur';
                                }
                              }}
                              class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                              >Annuler</button
                            >
                          </div>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {:else if form.allowCashPayment}
                  <p class="text-xs text-text-muted border-t border-cn-border/50 pt-3">
                    Aucun paiement en espèces en attente.
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
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
