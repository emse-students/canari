<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import AudienceConditionEditor from './AudienceConditionEditor.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { Trash2, X, Plus, GripVertical, ImagePlus, GitBranch, ChevronDown } from '@lucide/svelte';
  import { QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { m } from '$lib/paraglide/messages';

  let {
    item = $bindable(),
    onRemove,
    showPriceModifier = false,
    pricedByGrid = false,
    questionIndex,
    onMoveUp,
    onMoveDown,
    canMoveUp = false,
    canMoveDown = false,
    allItems = [],
    tiers = [],
    formations = [],
    imageUploadFn = undefined,
  } = $props<{
    item: any;
    onRemove: () => void;
    showPriceModifier?: boolean;
    /**
     * True when the pricing grid discriminates on THIS question's answer. Its per-option modifiers
     * are then hidden rather than shown and ignored: the grid cell already carries the choice, and
     * an input that changes no price is worse than no input.
     */
    pricedByGrid?: boolean;
    questionIndex?: number;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    /** All questions in the form - used for the conditional display picker. */
    allItems?: any[];
    /** Cotisation tiers of the beneficiary association, for the audience condition. */
    tiers?: MembershipTier[];
    /** Formation values in use, for the audience condition. */
    formations?: FormationOption[];
    /** If provided, enables image upload for this question. */
    imageUploadFn?: (file: File) => Promise<string>;
  }>();

  let showTypePicker = $state(false);

  const isMatrix = $derived(['matrix_single', 'matrix_multiple'].includes(item.type));
  const hasOptions = $derived(!['short_text', 'long_text', 'linear_scale'].includes(item.type));

  const fieldClass =
    'w-full min-w-0 px-3 py-2.5 sm:px-4 sm:py-3 border-2 border-cn-border sm:border-black/10 dark:sm:border-white/10 rounded-xl sm:rounded-2xl text-sm sm:text-base text-text-main bg-(--cn-surface) outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]';

  function addOption() {
    if (!item.options) item.options = [];
    item.options = [
      ...item.options,
      {
        id: crypto.randomUUID(),
        label: '',
        priceModifier: undefined,
      },
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

  /**
   * The options of a given question, as `{ id, label }`.
   *
   * The ID is what `dependsValue` stores, because that is what an answer holds - this returned bare
   * LABELS and bound them into `dependsValue`, so every condition compared a label against an id and
   * no conditional question had ever displayed. Nothing was stored to migrate.
   */
  function getOptions(questionId: string): { id: string; label: string }[] {
    const q = allItems.find((item: any) => item.id === questionId);
    return (q?.options ?? [])
      .filter((o: any) => o.id && o.label)
      .map((o: any) => ({ id: o.id, label: o.label }));
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
      imageUploadError = err.message || 'Error';
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }
</script>

<div
  class="group relative w-full min-w-0 rounded-xl border border-black/5 bg-white/40 p-3 shadow-sm backdrop-blur-xl transition-all duration-300 sm:rounded-[2rem] sm:p-5 sm:hover:border-amber-500/30 sm:hover:shadow-md md:p-6 dark:border-white/10 dark:bg-black/20"
>
  <!-- Action bar (mobile: reorder + delete) -->
  <div class="mb-3 flex items-center justify-between gap-2 sm:mb-4">
    <div class="flex min-w-0 items-center gap-2">
      {#if questionIndex != null}
        <span
          class="shrink-0 rounded-md bg-amber-500/10 px-2 py-0.5 text-[0.65rem] font-extrabold tracking-wider text-amber-600 uppercase dark:text-amber-400"
        >
          Q{questionIndex}
        </span>
      {/if}
      <GripVertical
        size={16}
        class="text-text-muted/50 hidden shrink-0 cursor-grab active:cursor-grabbing sm:block"
        aria-hidden="true"
      />
    </div>
    <div class="flex shrink-0 items-center gap-0.5">
      {#if onMoveUp && onMoveDown}
        <button
          type="button"
          onclick={onMoveUp}
          disabled={!canMoveUp}
          class="text-text-muted hover:text-text-main rounded-lg p-2 transition-colors hover:bg-black/5 disabled:opacity-25 sm:hidden dark:hover:bg-white/10"
          title={m.form_builder_move_up_title()}
          aria-label={m.form_builder_move_up_aria()}
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
          class="text-text-muted hover:text-text-main rounded-lg p-2 transition-colors hover:bg-black/5 disabled:opacity-25 sm:hidden dark:hover:bg-white/10"
          title={m.form_builder_move_down_title()}
          aria-label={m.form_builder_move_down_aria()}
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
        class="text-text-muted rounded-lg p-2 transition-colors outline-none hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
        onclick={onRemove}
        type="button"
        title={m.form_builder_delete_title()}
        aria-label={m.form_builder_delete_aria()}
      >
        <Trash2 size={18} />
      </button>
    </div>
  </div>

  <!-- Label + type -->
  <div class="mb-4 grid grid-cols-1 gap-3 sm:mb-6 sm:gap-5 md:grid-cols-12">
    <div class="min-w-0 md:col-span-7">
      <Input
        label={m.form_builder_question_label()}
        bind:value={item.label}
        placeholder={m.form_builder_question_placeholder()}
        class="[&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm sm:[&_input]:px-4 sm:[&_input]:py-3 sm:[&_input]:text-base [&_label]:ml-0"
      />
    </div>
    <div class="min-w-0 md:col-span-5">
      <label
        for="type-picker-{item.id}"
        class="text-text-main mb-1.5 block text-sm font-bold sm:mb-2"
        >{m.form_builder_type_label()}</label
      >
      <div class="relative">
        {#if true}
          {@const cur = QUESTION_TYPES.find((t) => t.value === item.type)}
          <button
            id="type-picker-{item.id}"
            type="button"
            aria-label="{m.form_builder_type_label()}: {cur?.label() ?? item.type}"
            aria-haspopup="listbox"
            aria-expanded={showTypePicker}
            onclick={() => (showTypePicker = !showTypePicker)}
            class="{fieldClass} flex cursor-pointer items-center gap-2 text-left"
          >
            {#if cur}
              {@const CurIcon = cur.Icon}
              <CurIcon size={15} class="text-text-muted shrink-0" />
              <span class="flex-1 truncate">{cur.label()}</span>
            {:else}
              <span class="flex-1">{item.type}</span>
            {/if}
            <ChevronDown size={13} class="text-text-muted/60 shrink-0" />
          </button>
        {/if}
        {#if showTypePicker}
          <div
            role="presentation"
            class="fixed inset-0 z-40"
            onclick={() => (showTypePicker = false)}
            onkeydown={(e) => {
              if (e.key === 'Escape') showTypePicker = false;
            }}
          ></div>
          <div
            class="border-cn-border absolute top-full right-0 left-0 z-50 mt-1 rounded-2xl border-2 bg-(--cn-surface) p-2 shadow-xl"
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
                  class="flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 transition-all {item.type ===
                  qt.value
                    ? 'bg-cn-yellow/15 text-cn-dark font-semibold'
                    : 'hover:bg-cn-yellow/5 text-text-main'}"
                >
                  <QIcon
                    size={14}
                    class="shrink-0 {item.type === qt.value ? 'text-cn-dark' : 'text-text-muted'}"
                  />
                  <span class="min-w-0 text-xs leading-tight font-medium break-words"
                    >{qt.label()}</span
                  >
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Optional description -->
  <div class="mb-4 sm:mb-5">
    {#if item.description !== undefined}
      <div class="relative">
        <Textarea
          bind:value={item.description}
          rows={2}
          placeholder={m.form_builder_desc_placeholder()}
        />
        <button
          type="button"
          onclick={() => {
            item.description = undefined;
          }}
          class="text-text-muted absolute top-1.5 right-1.5 rounded-lg p-1 transition-colors hover:bg-red-500/10 hover:text-red-500"
          title={m.form_builder_remove_desc_title()}><X size={14} /></button
        >
      </div>
    {:else}
      <button
        type="button"
        onclick={() => {
          item.description = '';
        }}
        class="text-text-muted hover:text-text-main flex items-center gap-1 text-xs font-semibold transition-colors"
      >
        <Plus size={12} />
        {m.form_builder_add_desc()}
      </button>
    {/if}
  </div>

  <!-- Optional image -->
  {#if imageUploadFn !== undefined}
    <div class="mb-4 sm:mb-5">
      {#if item.imageUrl}
        <div class="border-cn-border relative overflow-hidden rounded-xl border">
          <img
            src={item.imageUrl}
            alt="Question"
            class="max-h-40 w-full object-cover"
            loading="lazy"
          />
          <button
            type="button"
            onclick={() => {
              item.imageUrl = undefined;
            }}
            class="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
            title={m.form_builder_remove_image_title()}><X size={14} /></button
          >
        </div>
      {:else}
        {#if imageUploadError}
          <p class="mb-1.5 text-xs text-red-500">{imageUploadError}</p>
        {/if}
        <label
          class="border-cn-border text-text-muted hover:border-cn-yellow/50 flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed px-3 py-2.5 text-xs font-semibold transition-colors {uploadingImage
            ? 'pointer-events-none opacity-50'
            : ''}"
        >
          <ImagePlus size={15} class="shrink-0" />
          {uploadingImage ? m.form_builder_image_uploading() : m.form_builder_add_image()}
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

  <!-- Required toggle -->
  <div class="mb-4 flex justify-start sm:mb-6 sm:justify-end">
    <label class="group/toggle flex cursor-pointer items-center gap-2.5 select-none sm:gap-3">
      <span
        class="text-text-muted group-hover/toggle:text-text-main text-xs font-semibold transition-colors sm:text-sm"
      >
        {m.form_builder_required_label()}
      </span>
      <div class="relative flex shrink-0 items-center">
        <input type="checkbox" bind:checked={item.required} class="peer sr-only" />
        <div
          class="h-6 w-11 rounded-full bg-black/10 shadow-inner transition-colors duration-300 peer-checked:bg-amber-500 sm:h-6 sm:w-12 dark:bg-white/10"
        ></div>
        <div
          class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5 sm:peer-checked:translate-x-6"
        ></div>
      </div>
    </label>
  </div>

  <div class="mb-4 h-px w-full bg-black/5 sm:mb-6 dark:bg-white/5"></div>

  {#if ['short_text', 'long_text'].includes(item.type)}
    <div
      class="text-text-muted/80 rounded-xl border border-dashed border-black/10 bg-black/5 p-3 text-center text-xs italic sm:rounded-2xl sm:p-5 sm:text-sm dark:border-white/20 dark:bg-white/5"
    >
      {item.type === 'short_text'
        ? m.form_builder_short_text_hint()
        : m.form_builder_long_text_hint()}
    </div>
  {:else if item.type === 'linear_scale'}
    <div
      class="space-y-4 rounded-xl border border-black/5 bg-white/30 p-3 sm:space-y-5 sm:rounded-2xl sm:p-5 dark:border-white/10 dark:bg-black/20"
    >
      <div class="flex flex-wrap items-center gap-2 sm:gap-4">
        <span class="text-text-main w-full text-sm font-bold sm:w-auto"
          >{m.form_builder_scale_prefix()}</span
        >
        <select bind:value={item.scale.min} class={fieldClass + ' w-auto min-w-[4rem]'}>
          <option value={0} class="bg-white dark:bg-zinc-800">0</option>
          <option value={1} class="bg-white dark:bg-zinc-800">1</option>
        </select>
        <span class="text-text-muted text-xs font-bold uppercase">{m.form_builder_scale_to()}</span>
        <select bind:value={item.scale.max} class={fieldClass + ' w-auto min-w-[4rem]'}>
          {#each Array.from({ length: 9 }, (_, i) => i + 2) as val (val)}
            <option value={val} class="bg-white dark:bg-zinc-800">{val}</option>
          {/each}
        </select>
      </div>
      <div class="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 sm:gap-5 sm:pt-2">
        <Input
          label={m.form_builder_scale_min_label({ min: item.scale.min })}
          bind:value={item.scale.minLabel}
          placeholder={m.form_builder_scale_min_placeholder()}
          class="[&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm [&_label]:ml-0"
        />
        <Input
          label={m.form_builder_scale_max_label({ max: item.scale.max })}
          bind:value={item.scale.maxLabel}
          placeholder={m.form_builder_scale_max_placeholder()}
          class="[&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm [&_label]:ml-0"
        />
      </div>
    </div>
  {:else if hasOptions}
    <div class="space-y-3 sm:space-y-4">
      <div class="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
        <h4 class="text-text-main text-xs font-bold tracking-widest uppercase opacity-80">
          {isMatrix ? m.form_builder_columns_header() : m.form_builder_options_header()}
        </h4>
        {#if !isMatrix && showPriceModifier && !pricedByGrid}
          <div class="text-text-muted flex gap-2 text-[0.65rem] font-semibold sm:text-xs">
            <span class="w-20 text-right">{m.form_builder_price_public_header()}</span>
          </div>
        {/if}
      </div>

      {#if !isMatrix && pricedByGrid}
        <p
          class="border-cn-yellow/40 bg-cn-yellow/5 text-text-muted rounded-xl border px-3 py-2 text-xs"
        >
          {m.form_builder_priced_by_grid()}
        </p>
      {/if}

      <div class="space-y-2 sm:space-y-2.5">
        {#each item.options as opt, idx (opt.id)}
          <div
            class="rounded-xl border border-black/5 bg-black/[0.02] p-2.5 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 dark:border-white/10 dark:bg-white/[0.02]"
          >
            <div class="mb-2 flex items-center justify-between gap-2 sm:hidden">
              <span class="text-text-muted text-[0.65rem] font-bold tracking-wide uppercase">
                {isMatrix
                  ? m.form_builder_column_mobile_label()
                  : m.form_builder_option_mobile_label()}
                {idx + 1}
              </span>
              <button
                class="text-text-muted rounded-lg p-1.5 transition-colors hover:bg-red-500/10 hover:text-red-500"
                onclick={() => removeOption(idx)}
                type="button"
                title={m.common_delete_button()}
                aria-label={m.form_builder_option_remove_aria()}
              >
                <X size={16} />
              </button>
            </div>

            <!-- Desktop: horizontal row -->
            <div class="group/opt hidden items-center gap-2 sm:flex">
              <span class="text-text-muted w-5 shrink-0 text-center font-mono text-xs opacity-60">
                {idx + 1}.
              </span>
              <div class="min-w-0 flex-1">
                <Input
                  placeholder={isMatrix
                    ? m.form_builder_column_placeholder()
                    : m.form_builder_option_placeholder()}
                  bind:value={opt.label}
                />
              </div>
              {#if !isMatrix && showPriceModifier && !pricedByGrid}
                <div class="w-20 shrink-0">
                  <Input
                    type="number"
                    placeholder="0.00"
                    bind:value={opt.priceModifier}
                    step="0.01"
                  />
                </div>
              {/if}
              <button
                class="text-text-muted shrink-0 rounded-xl p-2 transition-colors hover:bg-red-500/10 hover:text-red-500"
                onclick={() => removeOption(idx)}
                type="button"
                title={m.form_builder_option_remove_aria()}
              >
                <X size={18} />
              </button>
            </div>

            <!-- Mobile: full-width field -->
            <div class="space-y-2 sm:hidden">
              <input
                type="text"
                bind:value={opt.label}
                placeholder={isMatrix
                  ? m.form_builder_column_placeholder()
                  : m.form_builder_option_placeholder()}
                class={fieldClass}
              />
              {#if !isMatrix && showPriceModifier && !pricedByGrid}
                <div>
                  <label
                    for="opt-price-{opt.id}"
                    class="text-text-muted mb-1 block text-[0.65rem] font-bold"
                    >{m.form_builder_price_public_mobile()}</label
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
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <button
        class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-amber-500/30 px-3 py-2.5 text-sm font-bold text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-500 sm:w-auto sm:justify-start sm:border-0 sm:py-2 dark:text-amber-500 dark:hover:text-amber-400"
        onclick={addOption}
        type="button"
      >
        <Plus size={18} strokeWidth={2.5} />
        {isMatrix ? m.form_builder_add_column() : m.form_builder_add_option()}
      </button>

      {#if isMatrix}
        <div
          class="mt-5 space-y-3 border-t border-dashed border-black/10 pt-4 sm:mt-8 sm:space-y-4 sm:pt-6 dark:border-white/10"
        >
          <h4 class="text-text-main text-xs font-bold tracking-widest uppercase opacity-80">
            {m.form_builder_rows_header()}
          </h4>

          <div class="space-y-2 sm:space-y-2.5">
            {#each item.rows as row, idx (row.id)}
              <div
                class="rounded-xl border border-black/5 bg-black/[0.02] p-2.5 sm:border-0 sm:bg-transparent sm:p-0 dark:border-white/10 dark:bg-white/[0.02]"
              >
                <div class="mb-2 flex items-center justify-between gap-2 sm:hidden">
                  <span class="text-text-muted text-[0.65rem] font-bold tracking-wide uppercase">
                    {m.form_builder_row_mobile_label({ idx: idx + 1 })}
                  </span>
                  <button
                    class="text-text-muted rounded-lg p-1.5 transition-colors hover:bg-red-500/10 hover:text-red-500"
                    onclick={() => removeRow(idx)}
                    type="button"
                    title={m.common_delete_button()}
                    aria-label={m.form_builder_row_remove_aria()}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div class="hidden items-center gap-2 sm:flex">
                  <span
                    class="text-text-muted w-5 shrink-0 text-center font-mono text-xs opacity-60"
                  >
                    {idx + 1}.
                  </span>
                  <div class="min-w-0 flex-1">
                    <Input placeholder={m.form_builder_row_placeholder()} bind:value={row.value} />
                  </div>
                  <button
                    class="text-text-muted shrink-0 rounded-xl p-2 transition-colors hover:bg-red-500/10 hover:text-red-500"
                    onclick={() => removeRow(idx)}
                    type="button"
                    title={m.form_builder_row_remove_aria()}
                  >
                    <X size={18} />
                  </button>
                </div>
                <input
                  type="text"
                  bind:value={row.value}
                  placeholder={m.form_builder_row_placeholder()}
                  class="{fieldClass} sm:hidden"
                />
              </div>
            {/each}
          </div>

          <button
            class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-amber-500/30 px-3 py-2.5 text-sm font-bold text-amber-600 transition-colors hover:bg-amber-500/10 sm:w-auto sm:justify-start sm:border-0 sm:py-2 dark:text-amber-500"
            onclick={addRow}
            type="button"
          >
            <Plus size={18} strokeWidth={2.5} />
            {m.form_builder_add_row()}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Conditional logic -->
  {#if eligibleConditionSources.length > 0}
    <div class="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
      <div class="mb-2 flex items-center gap-1.5">
        <GitBranch size={13} class="text-text-muted/70 shrink-0" />
        <span class="text-text-muted text-[0.65rem] font-bold tracking-wider uppercase"
          >{m.form_builder_conditional_label()}</span
        >
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select
          bind:value={item.dependsOn}
          class="border-cn-border text-text-main focus:border-cn-yellow min-w-0 flex-1 rounded-xl border-2 bg-(--cn-surface) px-3 py-2 text-xs transition-all outline-none"
          onchange={() => {
            item.dependsValue = '';
          }}
        >
          <option value="">{m.form_builder_always_show()}</option>
          {#each eligibleConditionSources as src (src.id)}
            <option value={src.id}
              >{src.label ||
                `Question ${allItems.findIndex((q: any) => q.id === src.id) + 1}`}</option
            >
          {/each}
        </select>
        {#if item.dependsOn}
          <span class="text-text-muted shrink-0 text-xs">=</span>
          <select
            bind:value={item.dependsValue}
            class="border-cn-border text-text-main focus:border-cn-yellow min-w-0 flex-1 rounded-xl border-2 bg-(--cn-surface) px-3 py-2 text-xs transition-all outline-none"
          >
            <option value="">{m.form_builder_condition_value_placeholder()}</option>
            {#each getOptions(item.dependsOn) as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Audience condition: shown to some people only. -->
  <div class="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
    <Toggle
      label={m.form_show_if_toggle()}
      hint={m.form_show_if_hint()}
      bind:checked={
        () => item.showIf != null,
        (on) => {
          item.showIf = on ? {} : null;
        }
      }
    />
    {#if item.showIf != null}
      <div class="mt-3">
        <AudienceConditionEditor bind:condition={item.showIf} {tiers} {formations} />
      </div>
    {/if}
  </div>
</div>
