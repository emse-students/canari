<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import AudienceConditionEditor from './AudienceConditionEditor.svelte';
  import ProductGridEditor from './ProductGridEditor.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { associationLogoSrc, type MembershipTier } from '$lib/associations/api';
  import { QUESTION_IMAGE_ACCEPT, questionImageUploadError } from '$lib/forms/questionImage';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import {
    ArrowDown,
    ArrowUp,
    Asterisk,
    ChevronDown,
    ChevronUp,
    Copy,
    GitBranch,
    GripVertical,
    ImagePlus,
    Plus,
    Trash2,
    Users,
    X,
  } from '@lucide/svelte';
  import { AUTHORABLE_QUESTION_TYPES, QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { duplicateLabels, gridRowLabels } from '$lib/forms/answerBounds';
  import { PRODUCT_GRID_TYPE } from '$lib/forms/productGridContract';
  import { newProductGrid, type ProductGridTierDimension } from '$lib/forms/productGridEditor';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

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
    fileHint = undefined,
    expanded = false,
    selectTitleOnOpen = false,
    onExpand,
    onCollapse,
    onDuplicate,
    authorableTypes = AUTHORABLE_QUESTION_TYPES,
    onBecamePricedGrid,
    onLeftPricedGrid,
    formTiers = null,
    orderedCells = [],
    isPublic = false,
    gridProblem = null,
  }: {
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
    /** What the editor says a FILE question does - who reads the file, when it goes. Defaults to a form's. */
    fileHint?: string;
    /** Only one card is expanded at a time: the list owns which, this card draws it. */
    expanded?: boolean;
    /** The copy of a question opens with its title selected, so typing replaces it. */
    selectTitleOnOpen?: boolean;
    /** The row was activated (click, Enter, Space). */
    onExpand?: () => void;
    /** Escape, or the collapse button. */
    onCollapse?: () => void;
    /** The duplicate icon or Ctrl/Cmd+D. */
    onDuplicate?: () => void;
    /** The types the type menu offers (a builder with no payment leaves the priced grid out). */
    authorableTypes?: typeof AUTHORABLE_QUESTION_TYPES;
    /** The question just became a priced grid: the page switches several answers on. */
    onBecamePricedGrid?: () => void;
    /** The question was a priced grid and is now another type: the page may undo what adding it did. */
    onLeftPricedGrid?: () => void;
    /** A priced grid's one-click criterion: the registration price grid's profile criterion. */
    formTiers?: ProductGridTierDimension | null;
    /** A priced grid's cells already ordered in an answer (removing their row or column warns). */
    orderedCells?: string[];
    /** A public form: a priced grid's guest pays "everyone else". */
    isPublic?: boolean;
    /** The sentence of a refused save about this priced grid. */
    gridProblem?: string | null;
  } = $props();

  /** Apple platforms use Cmd for shortcuts; read once, a platform does not change. */
  const IS_APPLE =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  let showTypePicker = $state(false);
  let titleEl = $state<HTMLInputElement | null>(null);
  let rowButtonEl = $state<HTMLButtonElement | null>(null);
  /** Set when the card collapses from the keyboard, so focus lands on its row and not on the page. */
  let restoreRowFocus = false;
  let wasExpanded = false;

  // Opening a card moves focus to its title; closing it from the keyboard returns focus to its row.
  $effect(() => {
    if (expanded && !wasExpanded) {
      titleEl?.focus();
      if (selectTitleOnOpen) titleEl?.select();
    } else if (!expanded && wasExpanded && restoreRowFocus) {
      rowButtonEl?.focus();
    }
    restoreRowFocus = false;
    wasExpanded = expanded;
  });

  /** Ctrl/Cmd+D duplicates (the browser's bookmark shortcut is cancelled); Escape collapses. */
  function onCardKeydown(e: KeyboardEvent) {
    // Cmd on Apple platforms, Ctrl elsewhere - never both, so Ctrl+D on a Mac stays the OS's.
    const modifier = IS_APPLE ? e.metaKey : e.ctrlKey;
    if (modifier && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
      // The browser's bookmark shortcut is cancelled even for an auto-repeat, which copies nothing.
      e.preventDefault();
      if (!e.repeat) onDuplicate?.();
    } else if (e.key === 'Escape' && expanded && !e.defaultPrevented) {
      if (showTypePicker) {
        showTypePicker = false;
        e.stopPropagation();
        return;
      }
      restoreRowFocus = true;
      onCollapse?.();
    }
  }

  const currentType = $derived(QUESTION_TYPES.find((t) => t.value === item.type));
  /** The audience panel is open exactly when the condition is switched on. */
  const conditionsOn = $derived(item.showIf != null);
  function toggleConditions() {
    item.showIf = conditionsOn ? null : {};
  }

  const isMatrix = $derived(['matrix_single', 'matrix_multiple'].includes(item.type));
  // A grid answer is keyed by its row label, so two rows of one label are one answer (D4): marked
  // here as it is typed, refused by the page before the save and by the server at it.
  const duplicateRows = $derived(
    isMatrix ? duplicateLabels(gridRowLabels(item.rows)) : new Set<string>()
  );
  const duplicateColumns = $derived(
    isMatrix
      ? duplicateLabels(
          (item.options ?? [])
            .filter((o: any) => o.label?.trim())
            .map((o: any) => o.label as string)
        )
      : new Set<string>()
  );
  // A DENYLIST: every type not named here gets the options editor. A type with no options (a file
  // included) must be added, or its card grows an options list it will never use.
  const hasOptions = $derived(
    !['short_text', 'long_text', 'linear_scale', 'file', PRODUCT_GRID_TYPE].includes(item.type)
  );
  /** A priced grid is always required (its order is the answer): the asterisk is not a choice. */
  const isPricedGrid = $derived(item.type === PRODUCT_GRID_TYPE);

  /** Turns the question into a priced grid: its definition, required, and the page told. */
  function becomePricedGrid() {
    if (!item.productGrid) item.productGrid = newProductGrid();
    item.required = true;
    onBecamePricedGrid?.();
  }

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

  if (item.type === PRODUCT_GRID_TYPE && !item.productGrid) item.productGrid = newProductGrid();
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

  /** A linear scale starts at 0 or 1. */
  const SCALE_MIN_OPTIONS: PickerOption[] = [0, 1].map((v) => ({
    value: String(v),
    label: String(v),
  }));
  /** ...and ends anywhere from 2 to 10. */
  const SCALE_MAX_OPTIONS: PickerOption[] = Array.from({ length: 9 }, (_, i) => i + 2).map((v) => ({
    value: String(v),
    label: String(v),
  }));

  /** The two scale pickers wear the question's own field box, sized to their content. */
  const scaleTriggerClass = `${fieldClass} w-auto min-w-[4rem] flex items-center justify-between gap-2 text-left`;

  /** The two condition pickers: a compact box sharing the row. */
  const conditionTriggerClass =
    'border-cn-border text-text-main focus:border-cn-yellow flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border-2 bg-(--cn-surface) px-3 py-2 text-left text-xs transition-all outline-none';

  /** "Always show", then every question this one may depend on. */
  const conditionSourceOptions = $derived<PickerOption[]>([
    { value: '', label: m.form_builder_always_show() },
    ...eligibleConditionSources.map((src: any) => ({
      value: src.id,
      label:
        src.label ||
        m.form_builder_untitled_question({
          n: allItems.findIndex((q: any) => q.id === src.id) + 1,
        }),
    })),
  ]);

  /** "Value..." (no value yet), then the answers of the question this one depends on, by id. */
  const conditionValueOptions = $derived<PickerOption[]>([
    { value: '', label: m.form_builder_condition_value_placeholder() },
    ...(item.dependsOn
      ? getOptions(item.dependsOn).map((o) => ({ value: o.id, label: o.label }))
      : []),
  ]);

  let uploadingImage = $state(false);
  let imageUploadError = $state('');

  /**
   * Uploads the picked file as this question's image - a first one or a replacement. The old image
   * is not deleted here: the server releases it once the SAVE leaves no question citing it.
   */
  async function handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !imageUploadFn) return;
    Log.d('FORMS', `question image: upload ${file.type} ${file.size} bytes`);
    uploadingImage = true;
    imageUploadError = '';
    try {
      item.imageUrl = await imageUploadFn(file);
    } catch (err) {
      Log.i('FORMS', `question image: upload refused - ${String(err)}`);
      imageUploadError = questionImageUploadError(err);
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group bg-cn-surface relative w-full min-w-0 rounded-xl border border-black/5 shadow-sm transition-all duration-150 sm:rounded-lg dark:border-white/10 {expanded
    ? 'border-cn-yellow/50 p-3 sm:p-4'
    : 'px-1.5 py-0.5 sm:hover:border-amber-500/30'}"
  onkeydown={onCardKeydown}
>
  {#if !expanded}
    <!-- Collapsed: one line. The handle and the duplicate icon are their own controls beside the
         one button that expands, so no interactive element sits inside another. -->
    <div class="flex min-w-0 items-center gap-1">
      <!-- The grip is the drag target of a collapsed row (the row itself is a button, which a press
           never drags from): a real 44 x 44 px area, marked as the handle. -->
      <span
        data-drag-handle
        class="text-text-muted/50 hidden min-h-11 w-11 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing sm:flex"
        role="img"
        aria-label={m.form_builder_drag_handle_aria()}
      >
        <GripVertical size={16} aria-hidden="true" />
      </span>
      <button
        bind:this={rowButtonEl}
        data-row-button
        type="button"
        onclick={onExpand}
        aria-label={m.form_builder_open_question_aria({
          n: questionIndex ?? 1,
          title: item.label || m.form_builder_title_placeholder(),
        })}
        class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
      >
        <span
          class="text-text-muted bg-cn-border/50 text-2xs shrink-0 rounded-md px-1.5 py-0.5 font-bold tabular-nums"
          >{questionIndex}</span
        >
        <span
          class="min-w-0 flex-1 truncate text-sm font-semibold {item.label
            ? 'text-text-main'
            : 'text-text-muted/60 italic'}"
          >{item.label || m.form_builder_title_placeholder()}{#if item.required}<span
              class="ml-0.5 text-red-500"
              data-testid="required-mark">*</span
            >{/if}</span
        >
        {#if currentType}
          {@const CurIcon = currentType.Icon}
          <CurIcon size={14} class="text-text-muted shrink-0" />
          <span class="text-text-muted text-2xs hidden shrink-0 font-medium sm:inline"
            >{currentType.label()}</span
          >
        {/if}
      </button>
      <button
        type="button"
        onclick={onDuplicate}
        class="ui-icon-button text-text-muted hover:text-text-main min-h-11 min-w-11 shrink-0 rounded-lg transition-colors outline-none hover:bg-black/5 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-white/10"
        title={m.form_builder_duplicate_title()}
        aria-label={m.form_builder_duplicate_aria()}
      >
        <Copy size={16} />
      </button>
    </div>
  {:else}
    <!-- Title + type: the title is the main field, the type a compact menu beside it. -->
    <div class="mb-3 flex items-center gap-2">
      <span
        data-drag-handle
        class="text-text-muted/50 hidden shrink-0 cursor-grab active:cursor-grabbing sm:block"
        aria-hidden="true"
      >
        <GripVertical size={16} />
      </span>
      <span
        class="text-text-muted bg-cn-border/50 text-2xs shrink-0 rounded-md px-1.5 py-0.5 font-bold tabular-nums"
        >{questionIndex}</span
      >
      <input
        bind:this={titleEl}
        type="text"
        bind:value={item.label}
        aria-label={m.form_builder_question_label()}
        placeholder={m.form_builder_title_placeholder()}
        class="border-cn-border text-text-main placeholder:text-text-muted/50 focus:border-cn-yellow min-w-0 flex-1 border-b-2 bg-transparent px-1 py-1.5 text-base font-semibold outline-none sm:text-lg"
      />
      <div class="relative shrink-0">
        <button
          id="type-picker-{item.id}"
          type="button"
          aria-label="{m.form_builder_type_label()}: {currentType?.label() ?? item.type}"
          aria-haspopup="listbox"
          aria-expanded={showTypePicker}
          onclick={() => (showTypePicker = !showTypePicker)}
          class="border-cn-border text-text-main focus:border-cn-yellow flex cursor-pointer items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-2 py-1.5 text-left text-xs font-medium outline-none"
        >
          {#if currentType}
            {@const CurIcon = currentType.Icon}
            <CurIcon size={15} class="text-text-muted shrink-0" />
            <span class="hidden max-w-32 truncate sm:inline">{currentType.label()}</span>
          {:else}
            <span>{item.type}</span>
          {/if}
          <ChevronDown size={13} class="text-text-muted/60 shrink-0" />
        </button>
        {#if showTypePicker}
          <div
            role="presentation"
            class="fixed inset-0 z-(--z-popover-scrim)"
            onclick={() => (showTypePicker = false)}
          ></div>
          <div
            class="border-cn-border absolute top-full right-0 z-(--z-popover) mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border-2 bg-(--cn-surface) p-2 shadow-xl"
          >
            <div class="grid grid-cols-2 gap-1">
              {#each authorableTypes as qt (qt.value)}
                {@const QIcon = qt.Icon}
                <button
                  type="button"
                  onclick={() => {
                    const wasPricedGrid = item.type === PRODUCT_GRID_TYPE;
                    item.type = qt.value;
                    if (qt.value === PRODUCT_GRID_TYPE) becomePricedGrid();
                    else if (wasPricedGrid) onLeftPricedGrid?.();
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

    <!-- Optional description and image: one row of affordances, each opening its own field -->
    <div class="mb-3 space-y-3">
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
            class="ui-icon-button text-text-muted absolute top-1.5 right-1.5 rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-500"
            title={m.form_builder_remove_desc_title()}
            aria-label={m.form_builder_remove_desc_title()}><X size={14} /></button
          >
        </div>
      {/if}

      {#if item.imageUrl}
        <div class="flex items-start gap-3">
          <img
            src={associationLogoSrc(item.imageUrl) ?? ''}
            alt={m.form_builder_image_preview_alt()}
            class="border-cn-border h-20 w-28 shrink-0 rounded-lg border object-cover"
            loading="lazy"
          />
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <Input
              bind:value={item.imageAlt}
              maxlength={300}
              placeholder={m.form_builder_image_alt_placeholder()}
              aria-label={m.form_builder_image_alt_placeholder()}
            />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              {#if imageUploadFn !== undefined}
                <label
                  class="text-text-muted hover:text-text-main flex cursor-pointer items-center gap-1 text-xs font-semibold whitespace-nowrap transition-colors {uploadingImage
                    ? 'pointer-events-none opacity-50'
                    : ''}"
                >
                  <ImagePlus size={12} />
                  {uploadingImage
                    ? m.form_builder_image_uploading()
                    : m.form_builder_replace_image()}
                  <input
                    type="file"
                    accept={QUESTION_IMAGE_ACCEPT}
                    class="sr-only"
                    disabled={uploadingImage}
                    onchange={handleImageUpload}
                  />
                </label>
              {/if}
              <button
                type="button"
                onclick={() => {
                  item.imageUrl = undefined;
                  item.imageAlt = undefined;
                }}
                class="text-text-muted flex items-center gap-1 text-xs font-semibold whitespace-nowrap transition-colors hover:text-red-500"
              >
                <X size={12} />
                {m.form_builder_remove_image_title()}
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if item.description === undefined || (!item.imageUrl && imageUploadFn !== undefined)}
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          {#if item.description === undefined}
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
          {#if !item.imageUrl && imageUploadFn !== undefined}
            <label
              class="text-text-muted hover:text-text-main flex cursor-pointer items-center gap-1 text-xs font-semibold transition-colors {uploadingImage
                ? 'pointer-events-none opacity-50'
                : ''}"
            >
              <Plus size={12} />
              {uploadingImage ? m.form_builder_image_uploading() : m.form_builder_add_image()}
              <input
                type="file"
                accept={QUESTION_IMAGE_ACCEPT}
                class="sr-only"
                disabled={uploadingImage}
                onchange={handleImageUpload}
              />
            </label>
          {/if}
        </div>
      {/if}
      {#if imageUploadError}
        <p class="text-xs text-red-500" role="alert">{imageUploadError}</p>
      {/if}
    </div>

    {#if isPricedGrid && item.productGrid}
      <ProductGridEditor
        grid={item.productGrid}
        {tiers}
        {formations}
        {formTiers}
        {orderedCells}
        {isPublic}
        problem={gridProblem}
        title={item.label}
      />
    {:else if item.type === 'file'}
      <!-- A file question has no options to edit: the line says who reads the file and when it goes. -->
      <p class="text-text-muted text-xs leading-relaxed">
        {fileHint ?? m.form_builder_file_hint()}
      </p>
    {:else if item.type === 'linear_scale'}
      <div
        class="space-y-4 rounded-xl border border-black/5 bg-white/30 p-3 sm:space-y-5 sm:rounded-2xl sm:p-5 dark:border-white/10 dark:bg-black/20"
      >
        <div class="flex flex-wrap items-center gap-2 sm:gap-4">
          <span class="text-text-main w-full text-sm font-bold sm:w-auto"
            >{m.form_builder_scale_prefix()}</span
          >
          <Picker
            label={m.form_builder_scale_min_picker()}
            value={String(item.scale.min)}
            options={SCALE_MIN_OPTIONS}
            onValueChange={(v) => (item.scale.min = Number(v))}
            triggerClass={scaleTriggerClass}
          />
          <span class="text-text-muted text-xs font-bold uppercase"
            >{m.form_builder_scale_to()}</span
          >
          <Picker
            label={m.form_builder_scale_max_picker()}
            value={String(item.scale.max)}
            options={SCALE_MAX_OPTIONS}
            onValueChange={(v) => (item.scale.max = Number(v))}
            triggerClass={scaleTriggerClass}
          />
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
            <div class="text-text-muted text-2xs flex gap-2 font-semibold sm:text-xs">
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
                <span class="text-text-muted text-2xs font-bold tracking-wide uppercase">
                  {isMatrix
                    ? m.form_builder_column_mobile_label()
                    : m.form_builder_option_mobile_label()}
                  {idx + 1}
                </span>
                <button
                  class="ui-icon-button text-text-muted rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-500"
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
                      min="0"
                    />
                  </div>
                {/if}
                <button
                  class="ui-icon-button text-text-muted rounded-xl transition-colors hover:bg-red-500/10 hover:text-red-500"
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
                      class="text-text-muted text-2xs mb-1 block font-bold"
                      >{m.form_builder_price_public_mobile()}</label
                    >
                    <input
                      id="opt-price-{opt.id}"
                      type="number"
                      bind:value={opt.priceModifier}
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      class={fieldClass}
                    />
                  </div>
                {/if}
              </div>
              {#if duplicateColumns.has(opt.label)}
                <p class="text-red-err mt-1 text-xs font-semibold sm:pl-7" role="alert">
                  {m.form_builder_grid_duplicate_inline()}
                </p>
              {/if}
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
                    <span class="text-text-muted text-2xs font-bold tracking-wide uppercase">
                      {m.form_builder_row_mobile_label({ idx: idx + 1 })}
                    </span>
                    <button
                      class="ui-icon-button text-text-muted rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-500"
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
                      <Input
                        placeholder={m.form_builder_row_placeholder()}
                        bind:value={row.value}
                      />
                    </div>
                    <button
                      class="ui-icon-button text-text-muted rounded-xl transition-colors hover:bg-red-500/10 hover:text-red-500"
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
                  {#if duplicateRows.has(row.value)}
                    <p class="text-red-err mt-1 text-xs font-semibold sm:pl-7" role="alert">
                      {m.form_builder_grid_duplicate_inline()}
                    </p>
                  {/if}
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

            {#if item.required}
              <!-- D5: a required grid wants one answered row, unless every row is asked for. -->
              <Toggle
                label={m.form_builder_require_every_row()}
                bind:checked={
                  () => item.requireEveryRow === true,
                  (on) => {
                    item.requireEveryRow = on;
                  }
                }
              />
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Conditional logic -->
    {#if eligibleConditionSources.length > 0}
      <div class="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
        <div class="mb-2 flex items-center gap-1.5">
          <GitBranch size={13} class="text-text-muted/70 shrink-0" />
          <span class="text-text-muted text-2xs font-bold tracking-wider uppercase"
            >{m.form_builder_conditional_label()}</span
          >
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Picker
            label={m.form_builder_conditional_label()}
            value={item.dependsOn ?? ''}
            options={conditionSourceOptions}
            onValueChange={(v) => {
              item.dependsOn = v;
              item.dependsValue = '';
            }}
            triggerClass={conditionTriggerClass}
          />
          {#if item.dependsOn}
            <span class="text-text-muted shrink-0 text-xs">=</span>
            <Picker
              label={m.form_builder_conditional_label()}
              value={item.dependsValue ?? ''}
              options={conditionValueOptions}
              onValueChange={(v) => (item.dependsValue = v)}
              triggerClass={conditionTriggerClass}
            />
          {/if}
        </div>
      </div>
    {/if}

    <!-- The settings row: required, conditions, duplicate, delete (and reorder on touch). -->
    <div
      class="mt-3 flex items-center gap-0.5 border-t border-black/5 pt-2 dark:border-white/5"
      role="toolbar"
      aria-label={m.form_builder_settings_row_aria()}
    >
      <button
        type="button"
        onclick={() => (item.required = !item.required)}
        aria-pressed={!!item.required}
        disabled={isPricedGrid}
        aria-label={m.form_builder_required_label()}
        title={isPricedGrid ? m.form_pgrid_always_required() : m.form_builder_required_label()}
        class="ui-icon-button rounded-lg transition-colors {item.required
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      >
        <Asterisk size={18} />
      </button>
      <button
        type="button"
        onclick={toggleConditions}
        aria-pressed={conditionsOn}
        aria-label={m.form_builder_conditions_aria()}
        title="{m.form_show_if_toggle()} - {m.form_show_if_hint()}"
        class="ui-icon-button rounded-lg transition-colors {conditionsOn
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      >
        <Users size={18} />
      </button>
      <button
        type="button"
        onclick={onDuplicate}
        aria-label={m.form_builder_duplicate_aria()}
        title={m.form_builder_duplicate_title()}
        class="ui-icon-button text-text-muted hover:text-text-main rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <Copy size={18} />
      </button>
      <button
        type="button"
        onclick={onRemove}
        aria-label={m.form_builder_delete_aria()}
        title={m.form_builder_delete_title()}
        class="ui-icon-button text-text-muted rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-500"
      >
        <Trash2 size={18} />
      </button>
      {#if onMoveUp && onMoveDown}
        <!-- Touch has no drag handle: reordering is two arrows. -->
        <button
          type="button"
          onclick={onMoveUp}
          disabled={!canMoveUp}
          class="ui-icon-button text-text-muted hover:text-text-main rounded-lg transition-colors hover:bg-black/5 disabled:opacity-25 sm:hidden dark:hover:bg-white/10"
          title={m.form_builder_move_up_title()}
          aria-label={m.form_builder_move_up_aria()}
        >
          <ArrowUp size={18} />
        </button>
        <button
          type="button"
          onclick={onMoveDown}
          disabled={!canMoveDown}
          class="ui-icon-button text-text-muted hover:text-text-main rounded-lg transition-colors hover:bg-black/5 disabled:opacity-25 sm:hidden dark:hover:bg-white/10"
          title={m.form_builder_move_down_title()}
          aria-label={m.form_builder_move_down_aria()}
        >
          <ArrowDown size={18} />
        </button>
      {/if}
      <button
        type="button"
        onclick={onCollapse}
        aria-label={m.form_builder_collapse_aria()}
        title={m.form_builder_collapse_aria()}
        class="ui-icon-button text-text-muted hover:text-text-main ml-auto rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <ChevronUp size={18} />
      </button>
    </div>

    <!-- Audience condition: shown to some people only, and only when switched on. -->
    {#if conditionsOn}
      <div class="mt-3" data-testid="audience-panel">
        <AudienceConditionEditor bind:condition={item.showIf} {tiers} {formations} />
      </div>
    {/if}
  {/if}
</div>
