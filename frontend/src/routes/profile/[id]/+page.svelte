<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fetchUserProfile, type UserProfile, getSavedUserId } from '$lib/stores/user';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { GraduationCap, CalendarDays, Loader2, AlertCircle, MessageCircle } from 'lucide-svelte';
  import { slide, fade } from 'svelte/transition';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    const userId = page.params.id;
    if (!userId) {
      error = 'Identifiant utilisateur manquant';
      loading = false;
      return;
    }

    // Redirect to own profile page if viewing self
    const currentUserId = getSavedUserId();
    if (currentUserId && userId === currentUserId) {
      goto('/profile', { replaceState: true });
      return;
    }

    try {
      profile = await fetchUserProfile(userId);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger ce profil';
    } finally {
      loading = false;
    }
  });

  function formatYear(year: number | null): string {
    if (!year) return 'Non renseignée';
    return `Promotion ${year}`;
  }

  // Utilitaire pour afficher un nom par défaut élégant si displayName est vide
  const displayFallbackName = $derived.by(() => {
    if (profile?.displayName) return profile.displayName;
    if (profile?.email) {
      const namePart = profile.email.split('@')[0];
      return namePart.replace('.', ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    }
    return 'Membre Canari';
  });

  // Action rapide pour démarrer une conversation
  function handleSendMessage() {
    if (profile?.id) {
      sessionStorage.setItem('canari_pending_contact', profile.id);
      goto('/chat');
    }
  }
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
    <!-- En-tête du profil public -->
    <div
      class="flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
    >
      <div class="relative shrink-0 self-start sm:self-auto">
        <Avatar userId={profile.id} size="lg" />
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

      <!-- Call to action (CTA) pour contacter l'utilisateur -->
      <div class="shrink-0 mt-2 sm:mt-0">
        <button
          onclick={handleSendMessage}
          class="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-sm font-bold text-[#151B2C] hover:bg-amber-400 transition-all active:scale-95 shadow-md shadow-amber-500/20 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          <MessageCircle size={18} strokeWidth={2.5} /> Envoyer un message
        </button>
      </div>
    </div>

    <!-- Section Bio -->
    {#if profile.bio}
      <div
        class="rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-6 md:p-8 shadow-sm backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75"
        style="animation-fill-mode: backwards;"
      >
        <h2 class="text-lg font-extrabold text-text-main mb-4">À propos</h2>
        <p class="text-[0.95rem] text-text-main leading-relaxed whitespace-pre-wrap opacity-90">
          {profile.bio}
        </p>
      </div>
    {/if}

    <!-- Section Informations -->
    <div
      class="rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 p-6 md:p-8 shadow-sm backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150"
      style="animation-fill-mode: backwards;"
    >
      <h2 class="text-lg font-extrabold text-text-main mb-6">Informations</h2>

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
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
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
  {/if}
</div>
