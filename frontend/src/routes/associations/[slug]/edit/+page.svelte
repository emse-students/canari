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
    listAssociationTags,
    grantAssociationTag,
    revokeAssociationTag,
    listAssociationProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    listWebhookFailures,
    retryWebhookDelivery,
    listAssociationForms,
    reorderMembers,
    type Association,
    type AssociationMember,
    type AssociationProduct,
    type UserTag,
    type WebhookDelivery,
    type AssociationForm,
  } from '$lib/associations/api';
  import {
    listPendingCashSubmissions,
    validateCashSubmission,
    cancelCashSubmission,
    type PendingCashSubmission,
  } from '$lib/forms/api';
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
    FolderLock,
    Tags,
    ShoppingBag,
    Plus,
    RefreshCw,
    Check,
    Download,
    ClipboardList,
    GripVertical,
  } from '@lucide/svelte';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import AssociationDocumentManager from '$lib/components/associations/AssociationDocumentManager.svelte';
  import {
    hasPermissionFlag,
    AssociationPermissionFlag,
  } from '$lib/associations/api';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import AssociationLogoCropper from '$lib/components/associations/AssociationLogoCropper.svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import ColorPicker from '$lib/components/ui/ColorPicker.svelte';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let isGlobalAdminUser = $derived(isGlobalAdmin());

  let editName = $state('');
  let editDescription = $state('');
  let editBioMarkdown = $state('');
  /** Hex color for calendar display, or "" to use auto-generated color. */
  let editColor = $state('');

  /** Material You–inspired tonal palette (tone ~60, moderate saturation). */
  const PRESET_COLORS = [
    '#6B92D1', '#5BA8A0', '#5EA86C', '#8BAC5A',
    '#ACA05A', '#AC7A5A', '#AC5E5E', '#AC5E8C',
    '#8C5EAC', '#6E7EAC', '#5EA8A8', '#7CAC7C',
  ] as const;
  let saving = $state(false);
  let saveSuccess = $state(false);
  let settingsError = $state('');

  let newMemberUserId = $state('');
  let newMemberRole = $state('Membre');
  /** 0 = simple member; 287 = ALL_CORE_FLAGS (admin). */
  let newMemberPermissions = $state(0);
  let addingMember = $state(false);
  let memberError = $state('');

  let stripeLoading = $state(false);
  let logoBusy = $state(false);
  let showCropper = $state(false);

  let editSection = $state<
    'profile' | 'members' | 'documents' | 'cotisants' | 'boutique' | 'payments' | 'formulaires' | 'danger'
  >('profile');

  let canManageDocuments = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.MANAGE_DOCUMENTS))
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

  /** Stripe onboarding — backend checks POST_AS_ASSO via manage-permission endpoint. */
  let canManagePayments = $derived(
    isGlobalAdminUser ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.POST_AS_ASSO))
  );

  // ── Boutique state ───────────────────────────────────────────────────────
  let products = $state<AssociationProduct[]>([]);
  let productsLoading = $state(false);
  let productsError = $state('');
  let webhookFailures = $state<WebhookDelivery[]>([]);
  let showProductForm = $state(false);
  let savingProduct = $state(false);
  let retryingDelivery = $state<string | null>(null);

  let newProductName = $state('');
  let newProductDescription = $state('');
  let newProductAmountCents = $state<number | ''>('');
  let newProductType = $state<'membership' | 'balance_topup' | 'other'>('other');
  let newProductGrantedTag = $state('');
  let newProductTagExpires = $state('');
  let newProductAllowCustom = $state(false);
  let newProductMinCents = $state<number | ''>('');
  let newProductMaxCents = $state<number | ''>('');
  let newProductWebhookUrl = $state('');
  let newProductWebhookSecret = $state('');

  let tags = $state<UserTag[]>([]);
  let tagsLoading = $state(false);
  let tagsError = $state('');
  let newTagUserId = $state('');
  let newTagName = $state('');
  let newTagExpires = $state('');
  let grantingTag = $state(false);
  let tagUserNames = $state<Record<string, string>>({});

  // ── Formulaires state ────────────────────────────────────────────────────
  let forms = $state<AssociationForm[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  let pendingCash = $state<Record<string, PendingCashSubmission[]>>({});

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
        // Prefer the module cache (warm on SPA navigation), then displayName from API
        names[m.userId] =
          getUserDisplayNameSync(m.userId) || m.displayName?.trim() || m.userId;
      }
      resolvedMemberNames = names;
      // Always resolve asynchronously — API displayName may be stale or be the bare userId
      for (const m of members) {
        resolveUserDisplayName(m.userId).then((resolved) => {
          if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
        });
      }
      editName = a.name;
      editDescription = a.description ?? '';
      editBioMarkdown = a.bioMarkdown ?? '';
      editColor = a.color ?? '';

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

  async function handleSaveProfile() {
    if (!asso) return;
    saving = true;
    settingsError = '';
    saveSuccess = false;
    try {
      asso = await updateAssociation(asso.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim(),
        bioMarkdown: editBioMarkdown.trim(),
        color: editColor.trim() || null,
      });
      editDescription = asso.description ?? '';
      editBioMarkdown = asso.bioMarkdown ?? '';
      editColor = asso.color ?? '';
      saveSuccess = true;
      setTimeout(() => (saveSuccess = false), 3500);
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
        newMemberPermissions
      );
      members = [...members, member];
      resolvedMemberNames = {
        ...resolvedMemberNames,
        [member.userId]:
          getUserDisplayNameSync(member.userId) || member.displayName?.trim() || member.userId,
      };
      resolveUserDisplayName(member.userId).then((resolved) => {
        if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [member.userId]: resolved };
      });
      newMemberUserId = '';
      newMemberRole = 'Membre';
      newMemberPermissions = 0;
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

  async function handleChangeRole(targetId: string, role: string, permissions: number) {
    if (!asso) return;
    try {
      await updateMemberRole(asso.id, targetId, role, permissions);
      members = members.map((m) =>
        m.userId === targetId ? { ...m, role, permissions, isAdmin: permissions > 0 } : m
      );
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

  async function loadTags() {
    if (!asso) return;
    tagsLoading = true;
    tagsError = '';
    try {
      tags = await listAssociationTags(asso.id);
      // Seed sync cache first, then resolve async
      const names: Record<string, string> = {};
      for (const t of tags) {
        names[t.userId] = getUserDisplayNameSync(t.userId, t.userId);
      }
      tagUserNames = names;
      for (const t of tags) {
        void resolveUserDisplayName(t.userId).then((n) => {
          if (n) tagUserNames = { ...tagUserNames, [t.userId]: n };
        });
      }
    } catch (e) {
      tagsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      tagsLoading = false;
    }
  }

  async function handleGrantTag() {
    if (!asso || !newTagUserId.trim() || !newTagName.trim()) return;
    grantingTag = true;
    tagsError = '';
    try {
      await grantAssociationTag(asso.id, {
        userId: newTagUserId.trim(),
        tagName: newTagName.trim(),
        expiresAt: newTagExpires.trim() || undefined,
      });
      newTagUserId = '';
      newTagName = '';
      newTagExpires = '';
      await loadTags();
    } catch (e) {
      tagsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      grantingTag = false;
    }
  }

  async function handleRevokeTag(tag: UserTag) {
    if (!asso || !confirm(`Révoquer le tag "${tag.tagName}" pour cet utilisateur ?`)) return;
    try {
      await revokeAssociationTag(asso.id, tag.id);
      tags = tags.filter((t) => t.id !== tag.id);
    } catch (e) {
      tagsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function loadProducts() {
    if (!asso) return;
    productsLoading = true;
    productsError = '';
    try {
      const [prods, failures] = await Promise.all([
        listAssociationProducts(asso.id),
        listWebhookFailures(asso.id),
      ]);
      products = prods;
      webhookFailures = failures;
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      productsLoading = false;
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

  function resetProductForm() {
    newProductName = '';
    newProductDescription = '';
    newProductAmountCents = '';
    newProductType = 'other';
    newProductGrantedTag = '';
    newProductTagExpires = '';
    newProductAllowCustom = false;
    newProductMinCents = '';
    newProductMaxCents = '';
    newProductWebhookUrl = '';
    newProductWebhookSecret = '';
    showProductForm = false;
  }

  async function handleCreateProduct() {
    if (!asso || !newProductName.trim()) return;
    savingProduct = true;
    productsError = '';
    try {
      await createProduct(asso.id, {
        name: newProductName.trim(),
        description: newProductDescription.trim() || undefined,
        amountCents: newProductAmountCents !== '' ? Number(newProductAmountCents) * 100 : undefined,
        type: newProductType,
        grantedTagName: newProductGrantedTag.trim() || undefined,
        tagExpiresAt: newProductTagExpires.trim() || undefined,
        allowCustomAmount: newProductAllowCustom,
        customAmountMinCents:
          newProductMinCents !== '' ? Number(newProductMinCents) * 100 : undefined,
        customAmountMaxCents:
          newProductMaxCents !== '' ? Number(newProductMaxCents) * 100 : undefined,
        webhookUrl: newProductWebhookUrl.trim() || undefined,
        webhookSecret: newProductWebhookSecret.trim() || undefined,
      });
      resetProductForm();
      await loadProducts();
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      savingProduct = false;
    }
  }

  async function handleToggleProduct(product: AssociationProduct) {
    if (!asso) return;
    try {
      await updateProduct(asso.id, product.id, { isActive: !product.isActive });
      products = products.map((p) =>
        p.id === product.id ? { ...p, isActive: !product.isActive } : p
      );
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function handleDeleteProduct(product: AssociationProduct) {
    if (
      !asso ||
      !confirm(`Supprimer le produit "${product.name}" ? Cette action est irréversible.`)
    )
      return;
    try {
      await deleteProduct(asso.id, product.id);
      products = products.filter((p) => p.id !== product.id);
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function handleRetryDelivery(delivery: WebhookDelivery) {
    if (!asso) return;
    retryingDelivery = delivery.id;
    try {
      await retryWebhookDelivery(asso.id, delivery.id);
      await loadProducts();
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      retryingDelivery = null;
    }
  }

  let exportingPdf = $state(false);

  async function handleExportTrombinoscope() {
    if (!asso || exportingPdf) return;
    exportingPdf = true;
    try {
      await exportTrombinoscope(asso, members, resolvedMemberNames);
    } finally {
      exportingPdf = false;
    }
  }

  // ── Member drag-and-drop reorder ──────────────────────────────────────────

  let draggedIdx = $state(-1);
  let dragOverIdx = $state(-1);

  function onDragStart(idx: number) {
    draggedIdx = idx;
  }

  function onDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    dragOverIdx = idx;
  }

  async function onDrop(targetIdx: number) {
    if (draggedIdx < 0 || draggedIdx === targetIdx || !asso) return;
    const reordered = [...members];
    const [moved] = reordered.splice(draggedIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    members = reordered;
    draggedIdx = -1;
    dragOverIdx = -1;
    try {
      await reorderMembers(
        asso.id,
        reordered.map((m) => m.userId)
      );
    } catch {
      // Non-fatal: local order already updated; backend will reflect on next load
    }
  }

  function onDragEnd() {
    draggedIdx = -1;
    dragOverIdx = -1;
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
            ? 'bg-cn-yellow text-cn-dark shadow-sm'
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
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <Users size={17} />
            Membres
          </button>
        {/if}
        {#if canManagePayments}
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
        {#if canManageDocuments}
          <button
            type="button"
            onclick={() => (editSection = 'documents')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'documents'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <FolderLock size={17} />
            Documents
          </button>
        {/if}
        {#if canManageMembers}
          <button
            type="button"
            onclick={() => { editSection = 'cotisants'; void loadTags(); }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'cotisants'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <Tags size={17} />
            Cotisants
          </button>
        {/if}
        {#if canManageProducts}
          <button
            type="button"
            onclick={() => { editSection = 'boutique'; void loadProducts(); }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'boutique'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <ShoppingBag size={17} />
            Boutique
          </button>
        {/if}
        {#if canManageForms}
          <button
            type="button"
            onclick={() => { editSection = 'formulaires'; void loadForms(); }}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {editSection === 'formulaires'
              ? 'bg-cn-yellow text-cn-dark shadow-sm'
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
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <h2 class="text-lg font-bold text-text-main tracking-tight">Profil et logo</h2>
        <div class="flex flex-wrap items-start gap-4">
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
          {#if canManageMembers}
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
          {/if}
        </div>

        {#if showCropper}
          <AssociationLogoCropper
            onExport={onLogoExported}
            onCancel={() => (showCropper = false)}
          />
        {/if}

        <Input label="Nom" bind:value={editName} />
        <div class="space-y-2">
          <span class="block text-sm font-bold text-text-main ml-1">Description (sous le titre)</span>
          <MarkdownComposerField
            bind:value={editDescription}
            maxlength={2000}
            minHeight="72px"
            class="rounded-xl border border-cn-border bg-cn-bg/30 overflow-hidden"
            editorClass="min-h-[72px] w-full px-4 py-3 text-sm text-text-main leading-relaxed"
            placeholder="Courte présentation de l'association…"
          />
        </div>
        <div class="space-y-2">
          <span class="block text-sm font-bold text-text-main ml-1">Bio détaillée</span>
          <MarkdownComposerField
            bind:value={editBioMarkdown}
            maxlength={16000}
            minHeight="160px"
            class="rounded-xl border border-cn-border bg-cn-bg/30 overflow-hidden"
            editorClass="min-h-[160px] w-full px-4 py-3 text-sm text-text-main leading-relaxed"
            placeholder="Présentation complète, liens, listes…"
          />
        </div>
        <div class="flex flex-col gap-3">
          <span class="block text-sm font-bold text-text-main ml-1">Couleur de l'agenda</span>
          <div class="flex flex-wrap gap-1.5">
            {#each PRESET_COLORS as c (c)}
              <button
                type="button"
                onclick={() => (editColor = c)}
                title={c}
                class="h-7 w-7 rounded-full border-2 transition-all hover:scale-110 focus:outline-none shrink-0
                       {editColor === c ? 'border-cn-dark ring-2 ring-offset-1 ring-cn-yellow/70 scale-110' : 'border-transparent hover:border-white/60'}"
                style="background:{c};"
              ></button>
            {/each}
          </div>
          <div class="flex items-center gap-2 ml-0.5">
            <span class="text-xs text-text-muted">Personnalisée</span>
            <ColorPicker
              bind:value={editColor}
              label="Couleur personnalisée"
            />
          </div>
        </div>

        <div class="rounded-xl border border-cn-border/70 bg-cn-bg/40 p-3 text-xs text-text-muted space-y-3">
          <p class="font-semibold text-text-main">Aperçu</p>
          {#if editDescription.trim()}
            <div>
              <p class="font-medium text-text-main mb-1">Description</p>
              <ProfileBioMarkdown source={editDescription} class="text-sm" />
            </div>
          {/if}
          {#if editBioMarkdown.trim()}
            <div>
              <p class="font-medium text-text-main mb-1">Bio</p>
              <ProfileBioMarkdown source={editBioMarkdown} />
            </div>
          {:else if !editDescription.trim()}
            <p>(vide)</p>
          {/if}
        </div>
        {#if settingsError}
          <div class="text-sm text-red-600">{settingsError}</div>
        {/if}
        {#if canManageMembers}
          <div class="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onclick={handleSaveProfile}
              disabled={saving}
              class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer le profil'}
            </button>
            {#if saveSuccess}
              <span class="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                <Check size={15} />
                Modifications enregistrées
              </span>
            {/if}
          </div>
        {:else}
          <p class="text-sm text-text-muted">Vous n'avez pas le droit de modifier le profil (flag MANAGE_MEMBERS requis).</p>
        {/if}
      </div>
    {/if}

    {#if editSection === 'payments' && canManagePayments}
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

    {#if editSection === 'members' && canManageMembers}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 class="text-lg font-bold text-text-main tracking-tight">Membres</h2>
            <p class="text-sm text-text-muted mt-1">
              Rôles affichés sur la page publique. Les admins peuvent gérer l’agenda et les paiements.
            </p>
          </div>
          <button
            type="button"
            onclick={handleExportTrombinoscope}
            disabled={exportingPdf}
            class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg transition-colors shrink-0 disabled:opacity-50"
          >
            <Download size={15} />
            {exportingPdf ? 'Génération…' : 'Trombinoscope PDF'}
          </button>
        </div>
        <div class="space-y-2">
          {#each members as member, idx (member.id)}
            <div
              role="listitem"
              draggable={true}
              ondragstart={() => onDragStart(idx)}
              ondragover={(e) => onDragOver(e, idx)}
              ondrop={() => onDrop(idx)}
              ondragend={onDragEnd}
              class="flex items-start gap-2 rounded-2xl transition-opacity {draggedIdx === idx ? 'opacity-40' : ''} {dragOverIdx === idx && draggedIdx !== idx ? 'ring-2 ring-cn-yellow/60' : ''}"
            >
              <button
                type="button"
                aria-label="Déplacer ce membre"
                class="mt-3.5 cursor-grab touch-none text-text-muted hover:text-text-main transition-colors shrink-0"
              >
                <GripVertical size={18} />
              </button>
              <div class="flex-1 min-w-0">
                <AssociationMemberRow
                  {member}
                  displayName={resolvedMemberNames[member.userId] ??
                    member.displayName ??
                    member.userId}
                  manage={true}
                  onRoleChange={handleChangeRole}
                  onRemove={handleRemoveMember}
                />
              </div>
            </div>
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
              bind:value={newMemberPermissions}
              class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm w-full lg:w-auto"
            >
              <option value={0}>Membre</option>
              <option value={287}>Admin</option>
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

    {#if editSection === 'cotisants' && canManageMembers && asso}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
        <div>
          <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
            <Tags size={20} />
            Cotisants
          </h2>
          <p class="text-sm text-text-muted mt-1">
            Tags de cotisation actifs émis par cette association. Attribuez ou révoquez des tags manuellement.
          </p>
        </div>

        <!-- Grant form -->
        <form
          class="flex flex-col sm:flex-row gap-3"
          onsubmit={(e) => { e.preventDefault(); void handleGrantTag(); }}
        >
          <input
            type="text"
            bind:value={newTagUserId}
            placeholder="ID utilisateur"
            class="flex-1 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
          />
          <input
            type="text"
            bind:value={newTagName}
            placeholder="Tag (ex: cotisant:bde-2026-2027)"
            class="flex-1 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
          />
          <input
            type="date"
            bind:value={newTagExpires}
            title="Date d'expiration (optionnel)"
            class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm w-auto"
          />
          <button
            type="submit"
            disabled={grantingTag || !newTagUserId.trim() || !newTagName.trim()}
            class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            {grantingTag ? '…' : 'Attribuer'}
          </button>
        </form>

        {#if tagsError}
          <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">{tagsError}</div>
        {/if}

        {#if tagsLoading}
          <div class="flex justify-center py-6">
            <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
          </div>
        {:else if tags.length === 0}
          <p class="text-sm text-text-muted text-center py-6">Aucun tag actif.</p>
        {:else}
          <ul class="space-y-2">
            {#each tags as tag (tag.id)}
              <li class="flex items-center gap-3 rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3">
                <div class="min-w-0 flex-1">
                  <p class="font-semibold text-sm text-text-main truncate">{tag.tagName}</p>
                  <p class="text-xs text-text-muted">
                    {tagUserNames[tag.userId] ?? tag.userId}
                    {#if tag.expiresAt}
                      · Expire: {new Date(tag.expiresAt).toLocaleDateString('fr-FR')}
                    {/if}
                  </p>
                </div>
                <button
                  type="button"
                  onclick={() => handleRevokeTag(tag)}
                  title="Révoquer"
                  class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if editSection === 'boutique' && canManageProducts && asso}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-6 shadow-sm">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
              <ShoppingBag size={20} />
              Boutique
            </h2>
            <p class="text-sm text-text-muted mt-1">
              Produits disponibles à l'achat sur la page /shop et la page publique de l'association.
            </p>
          </div>
          <button
            type="button"
            onclick={() => (showProductForm = !showProductForm)}
            class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
          >
            <Plus size={16} />
            Nouveau produit
          </button>
        </div>

        {#if productsError}
          <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
            {productsError}
          </div>
        {/if}

        {#if !asso.stripeOnboardingComplete}
          <div class="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 px-4 py-3 text-sm">
            Stripe Connect non configuré. Les produits seront créés inactifs jusqu'à la complétion de l'onboarding.
            <button
              type="button"
              onclick={() => { editSection = 'payments'; }}
              class="ml-2 font-semibold underline hover:no-underline"
            >Configurer</button>
          </div>
        {/if}

        <!-- New product form -->
        {#if showProductForm}
          <form
            class="rounded-xl border border-cn-border bg-cn-bg/40 p-5 space-y-4"
            onsubmit={(e) => { e.preventDefault(); void handleCreateProduct(); }}
          >
            <h3 class="font-bold text-sm text-text-main">Nouveau produit</h3>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="space-y-1">
                <label for="new-product-name" class="text-xs font-semibold text-text-muted">Nom *</label>
                <input
                  id="new-product-name"
                  type="text"
                  bind:value={newProductName}
                  placeholder="Cotisation BDE 2026-2027"
                  required
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="space-y-1">
                <label for="new-product-type" class="text-xs font-semibold text-text-muted">Type *</label>
                <select
                  id="new-product-type"
                  bind:value={newProductType}
                  class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
                >
                  <option value="membership">Cotisation (membership)</option>
                  <option value="balance_topup">Recharge Cercle</option>
                  <option value="other">Autre</option>
                </select>
              </div>
            </div>

            <div class="space-y-1">
              <label for="new-product-description" class="text-xs font-semibold text-text-muted">Description</label>
              <textarea
                id="new-product-description"
                bind:value={newProductDescription}
                rows={2}
                placeholder="Description affichée dans la boutique"
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm resize-none"
              ></textarea>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="space-y-1">
                <label for="new-product-amount" class="text-xs font-semibold text-text-muted">Prix fixe (€) — vide = libre uniquement</label>
                <input
                  id="new-product-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  bind:value={newProductAmountCents}
                  placeholder="10.00"
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="space-y-1 flex flex-col justify-end">
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" bind:checked={newProductAllowCustom} class="rounded" />
                  Permettre un montant libre
                </label>
              </div>
            </div>

            {#if newProductAllowCustom}
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="new-product-min" class="text-xs font-semibold text-text-muted">Min (€)</label>
                  <input
                    id="new-product-min"
                    type="number"
                    min="0.01"
                    step="0.01"
                    bind:value={newProductMinCents}
                    placeholder="5.00"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-product-max" class="text-xs font-semibold text-text-muted">Max (€)</label>
                  <input
                    id="new-product-max"
                    type="number"
                    min="0.01"
                    step="0.01"
                    bind:value={newProductMaxCents}
                    placeholder="100.00"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
            {/if}

            {#if newProductType === 'membership'}
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="new-product-tag" class="text-xs font-semibold text-text-muted">Tag accordé à l'achat</label>
                  <input
                    id="new-product-tag"
                    type="text"
                    bind:value={newProductGrantedTag}
                    placeholder="cotisant:bde-2026-2027"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-product-tag-expires" class="text-xs font-semibold text-text-muted">Expiration du tag</label>
                  <input
                    id="new-product-tag-expires"
                    type="date"
                    bind:value={newProductTagExpires}
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
            {/if}

            {#if newProductType === 'balance_topup'}
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="new-product-webhook-url" class="text-xs font-semibold text-text-muted">URL webhook Cercle</label>
                  <input
                    id="new-product-webhook-url"
                    type="url"
                    bind:value={newProductWebhookUrl}
                    placeholder="https://cercle.example.com/webhooks/canari"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-product-webhook-secret" class="text-xs font-semibold text-text-muted">Secret HMAC</label>
                  <input
                    id="new-product-webhook-secret"
                    type="password"
                    bind:value={newProductWebhookSecret}
                    placeholder="Secret partagé avec Cercle"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
            {/if}

            <div class="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={savingProduct || !newProductName.trim()}
                class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
              >
                {savingProduct ? 'Création…' : 'Créer le produit'}
              </button>
              <button
                type="button"
                onclick={resetProductForm}
                class="text-sm text-text-muted hover:text-text-main"
              >Annuler</button>
            </div>
          </form>
        {/if}

        <!-- Product list -->
        {#if productsLoading}
          <div class="flex justify-center py-6">
            <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
          </div>
        {:else if products.length === 0}
          <p class="text-sm text-text-muted text-center py-6">Aucun produit pour le moment.</p>
        {:else}
          <ul class="space-y-3">
            {#each products as product (product.id)}
              <li class="flex items-center gap-3 rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <p class="font-semibold text-sm text-text-main">{product.name}</p>
                    <span class="rounded-full px-2 py-0.5 text-xs font-semibold {product.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-cn-surface-alt text-text-muted'}">
                      {product.isActive ? 'Actif' : 'Inactif'}
                    </span>
                    <span class="text-xs text-text-muted">{product.type}</span>
                  </div>
                  <p class="text-xs text-text-muted mt-0.5">
                    {product.amountCents != null
                      ? `${(product.amountCents / 100).toFixed(2)} €`
                      : 'Montant libre'}
                    {product.grantedTagName ? ` · Tag: ${product.grantedTagName}` : ''}
                  </p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onclick={() => handleToggleProduct(product)}
                    class="text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-[var(--cn-surface)] transition-colors"
                  >
                    {product.isActive ? 'Désactiver' : 'Activer'}
                  </button>
                  <button
                    type="button"
                    onclick={() => handleDeleteProduct(product)}
                    title="Supprimer"
                    class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- Webhook failures -->
        {#if webhookFailures.length > 0}
          <div class="border-t border-cn-border pt-5 space-y-3">
            <h3 class="text-sm font-bold text-text-main flex items-center gap-2 text-amber-700">
              <AlertTriangle size={16} />
              Livraisons Cercle échouées ({webhookFailures.length})
            </h3>
            <ul class="space-y-2">
              {#each webhookFailures as delivery (delivery.id)}
                <li class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-semibold text-text-main">
                      {(delivery.amountCents / 100).toFixed(2)} € — {delivery.paymentIntentId.slice(0, 20)}…
                    </p>
                    <p class="text-xs text-text-muted">
                      Tentatives: {delivery.attemptCount} ·
                      {delivery.lastAttemptAt
                        ? new Date(delivery.lastAttemptAt).toLocaleString('fr-FR')
                        : '—'}
                    </p>
                    {#if delivery.lastError}
                      <p class="text-xs text-red-600 truncate">{delivery.lastError}</p>
                    {/if}
                  </div>
                  <button
                    type="button"
                    disabled={retryingDelivery === delivery.id}
                    onclick={() => handleRetryDelivery(delivery)}
                    class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-1.5 text-xs font-semibold hover:bg-[var(--cn-surface)] disabled:opacity-50"
                  >
                    <RefreshCw size={13} class={retryingDelivery === delivery.id ? 'animate-spin' : ''} />
                    Réessayer
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}

    {#if editSection === 'formulaires' && canManageForms && asso}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
        <div>
          <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
            <ClipboardList size={20} />
            Formulaires
          </h2>
          <p class="text-sm text-text-muted mt-1">
            Formulaires liés à cette association. Validez les paiements en espèces en attente.
          </p>
        </div>

        {#if formsError}
          <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">{formsError}</div>
        {/if}

        {#if formsLoading}
          <div class="flex justify-center py-8">
            <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
          </div>
        {:else if forms.length === 0}
          <p class="text-sm text-text-muted text-center py-8">Aucun formulaire lié à cette association.</p>
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
                    <p class="text-xs text-text-muted mt-1">
                      {form.basePrice > 0 ? `${(form.basePrice / 100).toFixed(2)} €` : 'Gratuit'}
                      {form.allowCashPayment ? ' · Espèces acceptées' : ''}
                    </p>
                  </div>
                  <a
                    href="/forms/{form.id}"
                    class="text-xs font-semibold text-cn-yellow hover:underline shrink-0"
                    target="_blank"
                    rel="noopener noreferrer"
                  >Voir le formulaire ↗</a>
                </div>

                {#if pendingCash[form.id]?.length}
                  <div class="border-t border-cn-border/50 pt-3 space-y-2">
                    <p class="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle size={13} />
                      {pendingCash[form.id].length} paiement{pendingCash[form.id].length > 1 ? 's' : ''} en attente de validation
                    </p>
                    <ul class="space-y-2">
                      {#each pendingCash[form.id] as sub (sub.id)}
                        <li class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
                          <div class="min-w-0 flex-1">
                            <p class="text-xs font-semibold text-text-main truncate">{sub.userId}</p>
                            <p class="text-xs text-text-muted">{(sub.totalPaid / 100).toFixed(2)} € · {new Date(sub.createdAt).toLocaleDateString('fr-FR')}</p>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onclick={async () => {
                                try {
                                  await validateCashSubmission(form.id, sub.id);
                                  pendingCash = { ...pendingCash, [form.id]: pendingCash[form.id].filter((s) => s.id !== sub.id) };
                                } catch (e) {
                                  formsError = e instanceof Error ? e.message : 'Erreur';
                                }
                              }}
                              class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                            >Valider</button>
                            <button
                              type="button"
                              onclick={async () => {
                                if (!confirm('Annuler ce paiement ?')) return;
                                try {
                                  await cancelCashSubmission(form.id, sub.id);
                                  pendingCash = { ...pendingCash, [form.id]: pendingCash[form.id].filter((s) => s.id !== sub.id) };
                                } catch (e) {
                                  formsError = e instanceof Error ? e.message : 'Erreur';
                                }
                              }}
                              class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                            >Annuler</button>
                          </div>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {:else if form.allowCashPayment}
                  <p class="text-xs text-text-muted border-t border-cn-border/50 pt-3">Aucun paiement en espèces en attente.</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
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
