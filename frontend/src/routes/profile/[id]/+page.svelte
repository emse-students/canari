<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fetchUserProfile, type UserProfile, getSavedUserId } from '$lib/stores/user';
  import Avatar from '$lib/components/shared/Avatar.svelte';

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
      error = err instanceof Error ? err.message : 'Impossible de charger le profil';
    } finally {
      loading = false;
    }
  });

  function formatYear(year: number | null): string {
    if (!year) return 'Non renseigné';
    return `Promotion ${year}`;
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-2xl mx-auto space-y-6">
  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">
      {error}
    </div>
  {:else if profile}
    <!-- Header -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
      <div class="flex items-start gap-4">
        <Avatar userId={profile.id} size="lg" />
        <div class="flex-1 min-w-0">
          <h1 class="text-xl font-extrabold text-text-main tracking-tight truncate">
            {profile.displayName || profile.id}
          </h1>
          <p class="text-sm text-text-muted mt-0.5">
            {formatYear(profile.promo)}
          </p>
          {#if profile.formation}
            <p class="text-sm text-text-muted mt-0.5">
              {profile.formation}
            </p>
          {/if}
        </div>
      </div>
    </div>

    <!-- Bio -->
    {#if profile.bio}
      <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
        <h2 class="text-base font-bold text-text-main mb-2">Bio</h2>
        <p class="text-sm text-text-muted whitespace-pre-wrap">
          {profile.bio}
        </p>
      </div>
    {/if}

    <!-- Info -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
      <h2 class="text-base font-bold text-text-main mb-3">Informations</h2>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between">
          <dt class="text-text-muted">Promotion</dt>
          <dd class="text-text-main font-medium">{formatYear(profile.promo)}</dd>
        </div>
        {#if profile.formation}
          <div class="flex justify-between">
            <dt class="text-text-muted">Formation</dt>
            <dd class="text-text-main font-medium">{profile.formation}</dd>
          </div>
        {/if}
        <div class="flex justify-between">
          <dt class="text-text-muted">Membre depuis</dt>
          <dd class="text-text-main font-medium">
            {new Date(profile.createdAt).toLocaleDateString('fr-FR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </dd>
        </div>
      </dl>
    </div>
  {/if}
</div>
