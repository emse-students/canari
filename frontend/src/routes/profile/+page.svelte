<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchMyProfile, updateMyProfile, type UserProfile } from '$lib/stores/user';
  import Avatar from '$lib/components/shared/Avatar.svelte';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');
  let editingBio = $state(false);
  let bioInput = $state('');
  let saving = $state(false);

  onMount(async () => {
    try {
      profile = await fetchMyProfile();
      bioInput = profile.bio || '';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger le profil';
    } finally {
      loading = false;
    }
  });

  async function saveBio() {
    saving = true;
    try {
      profile = await updateMyProfile({ bio: bioInput });
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
          {#if profile.email}
            <p class="text-sm text-text-muted truncate">{profile.email}</p>
          {/if}
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
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-base font-bold text-text-main">Bio</h2>
        {#if !editingBio}
          <button
            onclick={startEditBio}
            class="text-sm text-cn-dark font-semibold hover:text-cn-yellow transition-colors"
          >
            Modifier
          </button>
        {/if}
      </div>
      {#if editingBio}
        <textarea
          bind:value={bioInput}
          maxlength="500"
          rows="3"
          class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/50 resize-none"
          placeholder="Décris-toi en quelques mots…"
        ></textarea>
        <div class="flex items-center justify-between mt-2">
          <span class="text-xs text-text-muted">{bioInput.length}/500</span>
          <div class="flex gap-2">
            <button
              onclick={cancelEditBio}
              class="rounded-xl px-4 py-1.5 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
            >
              Annuler
            </button>
            <button
              onclick={saveBio}
              disabled={saving}
              class="rounded-xl bg-cn-yellow px-4 py-1.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      {:else}
        <p class="text-sm text-text-muted whitespace-pre-wrap">
          {profile.bio || 'Aucune bio pour le moment.'}
        </p>
      {/if}
    </div>

    <!-- Info -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
      <h2 class="text-base font-bold text-text-main mb-3">Informations</h2>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between">
          <dt class="text-text-muted">Identifiant</dt>
          <dd class="text-text-main font-medium">{profile.id}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-muted">Email</dt>
          <dd class="text-text-main font-medium">{profile.email || 'Non renseigné'}</dd>
        </div>
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
