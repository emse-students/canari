<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
  import {
    POST_NEW_FORM_ID_KEY,
    loadPostComposerDraft,
  } from '$lib/posts/postComposerDraft';
  import { listAssociations, type Association } from '$lib/associations/api';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import {
    ArrowLeft,
    Save,
    Plus,
    FileText,
    CreditCard,
    ListChecks,
    Type,
    AlignLeft,
    CircleDot,
    CheckSquare,
    ChevronDown,
    SlidersHorizontal,
    LayoutGrid,
    Table2,
  } from '@lucide/svelte';

  // State
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

  const returnTo = $derived(page.url.searchParams.get('returnTo') || '/forms');
  const fromPostComposer = $derived(
    returnTo === '/posts' && page.url.searchParams.get('attach') === 'form'
  );
  const contentMaxWidth = $derived(fromPostComposer ? 'max-w-xl' : 'max-w-3xl');

  // Associations with Stripe account (eligible as recipients)
  let associations = $state<Association[]>([]);

  onMount(async () => {
    const draft = loadPostComposerDraft();
    if (draft?.scheduledAt && !opensAt) {
      opensAt = draft.scheduledAt;
    }
    try {
      const all = await listAssociations();
      associations = all.filter((a) => a.stripeAccountId);
    } catch {
      // Ignore — user may not have access
    }
  });

  let items = $state<any[]>([
    {
      id: crypto.randomUUID(),
      label: '',
      required: true,
      type: 'short_text',
      options: [],
      rows: [],
    },
  ]);

  let isSubmitting = $state(false);
  let error = $state('');

  // Drag-and-drop reordering
  let dragIndex = $state(-1);
  let dropIndex = $state(-1);

  // Type picker
  let showTypePicker = $state(false);

  const QUESTION_TYPES = [
    { value: 'short_text', label: 'Texte court', Icon: Type },
    { value: 'long_text', label: 'Long texte', Icon: AlignLeft },
    { value: 'single_choice', label: 'Choix unique', Icon: CircleDot },
    { value: 'multiple_choice', label: 'Cases à cocher', Icon: CheckSquare },
    { value: 'dropdown', label: 'Liste déroulante', Icon: ChevronDown },
    { value: 'linear_scale', label: 'Échelle', Icon: SlidersHorizontal },
    { value: 'matrix_single', label: 'Grille unique', Icon: LayoutGrid },
    { value: 'matrix_multiple', label: 'Grille multiple', Icon: Table2 },
  ];

  let titleMissing = $derived(!title.trim());

  async function handleSave() {
    if (titleMissing) {
      error = 'Le titre du formulaire est obligatoire.';
      return;
    }
    if (requiresPayment && !associationId) {
      error = 'Veuillez sélectionner une association bénéficiaire pour un formulaire payant.';
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
          options:
            item.options?.map((opt: any) => ({
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
      const created = await createForm(payload);
      if (fromPostComposer) {
        sessionStorage.setItem(POST_NEW_FORM_ID_KEY, created.id);
        goto('/posts');
      } else {
        goto(returnTo);
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      isSubmitting = false;
    }
  }

  function addItem(type: string = 'short_text') {
    items = [
      ...items,
      {
        id: crypto.randomUUID(),
        label: '',
        required: false,
        type,
        options: [{ label: '', priceModifier: undefined }],
        rows: [],
      },
    ];
    showTypePicker = false;
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

  function handleDragStart(index: number) {
    dragIndex = index;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    dropIndex = index;
  }

  function handleDrop(index: number) {
    if (dragIndex === -1 || dragIndex === index) {
      dragIndex = -1;
      dropIndex = -1;
      return;
    }
    const copy = [...items];
    const [moved] = copy.splice(dragIndex, 1);
    copy.splice(index, 0, moved);
    items = copy;
    dragIndex = -1;
    dropIndex = -1;
  }

  function handleDragEnd() {
    dragIndex = -1;
    dropIndex = -1;
  }
</script>

<div class="px-3 py-5 sm:px-6 {contentMaxWidth} mx-auto pb-28">
  <!-- Header -->
  <div class="flex items-center gap-3 mb-8">
    <button
      onclick={() => goto(fromPostComposer ? '/posts' : returnTo)}
      class="p-2 rounded-xl text-text-muted hover:text-text-main hover:bg-cn-border/30 transition-colors"
      title="Retour"
    >
      <ArrowLeft size={20} />
    </button>
    <div class="flex-1 min-w-0">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Nouveau formulaire</h1>
      <p class="text-sm text-text-muted mt-0.5">Configurez votre formulaire et ses questions</p>
    </div>
  </div>

  {#if error}
    <div
      class="rounded-2xl bg-red-50 border-2 border-red-200 text-red-700 px-4 py-3 mb-6 text-sm font-medium flex items-center gap-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="shrink-0"
      >
        <circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line
          x1="12"
          x2="12.01"
          y1="16"
          y2="16"
        />
      </svg>
      {error}
    </div>
  {/if}

  <!-- Section 1: General Settings -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <FileText size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">Informations générales</h2>
    </div>

    <div class="space-y-4">
      <Input
        label="Titre du formulaire"
        bind:value={title}
        placeholder="ex: Inscription événement"
        required
      />

      <div>
        <p class="block text-sm font-bold text-text-main mb-1 ml-1">Description</p>
        <MarkdownComposerField bind:value={description} placeholder="Décrivez l'objet de ce formulaire… (markdown supporté)" minHeight="80px" />
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input label="Libellé du bouton" bind:value={submitLabel} placeholder="Envoyer" />
        <Input
          label="Réponses max."
          type="number"
          bind:value={maxSubmissions}
          placeholder="Illimité"
          min="1"
        />
      </div>

      <div>
        <label for="form-opens-at" class="block text-sm font-bold text-text-main mb-2 ml-1">
          Date d’ouverture (shotgun)
        </label>
        <input
          id="form-opens-at"
          type="datetime-local"
          bind:value={opensAt}
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
        <p class="text-xs text-text-muted mt-1.5 ml-1">
          Laissez vide pour ouvrir immédiatement. Les réponses seront bloquées avant cette date.
        </p>
      </div>
    </div>
  </section>

  <!-- Section 2: Payment -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <CreditCard size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">Paiement</h2>
    </div>

    <label class="flex items-center gap-3 cursor-pointer select-none group">
      <div class="relative">
        <input type="checkbox" bind:checked={requiresPayment} class="peer sr-only" />
        <div
          class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
        ></div>
        <div
          class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"
        ></div>
      </div>
      <span class="text-sm font-semibold text-text-main">Ce formulaire nécessite un paiement</span>
    </label>

    {#if requiresPayment}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5 pt-5 border-t-2 border-cn-border">
        <Input
          label="Prix de base (€)"
          type="number"
          bind:value={basePrice}
          min="0"
          step="0.01"
          placeholder="0.00"
        />
        <div>
          <label for="currency-select" class="block text-sm font-bold text-text-main mb-2 ml-1"
            >Devise</label
          >
          <select
            id="currency-select"
            bind:value={currency}
            class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          >
            <option value="eur">EUR (€)</option>
            <option value="usd">USD ($)</option>
          </select>
        </div>
      </div>

      <!-- Recipient Association -->
      <div class="mt-4">
        <label for="association-select" class="block text-sm font-bold text-text-main mb-2 ml-1"
          >Association bénéficiaire</label
        >
        {#if associations.length > 0}
          <select
            id="association-select"
            bind:value={associationId}
            class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          >
            <option value="">Sélectionner une association…</option>
            {#each associations as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
          <p class="text-xs text-text-muted mt-1 ml-1">
            Les paiements seront transférés au compte Stripe de l'association sélectionnée.
          </p>
        {:else}
          <div class="rounded-2xl border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 space-y-2">
            <p class="text-sm font-semibold text-amber-900 dark:text-amber-100">
              Les formulaires payants nécessitent une association avec Stripe Connect activé.
            </p>
            <p class="text-xs text-amber-800/80 dark:text-amber-200/70">
              Vous n'êtes administrateur d'aucune association ayant connecté un compte de paiement. Vous pouvez créer un formulaire gratuit sans association.
            </p>
            <button
              type="button"
              onclick={() => { requiresPayment = false; }}
              class="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-900 dark:text-amber-100 px-3 py-1.5 text-xs font-bold transition-colors"
            >
              Créer un formulaire gratuit à la place
            </button>
          </div>
        {/if}
      </div>

      <!-- Payment methods -->
      <div class="mt-4 pt-4 border-t-2 border-cn-border">
        <p class="text-sm font-bold text-text-main mb-3">Moyen de paiement</p>
        <div
          class="flex items-center gap-4 rounded-2xl border-2 border-cn-yellow bg-cn-yellow/5 px-4 py-3.5"
        >
          <div
            class="shrink-0 w-10 h-10 rounded-xl bg-cn-yellow/20 text-cn-dark flex items-center justify-center"
          >
            <CreditCard size={20} />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold text-text-main">Carte, Apple Pay, Google Pay</p>
            <p class="text-xs text-text-muted">
              Visa, Mastercard, Amex — wallets détectés automatiquement
            </p>
          </div>
          <div
            class="shrink-0 flex items-center gap-1.5 rounded-full bg-cn-yellow/30 text-cn-dark px-3 py-1 text-xs font-bold"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg
            >
            Activé
          </div>
        </div>
      </div>

      <!-- Cash payment option -->
      <div class="mt-4 pt-4 border-t-2 border-cn-border space-y-3">
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <div class="relative">
            <input type="checkbox" bind:checked={allowCashPayment} class="peer sr-only" />
            <div
              class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
            ></div>
            <div
              class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"
            ></div>
          </div>
          <span class="text-sm font-semibold text-text-main">Accepter le paiement en espèces</span>
        </label>
        {#if allowCashPayment}
          <div>
            <label for="cash-expiry" class="block text-sm font-bold text-text-main mb-2 ml-1">
              Expiration du paiement en attente (jours)
            </label>
            <input
              id="cash-expiry"
              type="number"
              bind:value={cashPaymentExpiryDays}
              min="1"
              placeholder="Jamais (laisser vide)"
              class="w-full sm:w-48 px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
            />
            <p class="text-xs text-text-muted mt-1.5 ml-1">
              Les paiements en espèces non validés après ce délai passent automatiquement à
              "expiré". Laissez vide pour ne jamais expirer.
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Section: Statut cotisation -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5">
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </div>
      <h2 class="text-lg font-bold text-text-main">Statut cotisation</h2>
    </div>
    <p class="text-sm text-text-muted mb-4">
      Après un paiement réussi, un tag peut être automatiquement attribué à l'utilisateur (ex :
      <code class="bg-cn-border/30 px-1.5 py-0.5 rounded-lg text-xs">cotisant:bde-2026</code>).
    </p>
    <div class="space-y-4">
      <div>
        <label for="granted-tag" class="block text-sm font-bold text-text-main mb-2 ml-1">
          Tag à attribuer
        </label>
        <input
          id="granted-tag"
          type="text"
          bind:value={grantedTagName}
          placeholder="ex: cotisant:bde-2026"
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
        <p class="text-xs text-text-muted mt-1.5 ml-1">
          Laissez vide pour n'attribuer aucun tag.
        </p>
      </div>
      {#if grantedTagName.trim()}
        <div>
          <label for="tag-expires-at" class="block text-sm font-bold text-text-main mb-2 ml-1">
            Expiration du tag
          </label>
          <input
            id="tag-expires-at"
            type="date"
            bind:value={tagExpiresAt}
            class="w-full sm:w-56 px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          />
          <p class="text-xs text-text-muted mt-1.5 ml-1">
            Laissez vide pour un tag permanent.
          </p>
        </div>
      {/if}
    </div>
  </section>

  <!-- Section 3: Questions -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-3 sm:p-6">
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5 px-1 sm:px-0">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <ListChecks size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">Questions</h2>
      <span
        class="ml-auto text-xs font-semibold text-text-muted bg-cn-border/40 px-2.5 py-1 rounded-full"
      >
        {items.length} question{items.length > 1 ? 's' : ''}
      </span>
    </div>

    <div class="space-y-3 sm:space-y-4">
      {#each items as _item, i (_item.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          draggable="true"
          ondragstart={() => handleDragStart(i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondrop={() => handleDrop(i)}
          ondragend={handleDragEnd}
          class="transition-all duration-150 {dragIndex === i
            ? 'opacity-40 scale-[0.98]'
            : ''} {dropIndex === i && dragIndex !== i
            ? 'ring-2 ring-cn-yellow/60 ring-offset-1 rounded-[2rem]'
            : ''}"
        >
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
      {/each}
    </div>

    <div class="relative mt-5">
      <button
        type="button"
        onclick={() => (showTypePicker = !showTypePicker)}
        class="w-full py-3 rounded-2xl border-2 border-dashed border-cn-border text-sm font-bold text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 transition-all flex items-center justify-center gap-2"
      >
        <Plus size={18} />
        Ajouter une question
      </button>

      {#if showTypePicker}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={() => (showTypePicker = false)}></div>
        <div
          class="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] shadow-xl p-3"
        >
          <p class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wider mb-2.5 ml-1">
            Type de question
          </p>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {#each QUESTION_TYPES as qtype (qtype.value)}
              {@const Icon = qtype.Icon}
              <button
                type="button"
                onclick={() => addItem(qtype.value)}
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-xl border border-cn-border hover:border-cn-yellow hover:bg-cn-yellow/5 text-center transition-all group"
              >
                <Icon size={18} class="text-text-muted group-hover:text-cn-dark transition-colors" />
                <span
                  class="text-[0.65rem] font-semibold text-text-muted group-hover:text-text-main leading-tight"
                  >{qtype.label}</span
                >
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- Floating Save Bar -->
  <div
    class="keyboard-aware-bottom fixed bottom-0 inset-x-0 md:left-[4.5rem] z-50 pointer-events-none pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-5"
  >
    <div class="{contentMaxWidth} mx-auto px-3 sm:px-6">
      <div
        class="pointer-events-auto rounded-2xl border border-cn-border/60 bg-[var(--cn-surface)]/85 dark:bg-[#151B2C]/85 backdrop-blur-xl shadow-lg px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-3 text-center sm:text-left"
      >
        <p class="text-sm text-text-muted min-h-[1.25rem]">
          {#if titleMissing}
            <span class="text-amber-600 font-medium">Renseignez un titre pour enregistrer</span>
          {:else}
            {items.length} question{items.length > 1 ? 's' : ''}{#if requiresPayment && basePrice > 0}
              · {basePrice.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €
            {:else if !requiresPayment}
              · Gratuit
            {/if}
          {/if}
        </p>
        <button
          onclick={handleSave}
          disabled={isSubmitting || titleMissing}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 w-full sm:w-auto"
        >
          <Save size={16} />
          {isSubmitting ? 'Enregistrement…' : 'Enregistrer le formulaire'}
        </button>
      </div>
    </div>
  </div>
</div>
