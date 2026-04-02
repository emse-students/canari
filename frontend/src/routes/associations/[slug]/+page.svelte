<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    updateAssociation,
    deleteAssociation,
    addMember,
    removeMember,
    updateMemberRole,
    startStripeOnboarding,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { Users, Settings, CreditCard, Trash2, UserPlus } from 'lucide-svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isAdmin = $derived(myMembership?.role === 'admin' || myMembership?.role === 'owner');
  let isGlobalAdminUser = $derived(isGlobalAdmin());

  // Edit form state
  let showSettings = $state(false);
  let editName = $state('');
  let editDescription = $state('');
  let saving = $state(false);
  let settingsError = $state('');

  // Add member state
  let newMemberUserId = $state('');
  let newMemberRole = $state('Membre');
  let newMemberPermission = $state<0 | 1>(0);
  let addingMember = $state(false);
  let memberError = $state('');

  // Stripe
  let stripeLoading = $state(false);

  const slug = $derived((page.params as Record<string, string>).slug);

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    try {
      asso = await getAssociationBySlug(slug);
      members = await listMembers(asso.id);
      editName = asso.name;
      editDescription = asso.description ?? '';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Association introuvable';
    } finally {
      loading = false;
    }
  }

  async function handleSaveSettings() {
    if (!asso) return;
    saving = true;
    settingsError = '';
    try {
      asso = await updateAssociation(asso.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim() || undefined,
      });
      showSettings = false;
    } catch (err) {
      settingsError = err instanceof Error ? err.message : 'Erreur lors de la sauvegarde';
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (!asso || !confirm('Supprimer cette association ? Cette action est irréversible.')) return;
    try {
      await deleteAssociation(asso.id);
      await goto('/associations');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur lors de la suppression';
    }
  }

  async function handleAddMember() {
    if (!asso || !newMemberUserId.trim()) return;
    addingMember = true;
    memberError = '';
    try {
      const member = await addMember(
        asso.id,
        newMemberUserId.trim(),
        newMemberRole,
        newMemberPermission
      );
      members = [...members, member];
      newMemberUserId = '';
      newMemberRole = 'Membre';
      newMemberPermission = 0;
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      addingMember = false;
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!asso) return;
    try {
      await removeMember(asso.id, userId);
      members = members.filter((m) => m.userId !== userId);
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    }
  }

  async function handleChangeRole(userId: string, role: string, permission: 0 | 1) {
    if (!asso) return;
    try {
      await updateMemberRole(asso.id, userId, role, permission);
      members = members.map((m) => (m.userId === userId ? { ...m, role, permission } : m));
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    }
  }

  async function handleStripeOnboarding() {
    if (!asso) return;
    stripeLoading = true;
    try {
      const result = await startStripeOnboarding(asso.id, asso.stripeAccountId ?? undefined);
      // Save the Stripe account ID on the association
      if (result.accountId && !asso.stripeAccountId) {
        await updateAssociation(asso.id, {});
      }
      window.location.href = result.url;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur Stripe';
      stripeLoading = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-6">
  <a href="/associations" class="text-sm text-text-muted hover:text-text-main transition-colors">
    ← Retour aux associations
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
    <!-- Header card -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
      <div class="flex items-start gap-4">
        {#if asso.logoUrl}
          <img
            src={asso.logoUrl}
            alt={asso.name}
            class="h-14 w-14 rounded-2xl object-cover flex-shrink-0"
          />
        {:else}
          <div
            class="flex h-14 w-14 items-center justify-center rounded-2xl bg-cn-yellow/20 flex-shrink-0"
          >
            <Users size={24} class="text-cn-dark" />
          </div>
        {/if}
        <div class="flex-1 min-w-0">
          <h1 class="text-xl font-extrabold text-text-main tracking-tight truncate">{asso.name}</h1>
          <p class="text-sm text-text-muted">
            @{asso.slug} · {asso.memberCount ?? members.length} membre{(asso.memberCount ??
              members.length) !== 1
              ? 's'
              : ''}
          </p>
          {#if asso.description}
            <p class="text-sm text-text-muted mt-2 whitespace-pre-wrap">{asso.description}</p>
          {/if}
        </div>
        {#if isAdmin}
          <button
            onclick={() => (showSettings = !showSettings)}
            class="rounded-lg p-2 text-text-muted hover:bg-cn-bg hover:text-text-main transition-colors"
            title="Paramètres"
          >
            <Settings size={18} />
          </button>
        {/if}
      </div>
    </div>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <!-- Settings (admin+) -->
    {#if showSettings && isAdmin}
      <div class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-4">
        <h2 class="text-base font-bold text-text-main">Paramètres</h2>
        <Input label="Nom" bind:value={editName} />
        <Textarea label="Description" bind:value={editDescription} rows={3} />
        {#if settingsError}
          <div class="text-sm text-red-600">{settingsError}</div>
        {/if}
        <div class="flex items-center gap-2">
          <button
            onclick={handleSaveSettings}
            disabled={saving}
            class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
          >
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button
            onclick={() => (showSettings = false)}
            class="rounded-xl px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
          >
            Annuler
          </button>
        </div>

        <!-- Stripe -->
        <div class="border-t border-cn-border pt-4 mt-4">
          <h3 class="text-sm font-bold text-text-main mb-2 flex items-center gap-2">
            <CreditCard size={16} />
            Paiements Stripe
          </h3>
          {#if asso.stripeOnboardingComplete}
            <p class="text-sm text-green-600 font-semibold">✓ Stripe Connect activé</p>
          {:else}
            <p class="text-sm text-text-muted mb-2">
              Connectez un compte Stripe pour recevoir les paiements des formulaires et événements.
            </p>
            <button
              onclick={handleStripeOnboarding}
              disabled={stripeLoading}
              class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
            >
              {stripeLoading
                ? 'Redirection…'
                : asso.stripeAccountId
                  ? 'Continuer la configuration'
                  : 'Configurer Stripe'}
            </button>
          {/if}
        </div>

        <!-- Danger zone (global admin only) -->
        {#if isGlobalAdminUser}
          <div class="border-t border-cn-border pt-4 mt-4">
            <h3 class="text-sm font-bold text-red-600 mb-2 flex items-center gap-2">
              <Trash2 size={16} />
              Zone de danger
            </h3>
            <button
              onclick={handleDelete}
              class="rounded-xl bg-red-50 border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-100 transition-colors"
            >
              Supprimer l'association
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Members -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-4">
      <h2 class="text-base font-bold text-text-main">Membres</h2>

      <!-- Member list -->
      <div class="space-y-2">
        {#each members as member (member.id)}
          <div class="flex items-center justify-between rounded-xl bg-cn-bg/50 px-4 py-2.5">
            <div class="flex items-center gap-3 min-w-0">
              <span class="text-sm font-medium text-text-main truncate"
                >{member.displayName || member.userId}</span
              >
              <span
                class="text-xs font-semibold px-2 py-0.5 rounded-full
                {member.permission === 1
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600'}"
              >
                {member.role}
              </span>
            </div>
            {#if isGlobalAdminUser}
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  value={member.role}
                  onchange={(e) =>
                    handleChangeRole(
                      member.userId,
                      (e.target as HTMLInputElement).value,
                      member.permission as 0 | 1
                    )}
                  class="text-xs rounded-lg border border-cn-border bg-white px-2 py-1 w-28"
                  placeholder="Nom du rôle"
                />
                <select
                  value={member.permission}
                  onchange={(e) =>
                    handleChangeRole(
                      member.userId,
                      member.role,
                      Number((e.target as HTMLSelectElement).value) as 0 | 1
                    )}
                  class="text-xs rounded-lg border border-cn-border bg-white px-2 py-1"
                >
                  <option value={0}>Membre</option>
                  <option value={1}>Admin</option>
                </select>
                <button
                  onclick={() => handleRemoveMember(member.userId)}
                  class="text-red-400 hover:text-red-600 transition-colors"
                  title="Retirer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Add member (global admin only) -->
      {#if isGlobalAdminUser}
        <div class="border-t border-cn-border pt-4">
          <h3 class="text-sm font-bold text-text-main mb-2 flex items-center gap-2">
            <UserPlus size={16} />
            Ajouter un membre
          </h3>
          <form
            class="flex gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              handleAddMember();
            }}
          >
            <div class="flex-1">
              <UserAutocomplete
                value={newMemberUserId}
                onValueChange={(v) => (newMemberUserId = v)}
                placeholder="Rechercher un utilisateur…"
                inputId="add-member-autocomplete"
                onSubmit={handleAddMember}
              />
            </div>
            <input
              type="text"
              bind:value={newMemberRole}
              placeholder="Nom du rôle"
              class="w-28 rounded-xl border border-cn-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cn-yellow/50"
            />
            <select
              bind:value={newMemberPermission}
              class="rounded-xl border border-cn-border bg-white px-3 py-2 text-sm"
            >
              <option value={0}>Membre</option>
              <option value={1}>Admin</option>
            </select>
            <button
              type="submit"
              disabled={addingMember || !newMemberUserId.trim()}
              class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
            >
              {addingMember ? '…' : 'Ajouter'}
            </button>
          </form>
          {#if memberError}
            <p class="text-sm text-red-600 mt-2">{memberError}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
