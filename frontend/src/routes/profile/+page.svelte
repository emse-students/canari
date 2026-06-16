<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    fetchMyProfile,
    updateMyProfile,
    setupPaymentMethod,
    listPaymentMethods,
    deletePaymentMethod,
    deleteMyAccount,
    type UserProfile,
    type PaymentMethod,
  } from '$lib/stores/user';
  import { clearAuth } from '$lib/stores/auth';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import {
    fetchUserMemberships,
    fetchUserRoleHistory,
    type UserMembershipRow,
    type UserRoleHistoryRow,
  } from '$lib/profile/api';
  import ProfileAssociationsSection from '$lib/components/profile/ProfileAssociationsSection.svelte';
  import ProfileRoleHistorySection from '$lib/components/profile/ProfileRoleHistorySection.svelte';
  import ProfilePreferencesSection from '$lib/components/profile/ProfilePreferencesSection.svelte';
  import {
    CreditCard,
    Trash2,
    Edit3,
    Check,
    GraduationCap,
    CalendarDays,
    Plus,
    Loader2,
    AlertCircle,
    CheckCircle2,
    Camera,
    Tag,
    ShoppingBag,
    ChevronRight,
    Building2,
    Users,
    Shield,
    KeyRound,
    Smartphone,
    Monitor,
    Upload,
    Download,
    ScanLine,
    RefreshCw,
    UserRound,
    History,
    Info,
  } from '@lucide/svelte';

  async function changeProfilePhoto() {
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal('https://gallery.mitv.fr/mes-photos');
  }
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import SyncSessionModal from '$lib/components/chat/SyncSessionModal.svelte';
  import DeviceManagementPanel from '$lib/components/chat/DeviceManagementPanel.svelte';
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import { performPinChange, type PinOperationProgress } from '$lib/utils/chat/pinChange';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { slide, fade } from 'svelte/transition';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import type { UserTag } from '$lib/associations/api';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');
  let isTouchDevice = $state(false);

  // ── Sécurité & appareils + Synchronisation ────────────────────────────────
  const sync = useSyncSession();
  let showDevicePanel = $state(false);
  let showChangePinModal = $state(false);
  let changePinError = $state('');
  let changePinLoading = $state(false);
  let changePinProgress = $state<PinOperationProgress | null>(null);
  let changePinSuccess = $state('');
  let pendingInvitationCount = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();

  function syncCtx() {
    return {
      historyBaseUrl: session.historyBaseUrl,
      userId: session.userId,
      myDeviceId: session.myDeviceId,
      pin: session.pin,
      storage: session.storage,
      log: appendLog,
      loadExistingConversations: async () => {},
      processDeviceInvitationsLocally: async () => {},
    };
  }

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      session.handleImport(
        file,
        appendLog,
        () => convs.conversations.clear(),
        async () => {}
      );
      input.value = '';
    }
  }

  async function handleChangePin(currentPin: string, newPin: string) {
    changePinError = '';
    changePinLoading = true;
    changePinProgress = { percent: 0, stage: 'server' };
    try {
      await performPinChange(
        {
          userId: session.userId,
          mlsService: session.ensureMls(),
          setPin: (p: string) => (session.pin = p),
          log: appendLog,
          onProgress: (progress) => {
            changePinProgress = progress;
          },
        },
        currentPin,
        newPin
      );
      showChangePinModal = false;
      changePinSuccess =
        'PIN modifié. Vos autres appareils devront se reconnecter avec le nouveau PIN.';
    } catch (e) {
      changePinError = e instanceof Error ? e.message : String(e);
    } finally {
      changePinLoading = false;
      changePinProgress = null;
    }
  }

  // Pending-invitation badge for the device panel (polls the current device's memberships).
  $effect(() => {
    if (!session.isLoggedIn || !session.myDeviceId) return;
    const userId = session.userId;
    const deviceId = session.myDeviceId;
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const memberships = await session.ensureMls().getDeviceMemberships(userId, deviceId);
        if (!cancelled) {
          pendingInvitationCount = memberships.filter((m) => m.status === 'pending').length;
        }
      } catch {
        // MLS not ready yet
      }
    }
    const cleanup = createPausableInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      cleanup();
    };
  });

  // Auto-clear the PIN-change success banner.
  $effect(() => {
    if (changePinSuccess) {
      const t = setTimeout(() => (changePinSuccess = ''), 6000);
      return () => clearTimeout(t);
    }
  });

  // Bio state
  let editingBio = $state(false);
  let bioInput = $state('');
  let saving = $state(false);

  // Account deletion state
  let deletionDialogOpen = $state(false);
  let deletionConfirmText = $state('');
  let deleting = $state(false);
  let deletionError = $state('');

  const DELETION_CONFIRM_WORD = 'SUPPRIMER';

  async function handleDeleteAccount() {
    if (deletionConfirmText !== DELETION_CONFIRM_WORD) return;
    deleting = true;
    deletionError = '';
    try {
      await deleteMyAccount();
      await clearAuth();
      await goto('/login', { replaceState: true });
    } catch (err) {
      deletionError = err instanceof Error ? err.message : 'Erreur lors de la suppression';
      deleting = false;
    }
  }

  // Payment methods state
  let paymentMethods = $state<PaymentMethod[]>([]);
  let paymentLoading = $state(false);
  let paymentSetupLoading = $state(false);
  let paymentError = $state('');
  let paymentSuccess = $state('');

  // Cotisations / achats
  let activeTags = $state<UserTag[]>([]);
  let purchasesLoading = $state(false);

  let memberships = $state<UserMembershipRow[]>([]);
  let membershipsLoading = $state(false);
  let roleHistory = $state<UserRoleHistoryRow[]>([]);
  let roleHistoryLoading = $state(false);

  // Auto-clear success message
  $effect(() => {
    if (paymentSuccess) {
      const timer = setTimeout(() => {
        paymentSuccess = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  onMount(async () => {
    isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    try {
      profile = await fetchMyProfile();
      bioInput = profile.bio || '';
      void loadProfileExtras(profile.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Impossible de charger le profil';
      if (msg.toLowerCase().includes('session') || msg.includes('401')) {
        await goto('/login?returnTo=/profile', { replaceState: true });
        return;
      }
      error = msg;
    } finally {
      loading = false;
    }

    // Check for payment setup redirect result
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment_setup') === 'success') {
      paymentSuccess = 'Moyen de paiement enregistré avec succès.';
      history.replaceState(null, '', '/profile');
    }

    loadPaymentMethods();
    void loadPurchasesSummary();
  });

  async function loadProfileExtras(userId: string) {
    membershipsLoading = true;
    roleHistoryLoading = true;
    try {
      memberships = await fetchUserMemberships(userId);
    } catch {
      memberships = [];
    } finally {
      membershipsLoading = false;
    }
    try {
      roleHistory = await fetchUserRoleHistory(userId);
    } catch {
      roleHistory = [];
    } finally {
      roleHistoryLoading = false;
    }
  }

  async function reloadRoleHistory() {
    if (!profile?.id) return;
    roleHistoryLoading = true;
    try {
      roleHistory = await fetchUserRoleHistory(profile.id);
    } finally {
      roleHistoryLoading = false;
    }
  }

  async function loadPurchasesSummary() {
    purchasesLoading = true;
    try {
      const res = await apiFetch(`${socialUrl()}/api/forms/me/purchases`);
      if (!res.ok) return;
      const data = (await res.json()) as { activeTags?: UserTag[] };
      activeTags = data.activeTags ?? [];
    } catch {
      // Non-blocking - section stays empty
    } finally {
      purchasesLoading = false;
    }
  }

  async function loadPaymentMethods() {
    paymentLoading = true;
    try {
      paymentMethods = await listPaymentMethods();
    } catch {
      // Ignore - Stripe may not be configured
    } finally {
      paymentLoading = false;
    }
  }

  async function handleSetupPayment() {
    paymentSetupLoading = true;
    paymentError = '';
    try {
      const { profileSetupCallbacks } = await import('$lib/utils/stripeCallbacks');
      const result = await setupPaymentMethod(profileSetupCallbacks());
      if (result.url) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(result.url);
      }
    } catch (err) {
      paymentError =
        err instanceof Error ? err.message : 'Erreur de connexion au service de paiement';
      paymentSetupLoading = false;
    }
  }

  async function handleDeletePaymentMethod(id: string) {
    if (
      !(await showConfirm('Supprimer cette carte bancaire ?', {
        danger: true,
        confirmLabel: 'Supprimer',
      }))
    )
      return;
    try {
      await deletePaymentMethod(id);
      paymentMethods = paymentMethods.filter((m) => m.id !== id);
    } catch (err) {
      paymentError = err instanceof Error ? err.message : 'Erreur lors de la suppression';
    }
  }

  function brandLabel(brand: string): string {
    const labels: Record<string, string> = {
      visa: 'Visa',
      mastercard: 'Mastercard',
      amex: 'American Express',
    };
    return labels[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
  }

  async function saveBio() {
    saving = true;
    try {
      profile = await updateMyProfile({ bio: bioInput.trim() });
      editingBio = false;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur lors de la sauvegarde';
    } finally {
      saving = false;
    }
  }

  function startEditBio() {
    bioInput = profile?.bio || '';
    editingBio = true;
  }

  function cancelEditBio() {
    editingBio = false;
    bioInput = profile?.bio || '';
  }

  function formatYear(year: number | null): string {
    if (!year) return 'Non renseignée';
    return `Promotion ${year}`;
  }

  // Utilitaire pour afficher un nom par défaut si displayName est vide
  const displayFallbackName = $derived.by(() => {
    if (profile?.displayName) return profile.displayName;
    return 'Mon Profil';
  });
</script>

<div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6 md:space-y-8">
  {#if loading}
    <div class="flex flex-col items-center justify-center py-32 gap-4 text-text-muted" in:fade>
      <Loader2 size={32} class="animate-spin text-cn-yellow" strokeWidth={2.5} />
      <span class="text-sm font-bold tracking-wider uppercase">Chargement du profil...</span>
    </div>
  {:else if error}
    <div
      class="rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 p-5 flex items-start gap-3 shadow-sm backdrop-blur-md"
      in:slide
    >
      <AlertCircle size={20} class="shrink-0 mt-0.5" />
      <div>
        <h3 class="font-bold text-sm mb-1">Erreur</h3>
        <p class="text-sm font-medium">{error}</p>
      </div>
    </div>
  {:else if profile}
    <!-- En-tête du profil -->
    <div
      class="flex items-center gap-5 sm:gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
    >
      <div class="relative w-24 h-24 sm:w-28 sm:h-28 flex-shrink-0">
        <div
          class="w-full h-full shadow-lg ring-4 ring-white/50 dark:ring-black/20 rounded-full overflow-hidden"
        >
          <Avatar userId={profile.id} fill shape="circle" />
        </div>
        <button
          type="button"
          onclick={changeProfilePhoto}
          title="Changer la photo de profil"
          aria-label="Changer la photo de profil"
          class="absolute bottom-0 right-0 flex items-center justify-center w-8 h-8 rounded-full
                 bg-cn-yellow hover:bg-cn-yellow-hover text-cn-ink
                 shadow-md shadow-cn-yellow/30 ring-2 ring-white dark:ring-[var(--cn-bg)]
                 transition-all active:scale-95"
        >
          <Camera size={15} strokeWidth={2.5} />
        </button>
      </div>
      <div class="flex-1 min-w-0">
        <h1 class="text-2xl sm:text-3xl font-extrabold text-text-main tracking-tight truncate mb-1">
          {displayFallbackName}
        </h1>
        {#if profile.formation}
          <div
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cn-yellow/10 border border-cn-yellow/20 text-cn-dark text-xs font-bold uppercase tracking-wider mt-2 shadow-sm"
          >
            <GraduationCap size={14} strokeWidth={2.5} />
            {profile.formation}
          </div>
        {/if}
      </div>
    </div>

    <!-- Section Bio -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <UserRound size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">À propos de moi</h2>
        </div>
        {#if !editingBio}
          <button
            onclick={startEditBio}
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold text-text-muted hover:text-cn-dark hover:bg-black/5 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-95"
          >
            <Edit3 size={16} strokeWidth={2.5} /> Modifier
          </button>
        {/if}
      </div>

      {#if editingBio}
        <div transition:slide={{ duration: 200 }} class="space-y-3">
          <MarkdownComposerField
            bind:value={bioInput}
            maxlength={500}
            minHeight="100px"
            class="w-full min-w-0 rounded-[1.25rem] border border-black/10 dark:border-white/10 bg-white/80 dark:bg-black/40 shadow-inner focus-within:border-cn-yellow/50 focus-within:ring-2 focus-within:ring-cn-yellow/30 transition-all overflow-hidden"
            editorClass="min-h-[100px] w-full max-w-full px-4 py-3 text-[0.95rem] text-text-main leading-relaxed"
            placeholder="Décris-toi en quelques mots…"
          />
          <div class="flex items-center justify-between">
            <span
              class="text-xs font-semibold text-text-muted pl-1 {bioInput.length >= 490
                ? 'text-orange-500'
                : ''}"
            >
              {bioInput.length} / 500
            </span>
            <div class="flex gap-2">
              <button
                onclick={cancelEditBio}
                class="rounded-xl px-4 py-2 text-sm font-bold text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
              >
                Annuler
              </button>
              <button
                onclick={saveBio}
                disabled={saving || bioInput.trim() === profile.bio}
                class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 shadow-md shadow-cn-yellow/20 disabled:shadow-none outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow/50"
              >
                {#if saving}
                  <Loader2 size={16} class="animate-spin" strokeWidth={3} /> Enregistrement...
                {:else}
                  <Check size={16} strokeWidth={3} /> Enregistrer
                {/if}
              </button>
            </div>
          </div>
        </div>
      {:else}
        <div transition:fade={{ duration: 200 }} class="min-h-[3rem]">
          {#if profile.bio?.trim()}
            <ProfileBioMarkdown source={profile.bio} />
          {:else}
            <p class="text-[0.95rem] text-text-main leading-relaxed opacity-90">
              Aucune bio pour le moment. N'hésite pas à te présenter !
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Section Associations -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <Building2 size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">Mes associations</h2>
        </div>
        <a
          href="/directory"
          class="inline-flex items-center gap-1 text-xs font-bold text-cn-dark hover:underline"
        >
          <Users size={14} />
          Annuaire
        </a>
      </div>
      <ProfileAssociationsSection {memberships} loading={membershipsLoading} />
    </div>

    <!-- Section Parcours associatif -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-125"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-5">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <History size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">Parcours associatif</h2>
        {#if roleHistoryLoading}
          <Loader2 size={16} class="animate-spin text-cn-yellow" />
        {/if}
      </div>
      <ProfileRoleHistorySection
        entries={roleHistory}
        editable={true}
        onChanged={reloadRoleHistory}
      />
    </div>

    <!-- Section Informations -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-6">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <Info size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">Informations du compte</h2>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
        >
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            <GraduationCap size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-0.5">
              Promotion
            </p>
            <p class="text-sm font-bold text-text-main truncate">{formatYear(profile.promo)}</p>
          </div>
        </div>

        <div
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm md:col-span-2"
        >
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            <CalendarDays size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-0.5">
              Membre depuis le
            </p>
            <p class="text-sm font-bold text-text-main capitalize">
              {new Date(profile.createdAt).toLocaleDateString('fr-FR', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section Préférences -->
    <ProfilePreferencesSection {isTouchDevice} />

    <!-- Section Sécurité & appareils -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-6">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <Shield size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">Sécurité &amp; appareils</h2>
      </div>

      {#if changePinSuccess}
        <div
          transition:slide={{ duration: 200 }}
          class="flex items-center gap-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 p-4 text-sm font-bold mb-5 shadow-inner"
        >
          <CheckCircle2 size={20} class="shrink-0" />
          {changePinSuccess}
        </div>
      {/if}

      {#if session.isLoggedIn}
        <div class="space-y-4">
          <div
            class="flex items-center justify-between gap-4 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
          >
            <div class="flex items-center gap-3.5 min-w-0">
              <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted shrink-0">
                <KeyRound size={20} strokeWidth={2.5} />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-bold text-text-main">Code PIN de chiffrement</p>
                <p class="text-xs font-medium text-text-muted mt-0.5">
                  Modifiez le PIN qui protège vos messages chiffrés de bout en bout
                </p>
              </div>
            </div>
            <button
              onclick={() => {
                changePinError = '';
                showChangePinModal = true;
              }}
              class="shrink-0 inline-flex items-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
            >
              <KeyRound size={16} strokeWidth={2.5} />
              <span class="hidden sm:inline">Changer</span>
            </button>
          </div>

          <div
            class="flex items-center justify-between gap-4 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
          >
            <div class="flex items-center gap-3.5 min-w-0">
              <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted shrink-0">
                <Monitor size={20} strokeWidth={2.5} />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-bold text-text-main">Appareils connectés</p>
                <p class="text-xs font-medium text-text-muted mt-0.5">
                  Renommez ou révoquez les appareils liés à votre compte
                </p>
              </div>
            </div>
            <button
              onclick={() => (showDevicePanel = true)}
              class="relative shrink-0 inline-flex items-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
            >
              <Monitor size={16} strokeWidth={2.5} />
              <span class="hidden sm:inline">Gérer</span>
              {#if pendingInvitationCount > 0}
                <span
                  class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center px-1 shadow"
                >
                  {pendingInvitationCount > 99 ? '99+' : pendingInvitationCount}
                </span>
              {/if}
            </button>
          </div>
        </div>
      {:else}
        <p class="text-sm text-text-muted leading-relaxed">
          Déverrouillez la messagerie (saisie de votre PIN) pour gérer votre sécurité et vos
          appareils.
        </p>
      {/if}
    </div>

    <!-- Section Sauvegarde & synchronisation -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-2">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <RefreshCw size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">Sauvegarde &amp; synchronisation</h2>
      </div>
      <p class="text-xs font-medium text-text-muted mb-6 sm:pl-[3.75rem] leading-relaxed">
        Transférez vos conversations vers un autre appareil (QR) ou sauvegardez-les dans un fichier
        chiffré <code class="font-mono">.canari</code>.
      </p>

      {#if session.isLoggedIn}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <button
            type="button"
            onclick={() => sync.handleStartSyncSession(syncCtx())}
            disabled={sync.isSyncSessionBusy}
            class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
            title="Démarrer une synchronisation QR"
          >
            <ScanLine size={22} class="text-text-muted" />
            <span class="text-sm font-bold text-text-main">Transférer</span>
            <span class="text-[0.7rem] text-text-muted">Afficher le QR</span>
          </button>

          <button
            type="button"
            onclick={() => sync.openJoinSyncModal()}
            disabled={sync.isSyncSessionBusy}
            class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
            title="Rejoindre une synchronisation QR"
          >
            <Smartphone size={22} class="text-text-muted" />
            <span class="text-sm font-bold text-text-main">Scanner</span>
            <span class="text-[0.7rem] text-text-muted">Scanner un QR</span>
          </button>

          <button
            type="button"
            onclick={triggerImport}
            disabled={session.isImporting}
            class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
            title="Importer une sauvegarde (.canari)"
          >
            <Upload size={22} class="text-text-muted" />
            <span class="text-sm font-bold text-text-main">Importer</span>
            <span class="text-[0.7rem] text-text-muted">Restaurer</span>
          </button>

          <button
            type="button"
            onclick={() => session.handleExport(appendLog)}
            disabled={session.isExporting}
            class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
            title="Exporter les conversations"
          >
            <Download size={22} class="text-text-muted" />
            <span class="text-sm font-bold text-text-main">Exporter</span>
            <span class="text-[0.7rem] text-text-muted">Sauvegarder</span>
          </button>
        </div>
      {:else}
        <p class="text-sm text-text-muted leading-relaxed">
          Déverrouillez la messagerie pour synchroniser ou sauvegarder vos conversations.
        </p>
      {/if}
    </div>

    <!-- Section Paiements -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <CreditCard size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">Moyens de paiement</h2>
        </div>

        <button
          onclick={handleSetupPayment}
          disabled={paymentSetupLoading}
          class="hidden sm:inline-flex items-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all disabled:opacity-50 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
        >
          {#if paymentSetupLoading}
            <Loader2 size={16} class="animate-spin" /> Redirection...
          {:else}
            <Plus size={18} strokeWidth={2.5} /> Ajouter une carte
          {/if}
        </button>
      </div>

      {#if paymentSuccess}
        <div
          transition:slide={{ duration: 200 }}
          class="flex items-center gap-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 p-4 text-sm font-bold mb-6 shadow-inner"
        >
          <CheckCircle2 size={20} class="shrink-0" />
          {paymentSuccess}
        </div>
      {/if}

      {#if paymentError}
        <div
          transition:slide={{ duration: 200 }}
          class="flex items-center gap-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 p-4 text-sm font-bold mb-6 shadow-inner"
        >
          <AlertCircle size={20} class="shrink-0" />
          {paymentError}
        </div>
      {/if}

      {#if paymentLoading}
        <div class="flex items-center gap-3 text-sm font-semibold text-text-muted py-4">
          <Loader2 size={18} class="animate-spin" /> Chargement sécurisé des cartes...
        </div>
      {:else}
        {#if paymentMethods.length > 0}
          <div class="space-y-3 mb-6">
            {#each paymentMethods as pm (pm.id)}
              <!-- Carte bancaire stylisée -->
              <div
                transition:slide={{ duration: 200 }}
                class="flex items-center justify-between rounded-[1.25rem] bg-gradient-to-r from-black/5 to-transparent dark:from-white/5 dark:to-transparent border border-black/5 dark:border-white/5 px-5 py-4 group hover:border-black/10 dark:hover:border-white/10 transition-colors shadow-sm"
              >
                <div class="flex items-center gap-4">
                  <!-- Petite puce visuelle -->
                  <div
                    class="w-8 h-6 rounded bg-cn-yellow/20 border border-cn-yellow/30 flex items-center justify-center opacity-80"
                  >
                    <div class="w-4 h-3 border border-cn-yellow/40 rounded-sm"></div>
                  </div>

                  <div class="flex flex-col">
                    <span class="text-[0.95rem] font-bold text-text-main tracking-wider font-mono">
                      •••• •••• •••• {pm.last4}
                    </span>
                    <span
                      class="text-[0.65rem] font-extrabold text-text-muted uppercase tracking-wider mt-0.5"
                    >
                      {brandLabel(pm.brand)} • Exp: {String(pm.expMonth).padStart(
                        2,
                        '0'
                      )}/{pm.expYear}
                    </span>
                  </div>
                </div>

                <button
                  onclick={() => handleDeletePaymentMethod(pm.id)}
                  class="p-2.5 rounded-xl text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95"
                  title="Supprimer cette carte"
                  aria-label="Supprimer"
                >
                  <Trash2 size={18} strokeWidth={2.5} />
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div
            class="text-center py-6 px-4 border border-dashed border-black/10 dark:border-white/10 rounded-[1.25rem] bg-black/5 dark:bg-white/5 mb-6"
          >
            <p class="text-sm font-semibold text-text-muted">Aucun moyen de paiement enregistré.</p>
            <p class="text-[0.7rem] font-medium text-text-muted/70 mt-1 max-w-sm mx-auto">
              Ajoutez une carte bancaire pour pouvoir participer aux événements payants de
              l'association.
            </p>
          </div>
        {/if}

        <!-- Bouton mobile (car le bouton du header peut être masqué sur petit écran) -->
        <button
          onclick={handleSetupPayment}
          disabled={paymentSetupLoading}
          class="sm:hidden w-full flex items-center justify-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-3.5 text-sm font-bold text-text-main active:scale-[0.98] transition-all disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
        >
          {#if paymentSetupLoading}
            <Loader2 size={18} class="animate-spin" /> Redirection vers Stripe...
          {:else}
            <Plus size={18} strokeWidth={2.5} /> Ajouter une carte bancaire
          {/if}
        </button>
      {/if}
    </div>

    <!-- Section Cotisations et achats -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-250"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Tag size={22} strokeWidth={2.5} />
          </div>
          <div>
            <h2 class="text-lg font-extrabold text-text-main">Cotisations et achats</h2>
            <p class="text-xs font-medium text-text-muted mt-0.5">
              Statuts actifs et historique de paiements
            </p>
          </div>
        </div>
        <a
          href="/account/purchases"
          class="hidden sm:inline-flex items-center gap-1.5 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all"
        >
          <ShoppingBag size={16} />
          Voir tout
          <ChevronRight size={16} />
        </a>
      </div>

      {#if purchasesLoading}
        <div class="flex items-center gap-3 text-sm font-semibold text-text-muted py-2">
          <Loader2 size={18} class="animate-spin" />
          Chargement…
        </div>
      {:else if activeTags.length === 0}
        <p class="text-sm text-text-muted mb-4">Aucune cotisation active pour le moment.</p>
      {:else}
        <ul class="space-y-2 mb-4">
          {#each activeTags as tag (tag.id)}
            <li
              class="flex items-center gap-3 rounded-xl border border-cn-border bg-white/50 dark:bg-white/5 px-4 py-3"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-text-main">{tag.tagName}</p>
                <p class="text-xs text-text-muted mt-0.5">
                  {#if tag.expiresAt}
                    Expire le {new Date(tag.expiresAt).toLocaleDateString('fr-FR')}
                  {:else}
                    Sans expiration
                  {/if}
                </p>
              </div>
              <span
                class="shrink-0 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2.5 py-0.5 text-xs font-bold"
              >
                Actif
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <a
        href="/account/purchases"
        class="sm:hidden w-full flex items-center justify-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-3.5 text-sm font-bold text-text-main active:scale-[0.98] transition-all"
      >
        <ShoppingBag size={18} />
        Mes achats et cotisations
        <ChevronRight size={16} />
      </a>
    </div>

    <!-- Section Suppression de compte -->
    <div
      class="rounded-2xl border border-red-500/20 bg-red-500/5 p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-start gap-4">
        <div class="p-2.5 rounded-xl bg-red-500/10 text-red-500 shrink-0 mt-0.5">
          <Trash2 size={22} strokeWidth={2.5} />
        </div>
        <div class="flex-1 min-w-0">
          <h2 class="text-lg font-extrabold text-red-500 mb-1">Supprimer mon compte</h2>
          <p class="text-sm text-text-muted mb-4 leading-relaxed">
            Cette action est <strong>irréversible</strong>. Votre profil, vos messages, vos
            publications, vos adhésions et toutes vos données seront définitivement supprimés.
          </p>
          {#if !deletionDialogOpen}
            <button
              onclick={() => {
                deletionDialogOpen = true;
                deletionConfirmText = '';
                deletionError = '';
              }}
              class="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-500 hover:bg-red-500/20 transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <Trash2 size={16} strokeWidth={2.5} />
              Supprimer mon compte
            </button>
          {:else}
            <div transition:slide={{ duration: 200 }} class="space-y-4">
              <p class="text-sm font-semibold text-red-400">
                Tapez <code class="font-mono bg-red-500/10 px-1.5 py-0.5 rounded-md"
                  >{DELETION_CONFIRM_WORD}</code
                > pour confirmer :
              </p>
              <input
                type="text"
                bind:value={deletionConfirmText}
                placeholder={DELETION_CONFIRM_WORD}
                disabled={deleting}
                class="w-full max-w-xs rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm font-mono font-bold text-red-400 placeholder-red-500/30 outline-none focus:border-red-500/60 focus:ring-2 focus:ring-red-500/20 disabled:opacity-50 transition-all"
              />
              {#if deletionError}
                <p
                  transition:slide={{ duration: 150 }}
                  class="text-sm font-semibold text-red-500 flex items-center gap-2"
                >
                  <AlertCircle size={16} />
                  {deletionError}
                </p>
              {/if}
              <div class="flex gap-3">
                <button
                  onclick={() => {
                    deletionDialogOpen = false;
                    deletionConfirmText = '';
                  }}
                  disabled={deleting}
                  class="rounded-xl px-4 py-2.5 text-sm font-bold text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
                >
                  Annuler
                </button>
                <button
                  onclick={handleDeleteAccount}
                  disabled={deleting || deletionConfirmText !== DELETION_CONFIRM_WORD}
                  class="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 shadow-md shadow-red-500/20 disabled:shadow-none outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                >
                  {#if deleting}
                    <Loader2 size={16} class="animate-spin" /> Suppression en cours...
                  {:else}
                    <Trash2 size={16} strokeWidth={2.5} /> Supprimer définitivement
                  {/if}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Identifiant d'appareil (diagnostic discret, utile pour tracer les reboots MLS) -->
    {#if session.myDeviceId}
      <p class="text-center text-[0.65rem] font-mono text-text-muted/40 select-all pt-2">
        device: {session.myDeviceId}
      </p>
    {/if}
  {/if}
</div>

<!-- Outillage sécurité / synchronisation (hors du flux conditionnel pour rester monté) -->
<input
  bind:this={fileInput}
  type="file"
  accept=".canari"
  class="hidden"
  onchange={handleFileChange}
/>

<ChangePinModal
  open={showChangePinModal}
  onSubmit={handleChangePin}
  onClose={() => (showChangePinModal = false)}
  externalError={changePinError}
  isLoading={changePinLoading}
  loadingProgress={changePinProgress}
/>

<SyncSessionModal
  isOpen={sync.isSyncSessionOpen}
  mode={sync.syncMode}
  qrPayload={sync.syncQrPayloadText}
  qrDataUrl={sync.syncQrDataUrl}
  joinPayload={sync.syncJoinPayload}
  statusText={sync.syncStatusText}
  isBusy={sync.isSyncSessionBusy}
  onJoinPayloadChange={(value: string) => (sync.syncJoinPayload = value)}
  onConfirmJoin={() => sync.handleConfirmJoinSync(syncCtx())}
  onCopyPayload={sync.copySyncPayload}
  onClose={sync.closeModal}
/>

{#if session.isLoggedIn}
  <DeviceManagementPanel
    open={showDevicePanel}
    userId={session.userId}
    myDeviceId={session.myDeviceId}
    mlsService={session.ensureMls()}
    onClose={() => (showDevicePanel = false)}
  />
{/if}
