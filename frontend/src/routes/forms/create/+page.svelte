<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
  import {
    POST_NEW_FORM_ATTACH_KEY,
    POST_NEW_FORM_ID_KEY,
    loadPostComposerDraft,
  } from '$lib/posts/postComposerDraft';
  import { listAssociations, type Association } from '$lib/associations/api';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { ArrowLeft, Save, Plus, FileText, CreditCard, ListChecks } from 'lucide-svelte';

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

  const returnTo = $derived(page.url.searchParams.get('returnTo') || '/forms');
  const attachMode = $derived(page.url.searchParams.get('attach') as 'form' | 'event' | null);
  const fromPostComposer = $derived(returnTo === '/posts' && !!attachMode);
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
      };
      const created = await createForm(payload);
      if (fromPostComposer && attachMode) {
        sessionStorage.setItem(POST_NEW_FORM_ID_KEY, created.id);
        sessionStorage.setItem(POST_NEW_FORM_ATTACH_KEY, attachMode);
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

  function addItem() {
    items = [
      ...items,
      {
        id: crypto.randomUUID(),
        label: '',
        required: false,
        type: 'short_text',
        options: [{ label: '', priceModifier: undefined }],
        rows: [],
      },
    ];
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

      <Textarea
        label="Description"
        bind:value={description}
        rows={3}
        placeholder="Décrivez brièvement l'objet de ce formulaire…"
      />

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
          <p class="text-sm text-text-muted bg-cn-border/20 rounded-2xl px-4 py-3">
            Aucune association n'a encore connecté un compte Stripe. Rendez-vous dans les paramètres
            d'une association pour activer les paiements.
          </p>
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
    {/if}
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
        <div class="flex gap-2 items-start min-w-0">
          <div class="hidden sm:flex flex-col items-center gap-1 pt-5 shrink-0">
            <span
              class="text-xs font-bold text-text-muted w-6 h-6 flex items-center justify-center rounded-lg bg-cn-border/40"
            >
              {i + 1}
            </span>
            <button
              onclick={() => moveItem(i, 'up')}
              disabled={i === 0}
              class="p-1 text-text-muted hover:text-text-main disabled:opacity-20 transition-colors"
              title="Monter"
              type="button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg
              >
            </button>
            <button
              onclick={() => moveItem(i, 'down')}
              disabled={i === items.length - 1}
              class="p-1 text-text-muted hover:text-text-main disabled:opacity-20 transition-colors"
              title="Descendre"
              type="button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
              >
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

    <button
      onclick={addItem}
      class="mt-5 w-full py-3 rounded-2xl border-2 border-dashed border-cn-border text-sm font-bold text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 transition-all flex items-center justify-center gap-2"
    >
      <Plus size={18} />
      Ajouter une question
    </button>
  </section>

  <!-- Floating Save Bar -->
  <div
    class="fixed bottom-0 inset-x-0 md:left-[4.5rem] z-50 pointer-events-none pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-5"
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
