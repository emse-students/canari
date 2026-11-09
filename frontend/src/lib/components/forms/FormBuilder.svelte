<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import AudienceConditionEditor from './AudienceConditionEditor.svelte';
  import ProductGridEditor from './ProductGridEditor.svelte';
  import ChoiceOptionsEditor from './ChoiceOptionsEditor.svelte';
  import ScaleEditor from './ScaleEditor.svelte';
  import MatrixGridEditor from './MatrixGridEditor.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import { opensAsSheet } from '$lib/components/ui/floatingSurface';
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
    Ellipsis,
    GitBranch,
    GripVertical,
    ImagePlus,
    Plus,
    SlidersHorizontal,
    X,
  } from '@lucide/svelte';
  import {
    AUTHORABLE_QUESTION_TYPES,
    editorKindEntry,
    editorKindOf,
    editorQuestionFamilies,
    isMatrixType,
  } from '$lib/forms/questionTypes';
  import {
    questionCardMenuSections,
    questionKindSections,
    type QuestionCardAction,
  } from '$lib/forms/questionMenus';
  import { ensureMatrixAxes } from '$lib/forms/matrixEditor';
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
    onInsertAfter,
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
    /** The duplicate icon, the "..." menu's copy, or Ctrl/Cmd+D. */
    onDuplicate?: () => void;
    /** The "..." menu's "a question after this one": the list opens the add wizard for this place. */
    onInsertAfter?: () => void;
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
  let typeAsSheet = $state(false);
  let typeAnchor = $state<HTMLButtonElement | null>(null);
  let showCardMenu = $state(false);
  let cardMenuAsSheet = $state(false);
  let cardMenuAnchor = $state<HTMLButtonElement | null>(null);
  /** "Plus d'options": the conditions, folded unless one is set (a live setting is never hidden). */
  let moreOpen = $state(false);
  let titleEl = $state<HTMLInputElement | null>(null);
  let rowButtonEl = $state<HTMLButtonElement | null>(null);
  /** Set when the card collapses from the keyboard, so focus lands on its row and not on the page. */
  let restoreRowFocus = false;
  let wasExpanded = false;

  // Opening a card moves focus to its title; closing it from the keyboard returns focus to its row.
  $effect(() => {
    if (expanded && !wasExpanded) {
      moreOpen = item.showIf != null || !!item.dependsOn;
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
      restoreRowFocus = true;
      onCollapse?.();
    }
  }

  /** How the card names its type: both survey grids are the one "Grille de choix". */
  const currentType = $derived(editorKindEntry(item.type));
  const typeSections = $derived(
    questionKindSections(editorQuestionFamilies(authorableTypes), { currentType: item.type })
  );
  const cardMenuSections = questionCardMenuSections();
  /** The audience panel is open exactly when the condition is switched on. */
  const conditionsOn = $derived(item.showIf != null);
  function toggleConditions() {
    item.showIf = conditionsOn ? null : {};
  }

  const isMatrix = $derived(isMatrixType(item.type));
  // A DENYLIST: every type not named here gets the options editor. A type with no options (a file
  // included) must be added, or its card grows an options list it will never use.
  const hasOptions = $derived(
    !['short_text', 'long_text', 'linear_scale', 'file', PRODUCT_GRID_TYPE].includes(item.type)
  );
  /**
   * A priced grid is never required on its own - the ORDER is, across the form's grids - so its
   * card has no asterisk and no required switch (it is sent `required: true`, `toFormItemsPayload`).
   */
  const isPricedGrid = $derived(item.type === PRODUCT_GRID_TYPE);

  /**
   * The type menu's choice. A kind already on screen changes nothing (a "Grille de choix" keeps
   * its switch); a grid gets a row and a column to type in; leaving a priced grid tells the page.
   */
  function changeKind(key: string) {
    showTypePicker = false;
    typeAnchor?.focus();
    if (key === editorKindOf(item.type)) return;
    const entry = editorQuestionFamilies(authorableTypes)
      .flatMap((f) => f.kinds)
      .find((k) => k.kind === key);
    if (!entry) return;
    Log.d('FORMS', `question type ${item.type} -> ${entry.type}`);
    const wasPricedGrid = item.type === PRODUCT_GRID_TYPE;
    item.type = entry.type;
    if (entry.type === PRODUCT_GRID_TYPE) becomePricedGrid();
    else if (wasPricedGrid) onLeftPricedGrid?.();
    if (isMatrixType(entry.type)) ensureMatrixAxes(item);
  }

  function runCardAction(key: string) {
    showCardMenu = false;
    // The menu's entry is going away: the focus goes back to the "..." it was opened from.
    cardMenuAnchor?.focus();
    const action = key as QuestionCardAction;
    Log.d('FORMS', `question card menu: ${action}`);
    if (action === 'insert_after') onInsertAfter?.();
    else if (action === 'duplicate') onDuplicate?.();
    else if (action === 'remove') onRemove();
  }

  /** Turns the question into a priced grid: its definition, its stored flag, and the page told. */
  function becomePricedGrid() {
    if (!item.productGrid) item.productGrid = newProductGrid();
    item.required = true;
    onBecamePricedGrid?.();
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
          >{item.label ||
            m.form_builder_title_placeholder()}{#if item.required && !isPricedGrid}<span
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
      <button
        bind:this={typeAnchor}
        id="type-picker-{item.id}"
        type="button"
        aria-label="{m.form_builder_type_label()}: {currentType?.label() ?? item.type}"
        aria-haspopup="listbox"
        aria-expanded={showTypePicker}
        onclick={() => {
          if (showTypePicker) {
            showTypePicker = false;
            return;
          }
          typeAsSheet = opensAsSheet();
          showTypePicker = true;
        }}
        class="border-cn-border text-text-main focus:border-cn-yellow flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) px-2 text-left text-xs font-medium outline-none"
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
    </div>

    <FloatingSurface
      open={showTypePicker}
      asSheet={typeAsSheet}
      anchor={typeAnchor}
      label={m.form_builder_type_label()}
      popoverWidth="content"
      onClose={(refocus) => {
        showTypePicker = false;
        if (refocus) typeAnchor?.focus();
      }}
    >
      <div class="min-w-60">
        <MenuList
          sections={typeSections}
          label={m.form_builder_type_label()}
          onSelect={changeKind}
        />
      </div>
    </FloatingSurface>

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
      <ScaleEditor {item} />
    {:else if isMatrix}
      <MatrixGridEditor {item} />
    {:else if hasOptions}
      <ChoiceOptionsEditor {item} {showPriceModifier} {pricedByGrid} />
    {/if}

    <!-- "Plus d'options": the two conditions, rare, folded unless one is set. -->
    <div class="mt-4 border-t border-black/5 pt-2 dark:border-white/5">
      <button
        type="button"
        aria-expanded={moreOpen}
        onclick={() => (moreOpen = !moreOpen)}
        data-testid="more-options"
        class="text-text-muted hover:text-text-main flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left text-xs font-bold"
      >
        <SlidersHorizontal size={14} aria-hidden="true" class="shrink-0" />
        <span class="flex-1">{m.form_card_more_options()}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          class="shrink-0 transition-transform {moreOpen ? 'rotate-180' : ''}"
        />
      </button>
      {#if moreOpen}
        <div class="space-y-4 pt-2 pb-1" data-testid="more-options-panel">
          {#if eligibleConditionSources.length > 0}
            <div>
              <div class="mb-2 flex items-center gap-1.5">
                <GitBranch size={13} class="text-text-muted/70 shrink-0" />
                <span class="text-text-muted text-2xs font-bold"
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
          <!-- Audience condition: shown to some people only, and only when switched on. -->
          <Toggle
            label={m.form_show_if_toggle()}
            hint={m.form_show_if_hint()}
            bind:checked={() => conditionsOn, () => toggleConditions()}
          />
          {#if conditionsOn}
            <div data-testid="audience-panel">
              <AudienceConditionEditor bind:condition={item.showIf} {tiers} {formations} />
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- The settings row: required, reorder on touch, the "..." menu, collapse. -->
    <div
      class="mt-1 flex items-center gap-0.5 border-t border-black/5 pt-2 dark:border-white/5"
      role="toolbar"
      aria-label={m.form_builder_settings_row_aria()}
    >
      {#if !isPricedGrid}
        <button
          type="button"
          onclick={() => (item.required = !item.required)}
          aria-pressed={!!item.required}
          aria-label={m.form_builder_required_label()}
          title={m.form_builder_required_label()}
          class="ui-icon-button rounded-lg transition-colors {item.required
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          <Asterisk size={18} />
        </button>
      {/if}
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
        bind:this={cardMenuAnchor}
        type="button"
        onclick={() => {
          if (showCardMenu) {
            showCardMenu = false;
            return;
          }
          cardMenuAsSheet = opensAsSheet();
          showCardMenu = true;
        }}
        aria-label={m.form_card_menu_aria()}
        title={m.form_card_menu_aria()}
        aria-haspopup="true"
        aria-expanded={showCardMenu}
        class="ui-icon-button text-text-muted hover:text-text-main ml-auto rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <Ellipsis size={18} />
      </button>
      <button
        type="button"
        onclick={onCollapse}
        aria-label={m.form_builder_collapse_aria()}
        title={m.form_builder_collapse_aria()}
        class="ui-icon-button text-text-muted hover:text-text-main rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <ChevronUp size={18} />
      </button>
    </div>

    <FloatingSurface
      open={showCardMenu}
      asSheet={cardMenuAsSheet}
      anchor={cardMenuAnchor}
      label={m.form_card_menu_aria()}
      popoverWidth="content"
      onClose={(refocus) => {
        showCardMenu = false;
        if (refocus) cardMenuAnchor?.focus();
      }}
    >
      <div class="min-w-60">
        <MenuList
          sections={cardMenuSections}
          label={m.form_card_menu_aria()}
          onSelect={runCardAction}
        />
      </div>
    </FloatingSurface>
  {/if}
</div>
