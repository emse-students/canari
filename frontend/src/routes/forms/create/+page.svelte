<script lang="ts">
  import { goto } from '$app/navigation';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';

  // State
  let title = $state('Event Registration');
  let description = $state('');
  let basePrice = $state(0);
  let currency = $state('eur');
  let submitLabel = $state('Pay & Register');
  let maxSubmissions = $state<number | undefined>(undefined);
  let requiresPayment = $state(false);

  let items = $state<any[]>([
    {
      id: crypto.randomUUID(),
      label: 'Full Name',
      required: true,
      type: 'short_text',
      options: [],
      rows: [],
    },
  ]);

  let isSubmitting = $state(false);
  let error = $state('');

  async function handleSave() {
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
        // ownerId must not be provided by the client; server derives owner from JWT
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
    items.push({
      id: crypto.randomUUID(),
      label: 'Nouvelle question',
      required: false,
      type: 'short_text',
      options: [{ label: 'Option 1', priceModifier: undefined }],
      rows: ['Ligne 1'],
    });
  }

  function removeItem(index: number) {
    items = items.filter((_, i) => i !== index);
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Créer un formulaire</h1>
    <button
      onclick={handleSave}
      disabled={isSubmitting}
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50 self-start sm:self-auto"
    >
      {isSubmitting ? 'Enregistrement…' : 'Enregistrer'}
    </button>
  </div>

  {#if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-3 mb-4 text-sm">
      {error}
    </div>
  {/if}

  <div class="rounded-2xl border border-cn-border bg-white/80 p-5 mb-6 space-y-4">
    <h2 class="text-lg font-bold text-text-main">Paramètres généraux</h2>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="sm:col-span-2">
        <label class="block text-sm font-medium text-text-muted mb-1">Titre du formulaire</label>
        <input
          type="text"
          bind:value={title}
          class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow"
        />
      </div>

      <div class="sm:col-span-2">
        <label class="block text-sm font-medium text-text-muted mb-1">Description</label>
        <textarea
          bind:value={description}
          rows="2"
          class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow resize-none"
        ></textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-text-muted mb-1"
          >Libellé du bouton de soumission</label
        >
        <input
          type="text"
          bind:value={submitLabel}
          class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-text-muted mb-1"
          >Nombre maximum de réponses</label
        >
        <input
          type="number"
          bind:value={maxSubmissions}
          placeholder="Illimité"
          class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow"
        />
      </div>
    </div>

    <div class="border-t border-cn-border pt-4 space-y-3">
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" bind:checked={requiresPayment} class="w-4 h-4 accent-yellow-400" />
        <span class="text-sm font-semibold text-text-main">Ce formulaire nécessite un paiement</span
        >
      </label>

      {#if requiresPayment}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div>
            <label class="block text-sm font-medium text-text-muted mb-1"
              >Prix de base (centimes)</label
            >
            <input
              type="number"
              bind:value={basePrice}
              class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-text-muted mb-1">Devise</label>
            <select
              bind:value={currency}
              class="w-full rounded-xl border border-cn-border bg-white px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow"
            >
              <option value="eur">EUR</option>
              <option value="usd">USD</option>
            </select>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <div class="rounded-2xl border border-cn-border bg-white/80 p-5">
    <h2 class="text-lg font-bold text-text-main mb-4">Questions</h2>
    <div class="space-y-4">
      {#each items as _item, i (i)}
        <FormBuilder bind:item={items[i]} onRemove={() => removeItem(i)} />
      {/each}
    </div>
    <button
      onclick={addItem}
      class="mt-4 w-full py-2.5 rounded-xl border-2 border-dashed border-cn-border text-sm font-semibold text-text-muted hover:border-cn-yellow hover:text-cn-dark transition-colors"
    >
      + Ajouter une question
    </button>
  </div>
</div>
