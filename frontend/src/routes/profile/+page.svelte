<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    fetchMyProfile,
    updateMyProfile,
    setupPaymentMethod,
    listPaymentMethods,
    deletePaymentMethod,
    type UserProfile,
    type PaymentMethod,
  } from '$lib/stores/user';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import {
    CreditCard,
    Trash2,
    Edit3,
    Check,
    Mail,
    GraduationCap,
    CalendarDays,
    Plus,
    Loader2,
    AlertCircle,
    CheckCircle2,
  } from 'lucide-svelte';
  import { slide, fade } from 'svelte/transition';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');

  // Bio state
  let editingBio = $state(false);
  let bioInput = $state('');
  let saving = $state(false);

  // Payment methods state
  let paymentMethods = $state<PaymentMethod[]>([]);
  let paymentLoading = $state(false);
  let paymentSetupLoading = $state(false);
  let paymentError = $state('');
  let paymentSuccess = $state('');

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
    try {
      profile = await fetchMyProfile();
      bioInput = profile.bio || '';
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
  });

  async function loadPaymentMethods() {
    paymentLoading = true;
    try {
      paymentMethods = await listPaymentMethods();
    } catch {
      // Ignore — Stripe may not be configured
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
    if (!confirm('Êtes-vous sûr de vouloir supprimer cette carte bancaire ?')) return;
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
    if (profile?.email) {
      const namePart = profile.email.split('@')[0];
      return namePart.replace('.', ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    }
    return 'Mon Profil';
  });
</script>

<div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6 md:space-y-8">
  {#if loading}
    <div class="flex flex-col items-center justify-center py-32 gap-4 text-text-muted" in:fade>
      <Loader2 size={32} class="animate-spin text-amber-500" strokeWidth={2.5} />
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
      <div
        class="relative w-24 h-24 sm:w-28 sm:h-28 shadow-lg ring-4 ring-white/50 dark:ring-black/20 rounded-full overflow-hidden"
      >
        <Avatar userId={profile.id} fill shape="circle" />
      </div>
      <div class="flex-1 min-w-0">
        <h1 class="text-2xl sm:text-3xl font-extrabold text-text-main tracking-tight truncate mb-1">
          {displayFallbackName}
        </h1>
        {#if profile.formation}
          <div
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-bold uppercase tracking-wider mt-2 shadow-sm"
          >
            <GraduationCap size={14} strokeWidth={2.5} />
            {profile.formation}
          </div>
        {/if}
      </div>
    </div>

    <!-- Section Bio -->
    <div
      class="rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-6 md:p-8 shadow-sm backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-extrabold text-text-main">À propos de moi</h2>
        {#if !editingBio}
          <button
            onclick={startEditBio}
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold text-text-muted hover:text-amber-600 dark:hover:text-amber-400 hover:bg-black/5 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
          >
            <Edit3 size={16} strokeWidth={2.5} /> Modifier
          </button>
        {/if}
      </div>

      {#if editingBio}
        <div transition:slide={{ duration: 200 }} class="space-y-3">
          <textarea
            bind:value={bioInput}
            maxlength="500"
            rows="4"
            class="w-full rounded-[1.25rem] border border-black/10 dark:border-white/10 bg-white/80 dark:bg-black/40 px-4 py-3 text-[0.95rem] text-text-main shadow-inner focus:outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/30 resize-none transition-all placeholder:text-text-muted/60"
            placeholder="Décris-toi en quelques mots (passions, projets, etc.)..."
          ></textarea>
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
                class="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-[#151B2C] hover:bg-amber-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 shadow-md shadow-amber-500/20 disabled:shadow-none outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
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
        <p
          class="text-[0.95rem] text-text-main leading-relaxed whitespace-pre-wrap min-h-[3rem] opacity-90"
          transition:fade={{ duration: 200 }}
        >
          {profile.bio || "Aucune bio pour le moment. N'hésite pas à te présenter !"}
        </p>
      {/if}
    </div>

    <!-- Section Informations -->
    <div
      class="rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-6 md:p-8 shadow-sm backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150"
      style="animation-fill-mode: backwards;"
    >
      <h2 class="text-lg font-extrabold text-text-main mb-6">Informations du compte</h2>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
        >
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            <Mail size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-0.5">
              Adresse Email
            </p>
            <p class="text-sm font-bold text-text-main truncate">
              {profile.email || 'Non renseigné'}
            </p>
          </div>
        </div>

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

    <!-- Section Paiements -->
    <div
      class="rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-6 md:p-8 shadow-sm backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
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
                    class="w-8 h-6 rounded bg-amber-500/20 border border-amber-500/30 flex items-center justify-center opacity-80"
                  >
                    <div class="w-4 h-3 border border-amber-500/40 rounded-sm"></div>
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
  {/if}
</div>
