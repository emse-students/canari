<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { Trash2, X, Plus, GripVertical, ImagePlus, GitBranch, ChevronDown } from '@lucide/svelte';
  import { QUESTION_TYPES } from '$lib/forms/questionTypes';

  let {
    item = $bindable(),
    onRemove,
    showPriceModifier = false,
    showMemberPriceModifier = false,
    questionIndex,
    onMoveUp,
    onMoveDown,
    canMoveUp = false,
    canMoveDown = false,
    allItems = [],
    imageUploadFn = undefined,
  } = $props<{
    item: any;
    onRemove: () => void;
    showPriceModifier?: boolean;
    /** Second price column for cotisant pricing when `pricingTagName` is set on the form. */
    showMemberPriceModifier?: boolean;
    questionIndex?: number;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    /** All questions in the form - used for the conditional display picker. */
    allItems?: any[];
    /** If provided, enables image upload for this question. */
    imageUploadFn?: (file: File) => Promise<string>;
  }>();

  let showTypePicker = $state(false);

  const isMatrix = $derived(['matrix_single', 'matrix_multiple'].includes(item.type));
  const hasOptions = $derived(!['short_text', 'long_text', 'linear_scale'].includes(item.type));

  const fieldClass =
    'w-full min-w-0 px-3 py-2.5 sm:px-4 sm:py-3 border-2 border-cn-border sm:border-black/10 dark:sm:border-white/10 rounded-xl sm:rounded-2xl text-sm sm:text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]';

  function addOption() {
    if (!item.options) item.options = [];
    item.options = [
      ...item.options,
      { id: crypto.randomUUID(), label: '', priceModifier: undefined, priceModifierMember: undefined },
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

  if (!item.scale) item.scale = { min: 1, max: 5 };
  if (!item.options) item.options = [];
  item.options = item.options.map((opt: any) => ({ ...opt, id: opt.id || crypto.randomUUID() }));
  if (!item.rows) item.rows = [];
  item.rows = item.rows.map((row: any) =>
    typeof row === 'string'
      ? { id: crypto.randomUUID(), value: row }
      : { ...row, id: row.id || crypto.randomUUID() }
  );

  // Questions eligible as a condition source: previous questions of choice type
  const eligibleConditionSources = $derived(
    allItems
      .slice(0, (questionIndex ?? 1) - 1)
      .filter((q: any) => ['single_choice', 'dropdown', 'multiple_choice'].includes(q.type))
  );

  /** Returns the option labels of a given question (by id). */
  function getOptionLabels(questionId: string): string[] {
    const q = allItems.find((q: any) => q.id === questionId);
    return (q?.options ?? []).map((o: any) => o.label).filter(Boolean);
  }

  let uploadingImage = $state(false);
  let imageUploadError = $state('');

  async function handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !imageUploadFn) return;
    uploadingImage = true;
    imageUploadError = '';
    try {
      item.imageUrl = await imageUploadFn(file);
    } catch (err: any) {
      imageUploadError = err.message || "Erreur lors de l'envoi";
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }
</script>

<div
  class="relative w-full min-w-0 p-3 sm:p-5 md:p-6 bg-white/40 dark:bg-black/20 backdrop-blur-xl rounded-xl sm:rounded-[2rem] border border-black/5 dark:border-white/10 shadow-sm transition-all duration-300 sm:hover:shadow-md sm:hover:border-amber-500/30 group"
>
  <!-- Barre d’actions (mobile : réordonner + supprimer) -->
  <div class="flex items-center justify-between gap-2 mb-3 sm:mb-4">
    <div class="flex items-center gap-2 min-w-0">
      {#if questionIndex != null}
        <span
          class="shrink-0 text-[0.65rem] font-extrabold uppercase tracking-wider text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md"
        >
          Q{questionIndex}
        </span>
      {/if}
      <GripVertical
        size={16}
        class="text-text-muted/50 shrink-0 hidden sm:block cursor-grab active:cursor-grabbing"
        aria-hidden="true"
      />
    </div>
    <div class="flex items-center gap-0.5 shrink-0">
      {#if onMoveUp && onMoveDown}
        <button
          type="button"
          onclick={onMoveUp}
          disabled={!canMoveUp}
          class="p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-25 transition-colors sm:hidden"
          title="Monter"
          aria-label="Monter la question"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg
          >
        </button>
        <button
          type="button"
          onclick={onMoveDown}
          disabled={!canMoveDown}
          class="p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-25 transition-colors sm:hidden"
          title="Descendre"
          aria-label="Descendre la question"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
          >
        </button>
      {/if}
      <button
        class="p-2 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 outline-none"
        onclick={onRemove}
        type="button"
        title="Supprimer cette question"
        aria-label="Supprimer la question"
      >
        <Trash2 size={18} />
      </button>
    </div>
  </div>

  <!-- Intitulé + type -->
  <div class="grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-5 mb-4 sm:mb-6">
    <div class="md:col-span-7 min-w-0">
      <Input
        label="Intitulé de la question"
        bind:value={item.label}
        placeholder="Ex: Que pensez-vous de cet événement ?"
        class="[&_label]:ml-0 [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm sm:[&_input]:px-4 sm:[&_input]:py-3 sm:[&_input]:text-base"
      />
    </div>
    <div class="md:col-span-5 min-w-0">
      <label for="type-picker-{item.id}" class="block text-sm font-bold text-text-main mb-1.5 sm:mb-2">Type de réponse</label>
      <div class="relative">
        {#if true}
          {@const cur = QUESTION_TYPES.find((t) => t.value === item.type)}
          <button
            id="type-picker-{item.id}"
            type="button"
            aria-label="Type de réponse : {cur?.label ?? item.type}"
            aria-haspopup="listbox"
            aria-expanded={showTypePicker}
            onclick={() => (showTypePicker = !showTypePicker)}
            class="{fieldClass} flex items-center gap-2 text-left cursor-pointer"
          >
            {#if cur}
              {@const CurIcon = cur.Icon}
              <CurIcon size={15} class="shrink-0 text-text-muted" />
              <span class="flex-1 truncate">{cur.label}</span>
            {:else}
              <span class="flex-1">{item.type}</span>
            {/if}
            <ChevronDown size={13} class="shrink-0 text-text-muted/60" />
          </button>
        {/if}
        {#if showTypePicker}
          <div role="presentation" class="fixed inset-0 z-40" onclick={() => (showTypePicker = false)} onkeydown={(e) => { if (e.key === 'Escape') showTypePicker = false; }}></div>
          <div
            class="absolute top-full left-0 right-0 mt-1 z-50 rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] shadow-xl p-2"
          >
            <div class="grid grid-cols-2 gap-1">
              {#each QUESTION_TYPES as qt (qt.value)}
                {@const QIcon = qt.Icon}
                <button
                  type="button"
                  onclick={() => {
                    item.type = qt.value;
                    showTypePicker = false;
                  }}
                  class="flex items-center gap-2 px-3 py-2 rounded-xl transition-all {item.type ===
                  qt.value
                    ? 'bg-cn-yellow/15 text-cn-dark font-semibold'
                    : 'hover:bg-cn-yellow/5 text-text-main'}"
                >
                  <QIcon
                    size={14}
                    class="shrink-0 {item.type === qt.value ? 'text-cn-dark' : 'text-text-muted'}"
                  />
                  <span class="text-xs font-medium leading-tight">{qt.label}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Description optionnelle -->
  <div class="mb-4 sm:mb-5">
    {#if item.description !== undefined}
      <div class="relative">
        <Textarea
          bind:value={item.description}
          rows={2}
          placeholder="Texte d'aide ou précisions pour le répondant…"
        />
        <button
          type="button"
          onclick={() => {
            item.description = undefined;
          }}
          class="absolute top-1.5 right-1.5 p-1 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
          title="Supprimer la description"><X size={14} /></button
        >
      </div>
    {:else}
      <button
        type="button"
        onclick={() => {
          item.description = '';
        }}
        class="text-xs font-semibold text-text-muted hover:text-text-main transition-colors flex items-center gap-1"
      >
        <Plus size={12} />
        Ajouter une description
      </button>
    {/if}
  </div>

  <!-- Image optionnelle -->
  {#if imageUploadFn !== undefined}
    <div class="mb-4 sm:mb-5">
      {#if item.imageUrl}
        <div class="relative rounded-xl overflow-hidden border border-cn-border">
          <img src={item.imageUrl} alt="Question" class="w-full max-h-40 object-cover" loading="lazy" />
          <button
            type="button"
            onclick={() => {
              item.imageUrl = undefined;
            }}
            class="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
            title="Supprimer l'image"><X size={14} /></button
          >
        </div>
      {:else}
        {#if imageUploadError}
          <p class="text-xs text-red-500 mb-1.5">{imageUploadError}</p>
        {/if}
        <label
          class="flex items-center gap-2 cursor-pointer rounded-xl border-2 border-dashed border-cn-border px-3 py-2.5 text-xs font-semibold text-text-muted hover:border-cn-yellow/50 transition-colors {uploadingImage
            ? 'opacity-50 pointer-events-none'
            : ''}"
        >
          <ImagePlus size={15} class="shrink-0" />
          {uploadingImage ? 'Envoi en cours…' : 'Ajouter une image à la question'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="sr-only"
            disabled={uploadingImage}
            onchange={handleImageUpload}
          />
        </label>
      {/if}
    </div>
  {/if}

  <!-- Obligatoire -->
  <div class="mb-4 sm:mb-6 flex justify-start sm:justify-end">
    <label class="flex items-center gap-2.5 sm:gap-3 cursor-pointer select-none group/toggle">
      <span
        class="text-xs sm:text-sm font-semibold text-text-muted group-hover/toggle:text-text-main transition-colors"
      >
        Question obligatoire
      </span>
      <div class="relative flex items-center shrink-0">
        <input type="checkbox" bind:checked={item.required} class="peer sr-only" />
        <div
          class="w-11 h-6 sm:w-12 sm:h-6 bg-black/10 dark:bg-white/10 rounded-full peer-checked:bg-amber-500 shadow-inner transition-colors duration-300"
        ></div>
        <div
          class="absolute left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 peer-checked:translate-x-5 sm:peer-checked:translate-x-6"
        ></div>
      </div>
    </label>
  </div>

  <div class="w-full h-px bg-black/5 dark:bg-white/5 mb-4 sm:mb-6"></div>

  {#if ['short_text', 'long_text'].includes(item.type)}
    <div
      class="p-3 sm:p-5 bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/20 rounded-xl sm:rounded-2xl text-xs sm:text-sm text-text-muted/80 italic text-center"
    >
      L'utilisateur verra un champ
      <span class="font-semibold text-text-muted">
        {item.type === 'short_text' ? 'court (une ligne)' : 'long (multiligne)'}
      </span>
    </div>
  {:else if item.type === 'linear_scale'}
    <div
      class="p-3 sm:p-5 bg-white/30 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-xl sm:rounded-2xl space-y-4 sm:space-y-5"
    >
      <div class="flex flex-wrap items-center gap-2 sm:gap-4">
        <span class="text-sm font-bold text-text-main w-full sm:w-auto">Échelle de :</span>
        <select bind:value={item.scale.min} class={fieldClass + ' w-auto min-w-[4rem]'}>
          <option value={0} class="bg-white dark:bg-zinc-800">0</option>
          <option value={1} class="bg-white dark:bg-zinc-800">1</option>
        </select>
        <span class="text-xs text-text-muted uppercase font-bold">à</span>
        <select bind:value={item.scale.max} class={fieldClass + ' w-auto min-w-[4rem]'}>
          {#each Array.from({ length: 9 }, (_, i) => i + 2) as val (val)}
            <option value={val} class="bg-white dark:bg-zinc-800">{val}</option>
          {/each}
        </select>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5 pt-1 sm:pt-2">
        <Input
          label={`Légende note ${item.scale.min} (opt.)`}
          bind:value={item.scale.minLabel}
          placeholder="Ex: Pas du tout d'accord"
          class="[&_label]:ml-0 [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm"
        />
        <Input
          label={`Légende note ${item.scale.max} (opt.)`}
          bind:value={item.scale.maxLabel}
          placeholder="Ex: Tout à fait d'accord"
          class="[&_label]:ml-0 [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm"
        />
      </div>
    </div>
  {:else if hasOptions}
    <div class="space-y-3 sm:space-y-4">
      <div class="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-0.5">
        <h4 class="text-xs font-bold text-text-main uppercase tracking-widest opacity-80">
          {isMatrix ? 'Colonnes (choix possibles)' : 'Options de réponse'}
        </h4>
        {#if !isMatrix && showPriceModifier}
          <div class="flex gap-2 text-[0.65rem] sm:text-xs text-text-muted font-semibold">
            <span class="w-20 text-right">Public (€)</span>
            {#if showMemberPriceModifier}
              <span class="w-20 text-right">Cotisant (€)</span>
            {/if}
          </div>
        {/if}
      </div>

      <div class="space-y-2 sm:space-y-2.5">
        {#each item.options as opt, idx (opt.id)}
          <div
            class="rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-2.5 sm:p-0 sm:border-0 sm:bg-transparent sm:rounded-none"
          >
            <div class="flex items-center justify-between gap-2 mb-2 sm:hidden">
              <span class="text-[0.65rem] font-bold uppercase tracking-wide text-text-muted">
                {isMatrix ? 'Colonne' : 'Option'}
                {idx + 1}
              </span>
              <button
                class="p-1.5 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                onclick={() => removeOption(idx)}
                type="button"
                title="Supprimer"
                aria-label="Supprimer l'option"
              >
                <X size={16} />
              </button>
            </div>

            <!-- Desktop : ligne horizontale -->
            <div class="hidden sm:flex gap-2 items-center group/opt">
              <span class="text-xs font-mono text-text-muted w-5 text-center shrink-0 opacity-60">
                {idx + 1}.
              </span>
              <div class="flex-1 min-w-0">
                <Input
                  placeholder={isMatrix ? 'Intitulé de la colonne' : "Intitulé de l'option"}
                  bind:value={opt.label}
                />
              </div>
              {#if !isMatrix && showPriceModifier}
                <div class="w-20 shrink-0">
                  <Input
                    type="number"
                    placeholder="0.00"
                    bind:value={opt.priceModifier}
                    step="0.01"
                  />
                </div>
                {#if showMemberPriceModifier}
                  <div class="w-20 shrink-0">
                    <Input
                      type="number"
                      placeholder="0.00"
                      bind:value={opt.priceModifierMember}
                      step="0.01"
                    />
                  </div>
                {/if}
              {/if}
              <button
                class="p-2 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-colors shrink-0"
                onclick={() => removeOption(idx)}
                type="button"
                title="Supprimer cette option"
              >
                <X size={18} />
              </button>
            </div>

            <!-- Mobile : champ pleine largeur -->
            <div class="sm:hidden space-y-2">
              <input
                type="text"
                bind:value={opt.label}
                placeholder={isMatrix ? 'Intitulé de la colonne' : "Intitulé de l'option"}
                class={fieldClass}
              />
              {#if !isMatrix && showPriceModifier}
                <div>
                  <label
                    for="opt-price-{opt.id}"
                    class="block text-[0.65rem] font-bold text-text-muted mb-1"
                    >Supplément public (€)</label
                  >
                  <input
                    id="opt-price-{opt.id}"
                    type="number"
                    bind:value={opt.priceModifier}
                    step="0.01"
                    placeholder="0.00"
                    class={fieldClass}
                  />
                </div>
                {#if showMemberPriceModifier}
                  <div>
                    <label
                      for="opt-price-member-{opt.id}"
                      class="block text-[0.65rem] font-bold text-text-muted mb-1"
                      >Supplément cotisant (€)</label
                    >
                    <input
                      id="opt-price-member-{opt.id}"
                      type="number"
                      bind:value={opt.priceModifierMember}
                      step="0.01"
                      placeholder="0.00"
                      class={fieldClass}
                    />
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <button
        class="w-full sm:w-auto inline-flex items-center justify-center sm:justify-start gap-2 text-sm text-amber-600 dark:text-amber-500 font-bold hover:text-amber-500 dark:hover:text-amber-400 transition-colors py-2.5 sm:py-2 px-3 rounded-xl hover:bg-amber-500/10 border border-dashed border-amber-500/30 sm:border-0"
        onclick={addOption}
        type="button"
      >
        <Plus size={18} strokeWidth={2.5} />
        Ajouter {isMatrix ? 'une colonne' : 'une option'}
      </button>

      {#if isMatrix}
        <div
          class="mt-5 sm:mt-8 pt-4 sm:pt-6 border-t border-dashed border-black/10 dark:border-white/10 space-y-3 sm:space-y-4"
        >
          <h4 class="text-xs font-bold text-text-main uppercase tracking-widest opacity-80">
            Lignes (critères à évaluer)
          </h4>

          <div class="space-y-2 sm:space-y-2.5">
            {#each item.rows as row, idx (row.id)}
              <div
                class="rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-2.5 sm:p-0 sm:border-0 sm:bg-transparent"
              >
                <div class="flex items-center justify-between gap-2 mb-2 sm:hidden">
                  <span class="text-[0.65rem] font-bold uppercase tracking-wide text-text-muted">
                    Ligne {idx + 1}
                  </span>
                  <button
                    class="p-1.5 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                    onclick={() => removeRow(idx)}
                    type="button"
                    title="Supprimer"
                    aria-label="Supprimer la ligne"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div class="hidden sm:flex gap-2 items-center">
                  <span
                    class="text-xs font-mono text-text-muted w-5 text-center shrink-0 opacity-60"
                  >
                    {idx + 1}.
                  </span>
                  <div class="flex-1 min-w-0">
                    <Input
                      placeholder="Intitulé de la ligne (ex: Qualité du service)"
                      bind:value={row.value}
                    />
                  </div>
                  <button
                    class="p-2 text-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-colors shrink-0"
                    onclick={() => removeRow(idx)}
                    type="button"
                    title="Supprimer cette ligne"
                  >
                    <X size={18} />
                  </button>
                </div>
                <input
                  type="text"
                  bind:value={row.value}
                  placeholder="Intitulé de la ligne (ex: Qualité du service)"
                  class="{fieldClass} sm:hidden"
                />
              </div>
            {/each}
          </div>

          <button
            class="w-full sm:w-auto inline-flex items-center justify-center sm:justify-start gap-2 text-sm text-amber-600 dark:text-amber-500 font-bold transition-colors py-2.5 sm:py-2 px-3 rounded-xl hover:bg-amber-500/10 border border-dashed border-amber-500/30 sm:border-0"
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

  <!-- Logique conditionnelle -->
  {#if eligibleConditionSources.length > 0}
    <div class="mt-4 pt-4 border-t border-black/5 dark:border-white/5">
      <div class="flex items-center gap-1.5 mb-2">
        <GitBranch size={13} class="text-text-muted/70 shrink-0" />
        <span class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wider"
          >Afficher si…</span
        >
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select
          bind:value={item.dependsOn}
          class="flex-1 min-w-0 px-3 py-2 border-2 border-cn-border rounded-xl text-xs text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow"
          onchange={() => {
            item.dependsValue = '';
          }}
        >
          <option value="">Toujours afficher</option>
          {#each eligibleConditionSources as src (src.id)}
            <option value={src.id}
              >{src.label ||
                `Question ${allItems.findIndex((q: any) => q.id === src.id) + 1}`}</option
            >
          {/each}
        </select>
        {#if item.dependsOn}
          <span class="text-xs text-text-muted shrink-0">=</span>
          <select
            bind:value={item.dependsValue}
            class="flex-1 min-w-0 px-3 py-2 border-2 border-cn-border rounded-xl text-xs text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow"
          >
            <option value="">Valeur…</option>
            {#each getOptionLabels(item.dependsOn) as label (label)}
              <option value={label}>{label}</option>
            {/each}
          </select>
        {/if}
      </div>
    </div>
  {/if}
</div>
