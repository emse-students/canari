<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import { Trash2, X, Plus } from 'lucide-svelte';

  let { item = $bindable(), onRemove } = $props<{
    item: any;
    onRemove: () => void;
  }>();

  const formItemTypes = [
    { value: 'short_text', label: 'Réponse courte' },
    { value: 'long_text', label: 'Paragraphe' },
    { value: 'single_choice', label: 'Choix unique (Radio)' },
    { value: 'multiple_choice', label: 'Choix multiples (Cases)' },
    { value: 'dropdown', label: 'Liste déroulante' },
    { value: 'linear_scale', label: 'Échelle linéaire' },
    { value: 'matrix_single', label: 'Grille choix unique' },
    { value: 'matrix_multiple', label: 'Grille choix multiples' },
  ];

  const isMatrix = $derived(['matrix_single', 'matrix_multiple'].includes(item.type));
  const hasOptions = $derived(!['short_text', 'long_text', 'linear_scale'].includes(item.type));

  function addOption() {
    if (!item.options) item.options = [];
    item.options = [...item.options, { label: '', priceModifier: undefined }];
  }

  function removeOption(idx: number) {
    if (!item.options) return;
    item.options = item.options.filter((_: any, i: number) => i !== idx);
  }

  function addRow() {
    if (!item.rows) item.rows = [];
    item.rows = [...item.rows, ''];
  }

  function removeRow(idx: number) {
    if (!item.rows) return;
    item.rows = item.rows.filter((_: any, i: number) => i !== idx);
  }

  // Ensure defaults
  if (!item.scale) item.scale = { min: 1, max: 5 };
  if (!item.options) item.options = [];
  if (!item.rows) item.rows = [];
</script>

<div
  class="relative p-5 bg-[var(--cn-surface)] rounded-2xl border-2 border-cn-border group transition-all hover:border-cn-yellow/40"
>
  <!-- Delete button -->
  <button
    class="absolute top-3 right-3 p-1.5 text-text-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-all opacity-0 group-hover:opacity-100"
    onclick={onRemove}
    type="button"
    title="Supprimer la question"
  >
    <Trash2 size={16} />
  </button>

  <!-- Question label + Type -->
  <div class="grid grid-cols-1 md:grid-cols-12 gap-4 mb-4 pr-8">
    <div class="md:col-span-7">
      <Input label="Question" bind:value={item.label} placeholder="Intitulé de la question" />
    </div>
    <div class="md:col-span-5">
      <label for="item-type-select" class="block text-sm font-bold text-text-main mb-2 ml-1"
        >Type</label
      >
      <select
        id="item-type-select"
        bind:value={item.type}
        class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
      >
        {#each formItemTypes as type (type.value)}
          <option value={type.value}>{type.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Required toggle -->
  <div class="mb-5 flex justify-end">
    <label class="flex items-center gap-3 cursor-pointer select-none">
      <span class="text-sm font-medium text-text-muted">Réponse obligatoire</span>
      <div class="relative">
        <input type="checkbox" bind:checked={item.required} class="peer sr-only" />
        <div
          class="w-10 h-5.5 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
        ></div>
        <div
          class="absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-[18px]"
        ></div>
      </div>
    </label>
  </div>

  <!-- Type Specific Rendering -->
  {#if ['short_text', 'long_text'].includes(item.type)}
    <div
      class="p-4 bg-cn-border/20 border-2 border-dashed border-cn-border rounded-2xl text-sm text-text-muted italic text-center"
    >
      L'utilisateur verra un champ de saisie {item.type === 'short_text'
        ? 'en une ligne'
        : 'multiligne'} ici.
    </div>
  {:else if item.type === 'linear_scale'}
    <div class="p-4 bg-cn-border/20 border-2 border-cn-border rounded-2xl space-y-4">
      <div class="flex items-center gap-4">
        <span class="text-sm font-bold text-text-main">Plage :</span>
        <select
          bind:value={item.scale.min}
          class="px-3 py-1.5 border-2 border-cn-border rounded-xl text-sm bg-[var(--cn-surface)] outline-none focus:border-cn-yellow transition-all"
        >
          <option value={0}>0</option>
          <option value={1}>1</option>
        </select>
        <span class="text-xs text-text-muted uppercase font-bold">à</span>
        <select
          bind:value={item.scale.max}
          class="px-3 py-1.5 border-2 border-cn-border rounded-xl text-sm bg-[var(--cn-surface)] outline-none focus:border-cn-yellow transition-all"
        >
          {#each Array.from({ length: 9 }, (_, i) => i + 2) as val (val)}
            <option value={val}>{val}</option>
          {/each}
        </select>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label={`Libellé pour ${item.scale.min} (optionnel)`}
          bind:value={item.scale.minLabel}
          placeholder="ex: Pas du tout d'accord"
        />
        <Input
          label={`Libellé pour ${item.scale.max} (optionnel)`}
          bind:value={item.scale.maxLabel}
          placeholder="ex: Tout à fait d'accord"
        />
      </div>
    </div>
  {:else if hasOptions}
    <!-- Options / Columns -->
    <div class="space-y-3">
      <div class="flex justify-between items-end px-1">
        <span class="text-xs font-bold text-text-muted uppercase tracking-wider">
          {isMatrix ? 'Colonnes' : 'Options'}
        </span>
        {#if !isMatrix}
          <span class="text-xs text-text-muted font-medium mr-12">Supplément (€)</span>
        {/if}
      </div>

      <div class="space-y-2">
        {#each item.options as opt, optIdx (optIdx)}
          <div class="flex gap-2 items-center">
            <span class="text-xs font-mono text-text-muted w-5 text-center shrink-0 pt-2"
              >{optIdx + 1}.</span
            >

            <div class="flex-1">
              <Input
                placeholder={isMatrix ? 'Libellé de la colonne' : "Libellé de l'option"}
                bind:value={opt.label}
              />
            </div>

            {#if !isMatrix}
              <div class="w-24">
                <Input type="number" placeholder="0" bind:value={opt.priceModifier} step="0.01" />
              </div>
            {/if}

            <button
              class="p-2 text-text-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors shrink-0 mt-1"
              onclick={() => removeOption(optIdx)}
              type="button"
              title="Supprimer"
            >
              <X size={16} />
            </button>
          </div>
        {/each}
      </div>

      <button
        class="text-sm flex items-center gap-1.5 text-cn-dark font-bold hover:text-cn-yellow transition-colors py-1 ml-7"
        onclick={addOption}
        type="button"
      >
        <Plus size={16} />
        Ajouter {isMatrix ? 'une colonne' : 'une option'}
      </button>
    </div>

    <!-- Rows for Matrix -->
    {#if isMatrix}
      <div class="mt-5 pt-5 border-t-2 border-dashed border-cn-border space-y-3">
        <span class="text-xs font-bold text-text-muted uppercase tracking-wider px-1">Lignes</span>

        <div class="space-y-2">
          {#each item.rows as _row, rowIdx (rowIdx)}
            <div class="flex gap-2 items-center">
              <span class="text-xs font-mono text-text-muted w-5 text-center shrink-0 pt-2"
                >{rowIdx + 1}.</span
              >
              <div class="flex-1">
                <Input placeholder="Libellé de la ligne" bind:value={item.rows[rowIdx]} />
              </div>
              <button
                class="p-2 text-text-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors shrink-0 mt-1"
                onclick={() => removeRow(rowIdx)}
                type="button"
                title="Supprimer"
              >
                <X size={16} />
              </button>
            </div>
          {/each}
        </div>

        <button
          class="text-sm flex items-center gap-1.5 text-cn-dark font-bold hover:text-cn-yellow transition-colors py-1 ml-7"
          onclick={addRow}
          type="button"
        >
          <Plus size={16} />
          Ajouter une ligne
        </button>
      </div>
    {/if}
  {/if}
</div>
