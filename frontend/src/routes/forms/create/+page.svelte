<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
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
  let requiresPayment = $state(false);
  let associationId = $state('');
  let paymentMethods = $state<string[]>(['card']);

  // Associations with Stripe account (eligible as recipients)
  let associations = $state<Association[]>([]);

  onMount(async () => {
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
        requiresPayment,
        associationId: requiresPayment && associationId ? associationId : undefined,
        paymentMethods: requiresPayment ? paymentMethods : undefined,
      };
      await createForm(payload);
      goto('/forms');
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

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto pb-24">
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
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-6 mb-5">
    <div class="flex items-center gap-2.5 mb-5">
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
    </div>
  </section>

  <!-- Section 2: Payment -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-6 mb-5">
    <div class="flex items-center gap-2.5 mb-5">
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
        <p class="text-sm font-bold text-text-main mb-1">Moyens de paiement acceptés</p>
        <p class="text-xs text-text-muted mb-3">
          Au moins un moyen requis. Les options actives apparaîtront sur la page Stripe.
        </p>

        <div class="flex flex-col gap-2">
          {#each [{ id: 'card', label: 'Carte bancaire', sub: 'Visa, Mastercard, Amex…', icon: 'card' }, { id: 'paypal', label: 'PayPal', sub: 'Redirection vers PayPal', icon: 'paypal' }] as method (method.id)}
            {@const checked = paymentMethods.includes(method.id)}
            {@const isLast = paymentMethods.length === 1 && checked}
            <button
              type="button"
              onclick={() => {
                if (checked) {
                  if (!isLast) paymentMethods = paymentMethods.filter((m) => m !== method.id);
                } else {
                  paymentMethods = [...paymentMethods, method.id];
                }
              }}
              class="flex items-center gap-4 rounded-2xl border-2 px-4 py-3.5 text-left w-full transition-all
                {checked
                ? 'border-cn-yellow bg-cn-yellow/5 shadow-sm'
                : 'border-cn-border bg-transparent hover:border-cn-yellow/50'}
                {isLast ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}"
              title={isLast ? 'Au moins un moyen de paiement requis' : ''}
            >
              <!-- Icon -->
              <div
                class="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center
                {checked ? 'bg-cn-yellow/20 text-cn-dark' : 'bg-cn-border/40 text-text-muted'}"
              >
                {#if method.icon === 'card'}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect width="20" height="14" x="2" y="5" rx="2" /><line
                      x1="2"
                      x2="22"
                      y1="10"
                      y2="10"
                    />
                  </svg>
                {:else if method.icon === 'paypal'}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path
                      d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.012.078-.026.157-.042.238-.375 2.245-1.668 3.793-3.783 4.576a8.1 8.1 0 0 1-2.498.38H12.32l-.582 3.835c-.081.52-.529.903-1.053.903H7.076v5.308zm9.607-14.697c-.176 1.178-.832 2.068-1.94 2.54a5.69 5.69 0 0 1-1.998.343h-1.12l.637-4.18h1.12c.963 0 1.672.19 2.093.567.407.364.544.892.408 1.73z"
                    />
                  </svg>
                {/if}
              </div>

              <!-- Text -->
              <div class="flex-1 min-w-0">
                <p class="text-sm font-bold text-text-main">{method.label}</p>
                <p class="text-xs text-text-muted">{method.sub}</p>
              </div>

              <!-- Toggle pill -->
              <div
                class="shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition-colors
                {checked ? 'bg-cn-yellow/30 text-cn-dark' : 'bg-cn-border/40 text-text-muted'}"
              >
                {#if checked}
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
                {:else}
                  Désactivé
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <!-- Section 3: Questions -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-6">
    <div class="flex items-center gap-2.5 mb-5">
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

    <div class="space-y-4">
      {#each items as _item, i (_item.id)}
        <div class="flex gap-2 items-start">
          <div class="flex flex-col items-center gap-1 pt-5">
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
          <div class="flex-1 min-w-0">
            <FormBuilder
              bind:item={items[i]}
              onRemove={() => removeItem(i)}
              showPriceModifier={requiresPayment}
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
  <div class="fixed bottom-0 left-0 right-0 z-50 pointer-events-none">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 pb-5">
      <div
        class="pointer-events-auto rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] shadow-lg px-5 py-3.5 flex items-center justify-between gap-4"
      >
        <p class="text-sm text-text-muted hidden sm:block">
          {#if titleMissing}
            <span class="text-amber-600 font-medium">Renseignez un titre pour enregistrer</span>
          {:else}
            {items.length} question{items.length > 1 ? 's' : ''} · {requiresPayment
              ? `${basePrice.toFixed(2)} €`
              : 'Gratuit'}
          {/if}
        </p>
        <button
          onclick={handleSave}
          disabled={isSubmitting || titleMissing}
          class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={16} />
          {isSubmitting ? 'Enregistrement…' : 'Enregistrer le formulaire'}
        </button>
      </div>
    </div>
  </div>
</div>
