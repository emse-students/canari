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
    uploadAssociationLogo,
    deleteAssociationLogo,
    associationLogoSrc,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { Users, CreditCard, Trash2, UserPlus, ArrowLeft } from 'lucide-svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import AssociationLogoCropper from '$lib/components/associations/AssociationLogoCropper.svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isAdmin = $derived(
    !!myMembership &&
      (myMembership.permission === 1 ||
        myMembership.role === 'admin' ||
        myMembership.role === 'owner')
  );
  let isGlobalAdminUser = $derived(isGlobalAdmin());

  let editName = $state('');
  let editDescription = $state('');
  let editBioMarkdown = $state('');
  let saving = $state(false);
  let settingsError = $state('');

  let newMemberUserId = $state('');
  let newMemberRole = $state('Membre');
  let newMemberPermission = $state<0 | 1>(0);
  let addingMember = $state(false);
  let memberError = $state('');

  let stripeLoading = $state(false);
  let logoBusy = $state(false);
  let showCropper = $state(false);

  const slug = $derived((page.params as Record<string, string>).slug);

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    try {
      const a = await getAssociationBySlug(slug);
      asso = a;
      members = await listMembers(a.id);
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = m.displayName?.trim() || getUserDisplayNameSync(m.userId, m.userId);
      }
      resolvedMemberNames = names;
      for (const m of members) {
        if (!m.displayName?.trim()) {
          resolveUserDisplayName(m.userId).then((resolved) => {
            if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
          });
        }
      }
      editName = a.name;
      editDescription = a.description ?? '';
      editBioMarkdown = a.bioMarkdown ?? '';

      const uid = currentUserId();
      const mine = members.find((m) => m.userId === uid);
      const canEdit =
        isGlobalAdmin() ||
        (!!mine &&
          (mine.permission === 1 || mine.role === 'admin' || mine.role === 'owner'));
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

  async function handleSaveProfile() {
    if (!asso) return;
    saving = true;
    settingsError = '';
    try {
      asso = await updateAssociation(asso.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim() || undefined,
        bioMarkdown: editBioMarkdown.trim() || undefined,
      });
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

  async function handleRemoveMember(targetId: string) {
    if (!asso) return;
    try {
      await removeMember(asso.id, targetId);
      members = members.filter((m) => m.userId !== targetId);
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    }
  }

  async function handleChangeRole(targetId: string, role: string, permission: 0 | 1) {
    if (!asso) return;
    try {
      await updateMemberRole(asso.id, targetId, role, permission);
      members = members.map((m) => (m.userId === targetId ? { ...m, role, permission } : m));
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    }
  }

  async function handleStripeOnboarding() {
    if (!asso) return;
    stripeLoading = true;
    const origin =
      typeof window !== 'undefined' ? window.location.origin : '';
    const base = `${origin}/associations/${encodeURIComponent(asso.slug)}/edit`;
    try {
      const result = await startStripeOnboarding(asso.id, asso.stripeAccountId ?? undefined, {
        returnUrl: base,
        refreshUrl: base,
      });
      if (result.accountId) {
        asso = { ...asso, stripeAccountId: result.accountId };
      }
      window.location.href = result.url;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur Stripe';
      stripeLoading = false;
    }
  }

  async function onLogoExported(blob: Blob) {
    if (!asso) return;
    logoBusy = true;
    memberError = '';
    try {
      const file = new File([blob], 'logo.jpg', { type: 'image/jpeg' });
      asso = await uploadAssociationLogo(asso.id, file);
      showCropper = false;
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Envoi du logo échoué';
    } finally {
      logoBusy = false;
    }
  }

  async function handleRemoveLogo() {
    if (!asso || !confirm('Retirer le logo affiché sur le fil et la page publique ?')) return;
    logoBusy = true;
    try {
      asso = await deleteAssociationLogo(asso.id);
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      logoBusy = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-6">
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
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Modifier l’association</h1>
    <p class="text-sm text-text-muted">@{asso.slug}</p>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <!-- Profil + logo -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-4">
      <h2 class="text-base font-bold text-text-main">Profil et logo</h2>
      <div class="flex flex-wrap items-start gap-4">
        {#if associationLogoSrc(asso.logoUrl)}
          <img
            src={associationLogoSrc(asso.logoUrl)}
            alt=""
            class="h-20 w-20 rounded-2xl object-cover border border-cn-border shrink-0"
          />
        {:else}
          <div
            class="flex h-20 w-20 items-center justify-center rounded-2xl bg-cn-yellow/20 shrink-0"
          >
            <Users size={28} class="text-cn-dark" />
          </div>
        {/if}
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            onclick={() => (showCropper = !showCropper)}
            disabled={logoBusy}
            class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg disabled:opacity-50"
          >
            {showCropper ? 'Fermer le recadrage' : 'Changer le logo'}
          </button>
          {#if asso.logoUrl}
            <button
              type="button"
              onclick={handleRemoveLogo}
              disabled={logoBusy}
              class="rounded-xl px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Retirer le logo
            </button>
          {/if}
        </div>
      </div>

      {#if showCropper}
        <AssociationLogoCropper onExport={onLogoExported} onCancel={() => (showCropper = false)} />
      {/if}

      <Input label="Nom" bind:value={editName} />
      <Textarea
        label="Description courte (texte brut, sous le titre)"
        bind:value={editDescription}
        rows={2}
      />
      <Textarea label="Bio (markdown)" bind:value={editBioMarkdown} rows={10} />
      <div class="rounded-xl border border-cn-border/70 bg-cn-bg/40 p-3 text-xs text-text-muted">
        <p class="font-semibold text-text-main mb-1">Aperçu markdown</p>
        {#if editBioMarkdown.trim()}
          <div class="prose prose-sm dark:prose-invert max-w-none">
            <SvelteMarkdown source={editBioMarkdown} options={{ gfm: true, breaks: true }} />
          </div>
        {:else}
          <p>(vide)</p>
        {/if}
      </div>
      {#if settingsError}
        <div class="text-sm text-red-600">{settingsError}</div>
      {/if}
      <button
        type="button"
        onclick={handleSaveProfile}
        disabled={saving}
        class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
      >
        {saving ? 'Enregistrement…' : 'Enregistrer le profil'}
      </button>
    </div>

    <!-- Stripe -->
    {#if isAdmin || isGlobalAdminUser}
      <div class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-3">
        <h2 class="text-base font-bold text-text-main flex items-center gap-2">
          <CreditCard size={18} />
          Paiements Stripe
        </h2>
        {#if asso.stripeOnboardingComplete}
          <p class="text-sm text-green-600 font-semibold">Stripe Connect activé</p>
        {:else}
          <p class="text-sm text-text-muted">
            Connectez un compte Stripe pour les paiements des formulaires et événements associés à
            cette association.
          </p>
          <button
            type="button"
            onclick={handleStripeOnboarding}
            disabled={stripeLoading}
            class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {stripeLoading
              ? 'Redirection…'
              : asso.stripeAccountId
                ? 'Continuer la configuration'
                : 'Configurer Stripe'}
          </button>
        {/if}
      </div>
    {/if}

    <!-- Membres -->
    {#if isAdmin || isGlobalAdminUser}
      <div class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-4">
        <h2 class="text-base font-bold text-text-main">Membres</h2>
        <div class="space-y-2">
          {#each members as member (member.id)}
            <div class="flex items-center justify-between rounded-xl bg-cn-bg/50 px-4 py-2.5 gap-2">
              <div class="flex items-center gap-3 min-w-0">
                <a
                  href="/profile/{encodeURIComponent(member.userId)}"
                  class="text-sm font-medium text-text-main truncate hover:underline"
                  >{resolvedMemberNames[member.userId] ?? member.displayName ?? member.userId}</a
                >
                <span
                  class="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0
                  {member.permission === 1
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'}"
                >
                  {member.role}
                </span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <input
                  type="text"
                  value={member.role}
                  onchange={(e) =>
                    handleChangeRole(
                      member.userId,
                      (e.target as HTMLInputElement).value,
                      member.permission as 0 | 1
                    )}
                  class="text-xs rounded-lg border border-cn-border bg-white px-2 py-1 w-24"
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
                  type="button"
                  onclick={() => handleRemoveMember(member.userId)}
                  class="text-red-400 hover:text-red-600 p-1"
                  title="Retirer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          {/each}
        </div>

        <div class="border-t border-cn-border pt-4">
          <h3 class="text-sm font-bold text-text-main mb-2 flex items-center gap-2">
            <UserPlus size={16} />
            Ajouter un membre
          </h3>
          <form
            class="flex flex-col sm:flex-row gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              handleAddMember();
            }}
          >
            <div class="flex-1 min-w-0">
              <UserAutocomplete
                value={newMemberUserId}
                onValueChange={(v) => (newMemberUserId = v)}
                placeholder="Rechercher un utilisateur…"
                inputId="edit-add-member-autocomplete"
                onSubmit={handleAddMember}
              />
            </div>
            <input
              type="text"
              bind:value={newMemberRole}
              placeholder="Rôle"
              class="w-full sm:w-28 rounded-xl border border-cn-border bg-white px-3 py-2 text-sm"
            />
            <select bind:value={newMemberPermission} class="rounded-xl border border-cn-border bg-white px-3 py-2 text-sm">
              <option value={0}>Membre</option>
              <option value={1}>Admin</option>
            </select>
            <button
              type="submit"
              disabled={addingMember || !newMemberUserId.trim()}
              class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
            >
              {addingMember ? '…' : 'Ajouter'}
            </button>
          </form>
          {#if memberError}
            <p class="text-sm text-red-600 mt-2">{memberError}</p>
          {/if}
        </div>
      </div>
    {/if}

    {#if isGlobalAdminUser}
      <div class="rounded-2xl border border-red-200 bg-red-50/50 p-6 space-y-2">
        <h2 class="text-sm font-bold text-red-600 flex items-center gap-2">
          <Trash2 size={16} />
          Zone de danger
        </h2>
        <button
          type="button"
          onclick={handleDelete}
          class="rounded-xl bg-red-50 border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-100"
        >
          Supprimer l’association
        </button>
      </div>
    {/if}
  {/if}
</div>
