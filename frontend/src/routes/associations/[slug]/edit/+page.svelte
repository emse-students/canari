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
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    Users,
    CreditCard,
    Trash2,
    UserPlus,
    ArrowLeft,
    Building2,
    AlertTriangle,
  } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import AssociationLogoCropper from '$lib/components/associations/AssociationLogoCropper.svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';

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

  let editSection = $state<'profile' | 'members' | 'payments' | 'danger'>('profile');

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
        (!!mine && (mine.permission === 1 || mine.role === 'admin' || mine.role === 'owner'));
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
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
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
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Modifier l’association</h1>
      <p class="text-sm text-text-muted">@{asso.slug}</p>
    </header>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <!-- Section tabs -->
    <nav
      class="sticky top-0 z-30 -mx-4 px-4 py-3 bg-[var(--cn-bg)]/95 backdrop-blur-md border-y border-cn-border/80 sm:border sm:rounded-2xl sm:mx-0"
      aria-label="Sections édition"
    >
      <div class="flex gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onclick={() => (editSection = 'profile')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {editSection === 'profile'
            ? 'bg-cn-yellow text-cn-dark shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Building2 size={17} />
          Profil
        </button>
        {#if isAdmin || isGlobalAdminUser}
          <button
            type="button"
            onclick={() => (editSection = 'members')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'members'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <Users size={17} />
            Membres
          </button>
          <button
            type="button"
            onclick={() => (editSection = 'payments')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'payments'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <CreditCard size={17} />
            Paiements
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
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <h2 class="text-lg font-bold text-text-main tracking-tight">Profil et logo</h2>
        <div class="flex flex-wrap items-start gap-4">
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
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
          <AssociationLogoCropper
            onExport={onLogoExported}
            onCancel={() => (showCropper = false)}
          />
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
            <ProfileBioMarkdown source={editBioMarkdown} />
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
    {/if}

    {#if editSection === 'payments' && (isAdmin || isGlobalAdminUser)}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
      >
        <h2 class="text-lg font-bold text-text-main flex items-center gap-2 tracking-tight">
          <CreditCard size={20} />
          Paiements Stripe
        </h2>
        {#if asso.stripeOnboardingComplete}
          <p class="text-sm text-green-600 font-semibold">Stripe Connect activé</p>
        {:else}
          <p class="text-sm text-text-muted leading-relaxed">
            Connectez un compte Stripe pour les paiements des formulaires et billetteries associés à
            cette association.
          </p>
          <button
            type="button"
            onclick={handleStripeOnboarding}
            disabled={stripeLoading}
            class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50 shadow-sm"
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

    {#if editSection === 'members' && (isAdmin || isGlobalAdminUser)}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div>
          <h2 class="text-lg font-bold text-text-main tracking-tight">Membres</h2>
          <p class="text-sm text-text-muted mt-1">
            Rôles affichés sur la page publique. Les admins peuvent gérer l’agenda et les paiements.
          </p>
        </div>
        <div class="space-y-3">
          {#each members as member (member.id)}
            <AssociationMemberRow
              {member}
              displayName={resolvedMemberNames[member.userId] ??
                member.displayName ??
                member.userId}
              manage={true}
              onRoleChange={handleChangeRole}
              onRemove={handleRemoveMember}
            />
          {/each}
        </div>

        <div class="border-t border-cn-border pt-5">
          <h3 class="text-sm font-bold text-text-main mb-3 flex items-center gap-2">
            <UserPlus size={17} />
            Ajouter un membre
          </h3>
          <form
            class="flex flex-col lg:flex-row gap-3"
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
              placeholder="Rôle affiché"
              class="w-full lg:w-36 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
            />
            <select
              bind:value={newMemberPermission}
              class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm w-full lg:w-auto"
            >
              <option value={0}>Membre</option>
              <option value={1}>Admin</option>
            </select>
            <button
              type="submit"
              disabled={addingMember || !newMemberUserId.trim()}
              class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
            >
              {addingMember ? '…' : 'Ajouter'}
            </button>
          </form>
          {#if memberError}
            <p class="text-sm text-red-600 mt-3">{memberError}</p>
          {/if}
        </div>
      </div>
    {/if}

    {#if editSection === 'danger' && isGlobalAdminUser}
      <div class="rounded-2xl border border-red-200 bg-red-50/60 p-6 space-y-3">
        <h2 class="text-base font-bold text-red-700 flex items-center gap-2">
          <Trash2 size={18} />
          Zone de danger
        </h2>
        <p class="text-sm text-red-800/90">
          Supprime définitivement l’association et ses liens (membres, événements d’agenda). Les
          messages du fil peuvent rester visibles selon la politique serveur.
        </p>
        <button
          type="button"
          onclick={handleDelete}
          class="rounded-xl bg-white border border-red-300 px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100"
        >
          Supprimer l’association
        </button>
      </div>
    {/if}
  {/if}
</div>
