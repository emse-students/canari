<script lang="ts">
  import { goto } from '$app/navigation';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
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
    isSubmitting = true;
    error = '';
    try {
      const payload: CreateFormPayload = {
        title,
        description,
        basePrice: requiresPayment ? basePrice : 0,
        currency: requiresPayment ? currency : 'eur',
        submitLabel,
        items: items.map((item) => ({
          ...item,
          options:
            item.options?.map((opt: any) => ({
              ...opt,
              priceModifier: opt.priceModifier ?? 0,
            })) || [],
        })),
        maxSubmissions,
        requiresPayment,
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
          label="Prix de base (centimes)"
          type="number"
          bind:value={basePrice}
          min="0"
          placeholder="0"
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
            <FormBuilder bind:item={items[i]} onRemove={() => removeItem(i)} />
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
              ? `${basePrice} centimes`
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
