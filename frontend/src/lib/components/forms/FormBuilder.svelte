<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import { Trash2, X, Plus } from 'lucide-svelte';

  let {
    item = $bindable(),
    onRemove,
    showPriceModifier = false,
  } = $props<{
    item: any;
    onRemove: () => void;
    showPriceModifier?: boolean;
  }>();

  // Labels beaucoup plus clairs et descriptifs
  const formItemTypes = [
    { value: 'short_text', label: 'Texte court' },
    { value: 'long_text', label: 'Paragraphe long' },
    { value: 'single_choice', label: 'Sélection unique (Boutons radio)' },
    { value: 'multiple_choice', label: 'Sélection multiple (Cases à cocher)' },
    { value: 'dropdown', label: 'Menu déroulant' },
    { value: 'linear_scale', label: 'Échelle de notation' },
    { value: 'matrix_single', label: 'Grille (Choix unique par ligne)' },
    { value: 'matrix_multiple', label: 'Grille (Choix multiples)' },
  ];

  const isMatrix = $derived(['matrix_single', 'matrix_multiple'].includes(item.type));
  const hasOptions = $derived(!['short_text', 'long_text', 'linear_scale'].includes(item.type));

  function addOption() {
    if (!item.options) item.options = [];
    item.options = [
      ...item.options,
      { id: crypto.randomUUID(), label: '', priceModifier: undefined },
    ];
  }

  function removeOption(idx: number) {
    if (!item.options) return;
    item.options = item.options.filter((_: any, i: number) => i !== idx);
  }

  function addRow() {
    if (!item.rows) item.rows = [];
    item.rows = [...item.rows, { id: crypto.randomUUID(), value: '' }];
  }

  function removeRow(idx: number) {
    if (!item.rows) return;
    item.rows = item.rows.filter((_: any, i: number) => i !== idx);
  }

  // Initialisation par défaut sécurisée
  if (!item.scale) item.scale = { min: 1, max: 5 };
  if (!item.options) item.options = [];
  item.options = item.options.map((opt: any) => ({ ...opt, id: opt.id || crypto.randomUUID() }));
  if (!item.rows) item.rows = [];
  item.rows = item.rows.map((row: any) =>
    typeof row === 'string'
      ? { id: crypto.randomUUID(), value: row }
      : { ...row, id: row.id || crypto.randomUUID() }
  );
</script>

<div
  class="relative p-5 sm:p-6 bg-white/40 dark:bg-black/20 backdrop-blur-xl rounded-[2rem] border border-black/5 dark:border-white/10 shadow-sm transition-all duration-300 hover:shadow-md hover:border-amber-500/30 group"
>
  <!-- Bouton de suppression -->
  <button
    class="absolute top-4 right-4 p-2 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-full transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 outline-none"
    onclick={onRemove}
    type="button"
    title="Supprimer cette question"
    aria-label="Supprimer la question"
  >
    <Trash2 size={18} />
  </button>

  <!-- En-tête de la question : Intitulé + Type -->
  <div class="grid grid-cols-1 md:grid-cols-12 gap-5 mb-6 pr-10 md:pr-12">
    <div class="md:col-span-7">
      <Input
        label="Intitulé de la question"
        bind:value={item.label}
        placeholder="Ex: Que pensez-vous de cet événement ?"
      />
    </div>
    <div class="md:col-span-5">
      <label for="item-type-select" class="block text-sm font-bold text-text-main mb-2 ml-1">
        Type de réponse
      </label>
      <select
        id="item-type-select"
        bind:value={item.type}
        class="w-full px-4 py-3.5 border border-black/10 dark:border-white/10 rounded-xl text-sm font-medium text-text-main bg-white/50 dark:bg-black/40 backdrop-blur-md outline-none transition-all focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 appearance-none"
      >
        {#each formItemTypes as type (type.value)}
          <option value={type.value} class="bg-white dark:bg-zinc-800">{type.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Switch : Question obligatoire -->
  <div class="mb-6 flex justify-end">
    <label class="flex items-center gap-3 cursor-pointer select-none group/toggle">
      <span
        class="text-sm font-semibold text-text-muted group-hover/toggle:text-text-main transition-colors"
      >
        Rendre cette question obligatoire
      </span>
      <div class="relative flex items-center">
        <input type="checkbox" bind:checked={item.required} class="peer sr-only" />
        <!-- Fond du switch -->
        <div
          class="w-12 h-6 bg-black/10 dark:bg-white/10 rounded-full peer-checked:bg-amber-500 shadow-inner transition-colors duration-300"
        ></div>
        <!-- Pastille du switch -->
        <div
          class="absolute left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 peer-checked:translate-x-6"
        ></div>
      </div>
    </label>
  </div>

  <div class="w-full h-px bg-black/5 dark:bg-white/5 mb-6"></div>

  <!-- Rendu dynamique selon le type -->
  {#if ['short_text', 'long_text'].includes(item.type)}
    <div
      class="p-5 bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/20 rounded-2xl text-sm text-text-muted/80 italic text-center"
    >
      L'utilisateur verra un champ de saisie texte
      <span class="font-semibold text-text-muted"
        >{item.type === 'short_text' ? 'court (une ligne)' : 'long (multiligne)'}</span
      >
      à cet emplacement.
    </div>
  {:else if item.type === 'linear_scale'}
    <div
      class="p-5 bg-white/30 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-2xl space-y-5"
    >
      <div class="flex flex-wrap items-center gap-4">
        <span class="text-sm font-bold text-text-main">Échelle de :</span>
        <select
          bind:value={item.scale.min}
          class="px-4 py-2 border border-black/10 dark:border-white/10 rounded-xl text-sm font-medium bg-white/50 dark:bg-black/40 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-all"
        >
          <option value={0} class="bg-white dark:bg-zinc-800">0</option>
          <option value={1} class="bg-white dark:bg-zinc-800">1</option>
        </select>
        <span class="text-xs text-text-muted uppercase font-bold">à</span>
        <select
          bind:value={item.scale.max}
          class="px-4 py-2 border border-black/10 dark:border-white/10 rounded-xl text-sm font-medium bg-white/50 dark:bg-black/40 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-all"
        >
          {#each Array.from({ length: 9 }, (_, i) => i + 2) as val (val)}
            <option value={val} class="bg-white dark:bg-zinc-800">{val}</option>
          {/each}
        </select>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2">
        <Input
          label={`Légende pour la note ${item.scale.min} (Optionnel)`}
          bind:value={item.scale.minLabel}
          placeholder="Ex: Pas du tout d'accord"
        />
        <Input
          label={`Légende pour la note ${item.scale.max} (Optionnel)`}
          bind:value={item.scale.maxLabel}
          placeholder="Ex: Tout à fait d'accord"
        />
      </div>
    </div>
  {:else if hasOptions}
    <!-- Rendu pour les Choix et Grilles -->
    <div class="space-y-4">
      <div class="flex justify-between items-end px-2">
        <h4 class="text-xs font-bold text-text-main uppercase tracking-widest opacity-80">
          {isMatrix ? 'Colonnes (Choix possibles)' : 'Options de réponse'}
        </h4>
        {#if !isMatrix && showPriceModifier}
          <span class="text-xs text-text-muted font-semibold mr-[3.25rem]">Supplément (€)</span>
        {/if}
      </div>

      <div class="space-y-2.5">
        {#each item.options as opt, idx (opt.id)}
          <div class="flex gap-3 items-center group/opt">
            <span
              class="text-xs font-mono text-text-muted w-6 text-center shrink-0 pt-2 opacity-60"
            >
              {idx + 1}.
            </span>

            <div class="flex-1 relative">
              <Input
                placeholder={isMatrix ? 'Intitulé de la colonne' : "Intitulé de l'option"}
                bind:value={opt.label}
              />
            </div>

            {#if !isMatrix && showPriceModifier}
              <div class="w-24 shrink-0">
                <Input
                  type="number"
                  placeholder="0.00"
                  bind:value={opt.priceModifier}
                  step="0.01"
                />
              </div>
            {/if}

            <button
              class="p-2.5 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-colors shrink-0 mt-1 focus:outline-none focus:ring-2 focus:ring-red-500/30"
              onclick={() => removeOption(idx)}
              type="button"
              title="Supprimer cette option"
            >
              <X size={18} />
            </button>
          </div>
        {/each}
      </div>

      <button
        class="inline-flex items-center gap-2 text-sm text-amber-600 dark:text-amber-500 font-bold hover:text-amber-500 dark:hover:text-amber-400 transition-colors py-2 px-3 ml-6 rounded-lg hover:bg-amber-500/10"
        onclick={addOption}
        type="button"
      >
        <Plus size={18} strokeWidth={2.5} />
        Ajouter {isMatrix ? 'une colonne' : 'une option'}
      </button>

      <!-- Section des Lignes (Uniquement pour les Grilles) -->
      {#if isMatrix}
        <div
          class="mt-8 pt-6 border-t border-dashed border-black/10 dark:border-white/10 space-y-4"
        >
          <h4 class="text-xs font-bold text-text-main uppercase tracking-widest opacity-80 px-2">
            Lignes (Critères à évaluer)
          </h4>

          <div class="space-y-2.5">
            {#each item.rows as row, idx (row.id)}
              <div class="flex gap-3 items-center">
                <span
                  class="text-xs font-mono text-text-muted w-6 text-center shrink-0 pt-2 opacity-60"
                >
                  {idx + 1}.
                </span>
                <div class="flex-1">
                  <Input
                    placeholder="Intitulé de la ligne (ex: Qualité du service)"
                    bind:value={row.value}
                  />
                </div>
                <button
                  class="p-2.5 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-colors shrink-0 mt-1 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                  onclick={() => removeRow(idx)}
                  type="button"
                  title="Supprimer cette ligne"
                >
                  <X size={18} />
                </button>
              </div>
            {/each}
          </div>

          <button
            class="inline-flex items-center gap-2 text-sm text-amber-600 dark:text-amber-500 font-bold hover:text-amber-500 dark:hover:text-amber-400 transition-colors py-2 px-3 ml-6 rounded-lg hover:bg-amber-500/10"
            onclick={addRow}
            type="button"
          >
            <Plus size={18} strokeWidth={2.5} />
            Ajouter une ligne
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
