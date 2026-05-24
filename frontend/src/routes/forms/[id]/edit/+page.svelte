<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    getForm,
    updateForm,
    uploadFormImage,
    deleteFormImage,
    addFormCoOwner,
    removeFormCoOwner,
    type CreateFormPayload,
    type Form,
  } from '$lib/forms/api';
  import { listAssociations, type Association } from '$lib/associations/api';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import {
    ArrowLeft,
    Save,
    Plus,
    FileText,
    CreditCard,
    ListChecks,
    ImagePlus,
    X,
    Users,
    Trash2,
    Check,
  } from '@lucide/svelte';

  const formId = $derived(page.params.id as string);

  let form = $state<Form | null>(null);
  let loadError = $state('');

  // General settings
  let title = $state('');
  let description = $state('');
  let basePrice = $state(0);
  let currency = $state('eur');
  let submitLabel = $state('Envoyer');
  let maxSubmissions = $state<number | undefined>(undefined);
  let opensAt = $state('');
  let requiresPayment = $state(false);
  let associationId = $state('');
  let allowCashPayment = $state(false);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);
  let grantedTagName = $state('');
  let tagExpiresAt = $state('');

  // Image
  let imageUrl = $state<string | null>(null);
  let uploadingImage = $state(false);
  let imageError = $state('');

  // Co-owners
  let coOwners = $state<string[]>([]);
  let coOwnerInput = $state('');
  let addingCoOwner = $state(false);
  let coOwnerError = $state('');

  // Associations with Stripe account
  let associations = $state<Association[]>([]);

  let items = $state<any[]>([]);
  let isSubmitting = $state(false);
  let error = $state('');

  function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }
  function isoToDatetimeLocal(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  onMount(async () => {
    const id = formId;
    if (!id) { loadError = 'Formulaire introuvable.'; return; }
    try {
      const [f, all] = await Promise.all([
        getForm(id),
        listAssociations(),
      ]);
      form = f;
      associations = all.filter((a) => a.stripeAccountId);

      title = f.title;
      description = f.description ?? '';
      requiresPayment = f.requiresPayment ?? false;
      basePrice = requiresPayment ? (f.basePrice ?? 0) / 100 : 0;
      currency = f.currency ?? 'eur';
      submitLabel = f.submitLabel ?? 'Envoyer';
      maxSubmissions = f.maxSubmissions;
      opensAt = isoToDatetimeLocal(f.opensAt);
      associationId = f.associationId ?? '';
      allowCashPayment = f.allowCashPayment ?? false;
      cashPaymentExpiryDays = f.cashPaymentExpiryDays ?? undefined;
      grantedTagName = f.grantedTagName ?? '';
      tagExpiresAt = f.tagExpiresAt ? f.tagExpiresAt.slice(0, 10) : '';
      imageUrl = f.imageUrl ?? null;
      coOwners = [...(f.coOwners ?? [])];
      items = (f.items ?? []).map((item: any) => ({
        ...item,
        options: item.options?.map((opt: any) => ({
          ...opt,
          priceModifier: requiresPayment ? (opt.priceModifier ?? 0) / 100 : 0,
        })) || [],
        rows: item.rows || [],
      }));
    } catch (e: any) {
      loadError = e.message || 'Impossible de charger le formulaire.';
    }
  });

  let titleMissing = $derived(!title.trim());

  async function handleSave() {
    if (titleMissing) { error = 'Le titre est obligatoire.'; return; }
    if (requiresPayment && !associationId) {
      error = 'Veuillez sélectionner une association bénéficiaire.';
      return;
    }
    isSubmitting = true;
    error = '';
    try {
      const payload: CreateFormPayload = {
        title,
        description,
        basePrice: requiresPayment ? Math.round(basePrice * 100) : 0,
        currency: requiresPayment ? currency : 'eur',
        submitLabel,
        items: items.map((item) => ({
          ...item,
          options: item.options?.map((opt: any) => ({
            ...opt,
            priceModifier: opt.priceModifier != null ? Math.round(opt.priceModifier * 100) : 0,
          })) || [],
          rows: item.rows?.map((r: any) => (typeof r === 'string' ? r : r.value)) || [],
        })),
        maxSubmissions,
        ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
        requiresPayment,
        associationId: requiresPayment && associationId ? associationId : undefined,
        ...(requiresPayment ? { allowCashPayment } : {}),
        ...(requiresPayment && allowCashPayment && cashPaymentExpiryDays != null
          ? { cashPaymentExpiryDays }
          : {}),
        ...(grantedTagName.trim() ? { grantedTagName: grantedTagName.trim() } : {}),
        ...(grantedTagName.trim() && tagExpiresAt
          ? { tagExpiresAt: new Date(tagExpiresAt).toISOString() }
          : {}),
      };
      await updateForm(formId, payload);
      goto('/forms');
    } catch (e: any) {
      error = e.message;
    } finally {
      isSubmitting = false;
    }
  }

  async function handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadingImage = true;
    imageError = '';
    try {
      const updated = await uploadFormImage(formId, file);
      imageUrl = updated.imageUrl ?? null;
    } catch (err: any) {
      imageError = err.message || 'Erreur lors de l\'envoi de l\'image';
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }

  async function handleImageRemove() {
    uploadingImage = true;
    try {
      await deleteFormImage(formId);
      imageUrl = null;
    } catch (err: any) {
      imageError = err.message || 'Erreur';
    } finally {
      uploadingImage = false;
    }
  }

  async function handleAddCoOwner(userId: string) {
    if (!userId || coOwners.includes(userId)) return;
    addingCoOwner = true;
    coOwnerError = '';
    try {
      await addFormCoOwner(formId, userId);
      coOwners = [...coOwners, userId];
      coOwnerInput = '';
    } catch (err: any) {
      coOwnerError = err.message || 'Erreur';
    } finally {
      addingCoOwner = false;
    }
  }

  async function handleRemoveCoOwner(userId: string) {
    try {
      await removeFormCoOwner(formId, userId);
      coOwners = coOwners.filter((id) => id !== userId);
    } catch (err: any) {
      coOwnerError = err.message || 'Erreur';
    }
  }

  function addItem() {
    items = [...items, {
      id: crypto.randomUUID(),
      label: '',
      required: false,
      type: 'short_text',
      options: [{ label: '', priceModifier: undefined }],
      rows: [],
    }];
  }

  function removeItem(index: number) {
    items = items.filter((_, i) => i !== index);
  }

  function moveItem(index: number, direction: 'up' | 'down') {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= items.length) return;
    const copy = [...items];
    [copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
    items = copy;
  }
</script>

<div class="px-3 py-5 sm:px-6 max-w-3xl mx-auto pb-28">
  <!-- Header -->
  <div class="flex items-center gap-3 mb-8">
    <button
      onclick={() => goto('/forms')}
      class="p-2 rounded-xl text-text-muted hover:text-text-main hover:bg-cn-border/30 transition-colors"
      title="Retour"
    >
      <ArrowLeft size={20} />
    </button>
    <div class="flex-1 min-w-0">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Modifier le formulaire</h1>
      {#if form}
        <p class="text-sm text-text-muted mt-0.5 truncate">{form.title}</p>
      {/if}
    </div>
  </div>

  {#if loadError}
    <div class="rounded-2xl bg-red-50 border-2 border-red-200 text-red-700 px-4 py-3 mb-6 text-sm font-medium">
      {loadError}
    </div>
  {:else if !form}
    <div class="flex justify-center py-16">
      <div class="w-10 h-10 border-4 border-cn-yellow border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}
    {#if error}
      <div class="rounded-2xl bg-red-50 border-2 border-red-200 text-red-700 px-4 py-3 mb-6 text-sm font-medium flex items-center gap-2">
        {error}
      </div>
    {/if}

    <!-- Section: General Settings -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
      <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark"><FileText size={20} /></div>
        <h2 class="text-lg font-bold text-text-main">Informations générales</h2>
      </div>
      <div class="space-y-4">
        <Input label="Titre du formulaire" bind:value={title} placeholder="ex: Inscription événement" required />
        <div>
          <label class="block text-sm font-bold text-text-main mb-1 ml-1">Description</label>
          <MarkdownComposerField bind:value={description} placeholder="Décrivez l'objet de ce formulaire… (markdown supporté)" minHeight="80px" />
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Libellé du bouton" bind:value={submitLabel} placeholder="Envoyer" />
          <Input label="Réponses max." type="number" bind:value={maxSubmissions} placeholder="Illimité" min="1" />
        </div>
        <div>
          <label for="form-opens-at" class="block text-sm font-bold text-text-main mb-2 ml-1">Date d'ouverture (shotgun)</label>
          <input
            id="form-opens-at"
            type="datetime-local"
            bind:value={opensAt}
            class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          />
          <p class="text-xs text-text-muted mt-1.5 ml-1">Laissez vide pour ouvrir immédiatement.</p>
        </div>
      </div>
    </section>

    <!-- Section: Banner Image -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
      <div class="flex items-center gap-2.5 mb-4">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark"><ImagePlus size={20} /></div>
        <h2 class="text-lg font-bold text-text-main">Image / affiche</h2>
      </div>
      {#if imageError}
        <p class="text-sm text-red-600 mb-3">{imageError}</p>
      {/if}
      {#if imageUrl}
        <div class="relative rounded-xl overflow-hidden border border-cn-border mb-2">
          <img src={imageUrl} alt="Affiche" class="w-full max-h-56 object-cover" />
          <button
            type="button"
            onclick={handleImageRemove}
            disabled={uploadingImage}
            class="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
            title="Supprimer l'image"
          >
            <X size={14} />
          </button>
        </div>
      {:else}
        <label class="flex items-center gap-2 cursor-pointer rounded-xl border-2 border-dashed border-cn-border bg-cn-bg/40 px-4 py-4 text-sm text-text-muted hover:border-cn-yellow/50 transition-colors {uploadingImage ? 'opacity-50 pointer-events-none' : ''}">
          <ImagePlus size={18} class="shrink-0 text-text-muted/60" />
          {uploadingImage ? 'Envoi en cours…' : 'Ajouter une image (JPEG / PNG / WebP, max 8 Mo)'}
          <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" onchange={handleImageUpload} />
        </label>
      {/if}
    </section>

    <!-- Section: Payment -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
      <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark"><CreditCard size={20} /></div>
        <h2 class="text-lg font-bold text-text-main">Paiement</h2>
      </div>
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <div class="relative">
          <input type="checkbox" bind:checked={requiresPayment} class="peer sr-only" />
          <div class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"></div>
          <div class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
        </div>
        <span class="text-sm font-semibold text-text-main">Ce formulaire nécessite un paiement</span>
      </label>
      {#if requiresPayment}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5 pt-5 border-t-2 border-cn-border">
          <Input label="Prix de base (€)" type="number" bind:value={basePrice} min="0" step="0.01" placeholder="0.00" />
          <div>
            <label for="currency-select" class="block text-sm font-bold text-text-main mb-2 ml-1">Devise</label>
            <select id="currency-select" bind:value={currency} class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow">
              <option value="eur">EUR (€)</option>
              <option value="usd">USD ($)</option>
            </select>
          </div>
        </div>
        <div class="mt-4">
          <label for="association-select" class="block text-sm font-bold text-text-main mb-2 ml-1">Association bénéficiaire</label>
          {#if associations.length > 0}
            <select id="association-select" bind:value={associationId} class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow">
              <option value="">Sélectionner…</option>
              {#each associations as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
          {:else}
            <p class="text-sm text-text-muted bg-cn-border/20 rounded-2xl px-4 py-3">Aucune association avec Stripe connecté.</p>
          {/if}
        </div>
        <div class="mt-4 pt-4 border-t-2 border-cn-border space-y-3">
          <label class="flex items-center gap-3 cursor-pointer select-none">
            <div class="relative">
              <input type="checkbox" bind:checked={allowCashPayment} class="peer sr-only" />
              <div class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"></div>
              <div class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
            </div>
            <span class="text-sm font-semibold text-text-main">Accepter le paiement en espèces</span>
          </label>
          {#if allowCashPayment}
            <Input label="Expiration paiement en attente (jours)" type="number" bind:value={cashPaymentExpiryDays} min="1" placeholder="Jamais" />
          {/if}
        </div>
      {/if}
    </section>

    <!-- Section: Tag cotisation -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
      <div class="flex items-center gap-2.5 mb-4">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </div>
        <h2 class="text-lg font-bold text-text-main">Statut cotisation</h2>
      </div>
      <div class="space-y-4">
        <Input label="Tag à attribuer" bind:value={grantedTagName} placeholder="ex: cotisant:bde-2026" />
        {#if grantedTagName.trim()}
          <div>
            <label for="tag-expires-at" class="block text-sm font-bold text-text-main mb-2 ml-1">Expiration du tag</label>
            <input id="tag-expires-at" type="date" bind:value={tagExpiresAt} class="w-full sm:w-56 px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow" />
          </div>
        {/if}
      </div>
    </section>

    <!-- Section: Co-owners -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
      <div class="flex items-center gap-2.5 mb-4">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark"><Users size={20} /></div>
        <h2 class="text-lg font-bold text-text-main">Co-responsables</h2>
      </div>
      <p class="text-sm text-text-muted mb-4">
        Les co-responsables peuvent modifier ce formulaire et consulter les réponses.
      </p>
      {#if coOwnerError}
        <p class="text-sm text-red-600 mb-3">{coOwnerError}</p>
      {/if}
      {#if coOwners.length > 0}
        <ul class="space-y-2 mb-4">
          {#each coOwners as uid (uid)}
            <li class="flex items-center justify-between gap-3 rounded-xl border border-cn-border bg-cn-bg/40 px-3 py-2">
              <span class="text-sm font-mono text-text-muted truncate">{uid}</span>
              <button
                type="button"
                onclick={() => handleRemoveCoOwner(uid)}
                class="rounded-lg border border-red-200 p-1.5 text-red-500 hover:bg-red-50 transition-colors"
                title="Retirer"
              >
                <Trash2 size={13} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="flex gap-2">
        <div class="flex-1 min-w-0">
          <UserAutocomplete
            value={coOwnerInput}
            onValueChange={(v) => (coOwnerInput = v)}
            placeholder="Rechercher un utilisateur…"
            onSelect={(u) => handleAddCoOwner(u.id)}
          />
        </div>
        <button
          type="button"
          onclick={() => handleAddCoOwner(coOwnerInput.trim())}
          disabled={addingCoOwner || !coOwnerInput.trim()}
          class="shrink-0 rounded-xl border border-cn-border px-3 py-2 text-sm font-semibold hover:bg-cn-bg disabled:opacity-40"
        >
          {addingCoOwner ? '…' : 'Ajouter'}
        </button>
      </div>
    </section>

    <!-- Section: Questions -->
    <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-3 sm:p-6">
      <div class="flex items-center gap-2.5 mb-4 sm:mb-5 px-1 sm:px-0">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark"><ListChecks size={20} /></div>
        <h2 class="text-lg font-bold text-text-main">Questions</h2>
        <span class="ml-auto text-xs font-semibold text-text-muted bg-cn-border/40 px-2.5 py-1 rounded-full">
          {items.length} question{items.length > 1 ? 's' : ''}
        </span>
      </div>
      <div class="space-y-3 sm:space-y-4">
        {#each items as _item, i (_item.id)}
          <div class="flex gap-2 items-start min-w-0">
            <div class="hidden sm:flex flex-col items-center gap-1 pt-5 shrink-0">
              <span class="text-xs font-bold text-text-muted w-6 h-6 flex items-center justify-center rounded-lg bg-cn-border/40">{i + 1}</span>
              <button onclick={() => moveItem(i, 'up')} disabled={i === 0} class="p-1 text-text-muted hover:text-text-main disabled:opacity-20 transition-colors" type="button">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg>
              </button>
              <button onclick={() => moveItem(i, 'down')} disabled={i === items.length - 1} class="p-1 text-text-muted hover:text-text-main disabled:opacity-20 transition-colors" type="button">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            </div>
            <div class="flex-1 min-w-0 w-full">
              <FormBuilder
                bind:item={items[i]}
                onRemove={() => removeItem(i)}
                showPriceModifier={requiresPayment}
                questionIndex={i + 1}
                onMoveUp={() => moveItem(i, 'up')}
                onMoveDown={() => moveItem(i, 'down')}
                canMoveUp={i > 0}
                canMoveDown={i < items.length - 1}
              />
            </div>
          </div>
        {/each}
      </div>
      <button onclick={addItem} class="mt-5 w-full py-3 rounded-2xl border-2 border-dashed border-cn-border text-sm font-bold text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 transition-all flex items-center justify-center gap-2">
        <Plus size={18} />
        Ajouter une question
      </button>
    </section>

    <!-- Floating Save Bar -->
    <div class="keyboard-aware-bottom fixed bottom-0 inset-x-0 md:left-[4.5rem] z-50 pointer-events-none pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-5">
      <div class="max-w-3xl mx-auto px-3 sm:px-6">
        <div class="pointer-events-auto rounded-2xl border border-cn-border/60 bg-[var(--cn-surface)]/85 dark:bg-[#151B2C]/85 backdrop-blur-xl shadow-lg px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-3">
          <p class="text-sm text-text-muted min-h-[1.25rem]">
            {#if titleMissing}
              <span class="text-amber-600 font-medium">Renseignez un titre pour enregistrer</span>
            {:else}
              {items.length} question{items.length > 1 ? 's' : ''}
            {/if}
          </p>
          <button
            onclick={handleSave}
            disabled={isSubmitting || titleMissing}
            class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 w-full sm:w-auto"
          >
            <Save size={16} />
            {isSubmitting ? 'Enregistrement…' : 'Enregistrer les modifications'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
