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
  let ownerId = 'user-123'; // Replace with real auth

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
        ownerId,
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

<div class="max-w-4xl mx-auto p-6 bg-white dark:bg-gray-900 rounded shadow">
  <div class="flex justify-between mb-6">
    <h1 class="text-2xl font-bold">Créer un formulaire</h1>
    <button
      onclick={handleSave}
      disabled={isSubmitting}
      class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
    >
      {isSubmitting ? 'Enregistrement...' : 'Enregistrer'}
    </button>
  </div>

  {#if error}
    <div class="bg-red-100 text-red-700 p-3 rounded mb-4">{error}</div>
  {/if}

  <div class="space-y-4 mb-8 border-b pb-8">
    <h2 class="text-xl font-semibold">Paramètres généraux</h2>
    <div>
      <span class="block text-sm font-medium mb-1">Titre du formulaire</span>
      <input
        type="text"
        bind:value={title}
        class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
      />
    </div>
    <div>
      <span class="block text-sm font-medium mb-1">Description</span>
      <textarea
        bind:value={description}
        class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
      ></textarea>
    </div>
    <div class="grid grid-cols-3 gap-4">
      <div>
        <span class="block text-sm font-medium mb-1">Nombre maximum de réponses</span>
        <input
          type="number"
          bind:value={maxSubmissions}
          placeholder="Laisser vide pour illimité"
          class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
        />
      </div>

      <div class="md:col-span-2 space-y-4 border-t pt-4 mt-4">
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={requiresPayment} class="w-4 h-4 text-blue-600" />
          <span class="font-medium">Ce formulaire nécessite un paiement</span>
        </label>
      </div>

      {#if requiresPayment}
        <div>
          <span class="block text-sm font-medium mb-1">Prix de base (Centimes)</span>
          <input
            type="number"
            bind:value={basePrice}
            class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
        </div>
        <div>
          <span class="block text-sm font-medium mb-1">Devise</span>
          <select
            bind:value={currency}
            class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
          >
            <option value="eur">EUR</option>
            <option value="usd">USD</option>
          </select>
        </div>
      {/if}

      <div>
        <span class="block text-sm font-medium mb-1">Libellé du bouton Soumettre</span>
        <input
          type="text"
          bind:value={submitLabel}
          class="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
        />
      </div>
    </div>
  </div>

  <div>
    <h2 class="text-xl font-semibold mb-4">Questions</h2>
    <div class="space-y-6">
      {#each items as _item, i (i)}
        <FormBuilder bind:item={items[i]} onRemove={() => removeItem(i)} />
      {/each}
    </div>
    <button
      onclick={addItem}
      class="mt-4 w-full py-2 border-2 border-dashed border-gray-300 text-gray-500 rounded hover:border-blue-500 hover:text-blue-500"
    >
      + Ajouter une question
    </button>
  </div>
</div>
