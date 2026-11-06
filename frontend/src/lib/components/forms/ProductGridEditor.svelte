<script lang="ts">
  import { tick } from 'svelte';
  import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ClipboardPaste,
    GripVertical,
    Minus,
    Monitor,
    Plus,
    Smartphone,
    X,
  } from '@lucide/svelte';
  import CriterionEditor from '$lib/components/pricing/CriterionEditor.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import ProductGridQuestion from './ProductGridQuestion.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormItem } from '$lib/forms/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { newDimension, type Bucket } from '$lib/pricing/priceMatrix';
  import {
    PRODUCT_GRID_ALL_TIER,
    PRODUCT_GRID_MAX_PER_CELL,
    PRODUCT_GRID_MIN_PER_CELL,
    PRODUCT_GRID_OTHERS_TIER,
    PRODUCT_GRID_SINGLE_KEY,
    PRODUCT_GRID_TYPE,
    productGridAxisKey,
    productGridLabelKey,
    type ProductGridPriceMode,
  } from '$lib/forms/productGridContract';
  import {
    addAxisEntries,
    addBlankEntry,
    axisEntryHasOrders,
    axisMax,
    collidingLabelKeys,
    editorGridView,
    editorTierIds,
    editorViewerPrices,
    euroInputText,
    isCellClosed,
    moveAxisEntry,
    parseEuroInput,
    priceOf,
    removalClosesEveryCell,
    removeAxisEntry,
    setMaxPerCell,
    setPrice,
    setPriceMode,
    setTiers,
    splitPastedList,
    syncTierLists,
    toggleClosedCell,
    type AddEntriesResult,
    type EditorProductGrid,
    type ProductGridAxis,
    type ProductGridTierDimension,
  } from '$lib/forms/productGridEditor';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE EDITOR OF A PRICED GRID (`product_grid`, WP-G3): the table IS the editor.
   *
   * Columns are chips in the header (renamed in place, removed by their x), rows a narrow first
   * column of inline inputs, "+" adds one of either and "Coller une liste" adds many. A grip moves
   * a row or a column, by dragging or by the arrow keys; on a touch screen or a phone-width page,
   * where no drag reaches it, two arrow buttons per entry do. Clicking a cell closes the combination
   * ("no Creme in XS") or reopens it. Prices sit where the mode puts them - one field, a column
   * beside the rows, a row under the headers - once per category, one tab each, when the grid
   * prices per cotisation, promo or formation. Below, the buyer's view, desktop or phone.
   *
   * The model and every rule are in `productGridEditor.ts`; this file draws them. Euros here, cents
   * on the wire (`itemsPayload.ts`).
   */
  interface Props {
    /** The grid, mutated in place (a `$state` proxy held by the question). */
    grid: EditorProductGrid;
    /** Cotisation tiers of the beneficiary association: the cotisation criterion needs one. */
    tiers?: MembershipTier[];
    /** Formation values in use, for the formation criterion. */
    formations?: FormationOption[];
    /** The registration price grid's profile criterion, offered as a one-click copy. */
    formTiers?: ProductGridTierDimension | null;
    /** Cells of THIS grid already ordered in an answer: removing their row or column warns. */
    orderedCells?: string[];
    /** A public form: a guest pays "everyone else", which the hint says. */
    isPublic?: boolean;
    /** The sentence of a refused save about THIS grid, shown under the table. */
    problem?: string | null;
    /** The question's title, which the preview's card carries as the buyer reads it. */
    title?: string;
  }

  let {
    grid,
    tiers = [],
    formations = [],
    formTiers = null,
    orderedCells = [],
    isPublic = false,
    problem = null,
    title = '',
  }: Props = $props();

  const TAG = 'ProductGridEditor';

  const tierIds = $derived(editorTierIds(grid));
  let selectedTier = $state<string>(PRODUCT_GRID_ALL_TIER);
  /** The tab on screen; falls back to the first category when the chosen one is gone. */
  const activeTier = $derived(tierIds.includes(selectedTier) ? selectedTier : tierIds[0]);
  const mode = $derived(grid.pricing.mode);

  let pasteOpen = $state(false);
  let pasteText = $state('');
  let pasteFeedback = $state('');
  /** Why the last removal was refused, said under the table where the gesture was made. */
  let tableFeedback = $state('');
  let tableEl = $state<HTMLElement | null>(null);

  const MODES: { value: ProductGridPriceMode; label: () => string }[] = [
    { value: 'single', label: () => m.form_pgrid_mode_single() },
    { value: 'per_row', label: () => m.form_pgrid_mode_per_row() },
    { value: 'per_column', label: () => m.form_pgrid_mode_per_column() },
  ];

  /** The name of a category tab: a bucket's label, "Autres", or nothing for the one list. */
  function tierName(tierId: string): string {
    if (tierId === PRODUCT_GRID_OTHERS_TIER) return m.form_pgrid_tier_others();
    if (tierId === PRODUCT_GRID_ALL_TIER) return '';
    const bucket = grid.pricing.tiers?.buckets.find((b) => b.id === tierId);
    return bucket?.label.trim() || m.form_pgrid_tier_unnamed();
  }

  // Labels that collide on an axis, as the save compares them: marked on the field.
  const duplicateRows = $derived(collidingLabelKeys(grid.rows));
  const duplicateColumns = $derived(collidingLabelKeys(grid.columns));

  function priceText(axisKey: string): string {
    return euroInputText(priceOf(grid, activeTier, axisKey));
  }

  /**
   * Stores a typed price, then writes back what was STORED: the field is bound one way, so an
   * unreadable entry (stored blank) or a third decimal (stored rounded) would otherwise keep
   * showing text the save does not hold.
   */
  function commitPrice(axisKey: string, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    setPrice(grid, activeTier, axisKey, parseEuroInput(input.value));
    input.value = priceText(axisKey);
  }

  /** What a cell shows in the editor: its price, or a dash while that price is blank. */
  function cellPriceLabel(rowId: string, colId: string): string {
    const euros = priceOf(grid, activeTier, productGridAxisKey(mode, rowId, colId));
    return euros === null ? '-' : formatAmount(Math.round(euros * 100));
  }

  function addEntry(axis: ProductGridAxis) {
    if (!addBlankEntry(grid, axis)) {
      pasteFeedback = m.form_pgrid_axis_full({ max: axisMax(axis) });
      return;
    }
    // The new blank label takes the focus: "+" then typing is the common case.
    void tick().then(() => {
      const inputs = tableEl?.querySelectorAll<HTMLInputElement>(`[data-axis-input="${axis}"]`);
      inputs?.[inputs.length - 1]?.focus();
    });
  }

  /**
   * Removes a row or column. One already ordered in an answer asks first: the past orders keep what
   * they were charged (`submissions.lines`), but the article stops being offered.
   */
  async function removeEntry(axis: ProductGridAxis, id: string) {
    tableFeedback = '';
    // Refused before any confirm: what would be left is a grid nobody can order from.
    if (removalClosesEveryCell(grid, axis, id)) {
      Log.d(TAG, `the ${axis} entry is kept: every remaining cell would be closed`);
      tableFeedback = m.form_pgrid_remove_closes_every_cell();
      return;
    }
    if (axisEntryHasOrders(orderedCells, axis, id)) {
      Log.d(TAG, `the ${axis} entry to remove has orders: asking first`);
      const ok = await showConfirm(m.form_pgrid_remove_ordered_confirm(), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      });
      if (!ok) return;
    }
    if (removeAxisEntry(grid, axis, id) === 'closes_every_cell') {
      tableFeedback = m.form_pgrid_remove_closes_every_cell();
    }
  }

  function feedbackOf(result: AddEntriesResult, axis: ProductGridAxis): string {
    const parts: string[] = [];
    if (result.duplicates.length > 0) {
      parts.push(m.form_pgrid_paste_duplicates({ labels: result.duplicates.join(', ') }));
    }
    if (result.overflow > 0) {
      parts.push(m.form_pgrid_paste_overflow({ count: result.overflow, max: axisMax(axis) }));
    }
    return parts.join(' ');
  }

  function pasteAs(axis: ProductGridAxis) {
    const labels = splitPastedList(pasteText);
    if (labels.length === 0) {
      pasteFeedback = m.form_pgrid_paste_empty();
      return;
    }
    // The blank entry a new grid starts with is replaced, not kept beside the pasted list.
    const list = grid[axis];
    if (list.length === 1 && !list[0].label.trim()) removeBlankStarter(axis);
    const result = addAxisEntries(grid, axis, labels);
    pasteFeedback = feedbackOf(result, axis);
    if (!pasteFeedback) {
      pasteText = '';
      pasteOpen = false;
    }
  }

  /** The one blank starter entry gives way to a pasted list (an axis is never left empty). */
  function removeBlankStarter(axis: ProductGridAxis) {
    grid[axis] = [];
    Log.d(TAG, `the blank ${axis} starter gives way to a pasted list`);
  }

  // Reordering: a grip is dragged onto another entry, or moved with the arrow keys.
  let dragAxis = $state<ProductGridAxis | null>(null);
  let dragFrom = $state(-1);

  function onGripDragStart(e: DragEvent, axis: ProductGridAxis, index: number) {
    // The question card is draggable too: this drag is the grid's, never the card's.
    e.stopPropagation();
    dragAxis = axis;
    dragFrom = index;
    e.dataTransfer?.setData('text/plain', `${axis}:${index}`);
  }

  function onEntryDragOver(e: DragEvent, axis: ProductGridAxis) {
    if (dragAxis !== axis) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onEntryDrop(e: DragEvent, axis: ProductGridAxis, index: number) {
    if (dragAxis !== axis) return;
    e.preventDefault();
    e.stopPropagation();
    moveAxisEntry(grid, axis, dragFrom, index);
    endDrag();
  }

  function endDrag() {
    dragAxis = null;
    dragFrom = -1;
  }

  async function onGripKeydown(e: KeyboardEvent, axis: ProductGridAxis, index: number) {
    const back = axis === 'rows' ? 'ArrowUp' : 'ArrowLeft';
    const forward = axis === 'rows' ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const to = e.key === back ? index - 1 : index + 1;
    if (!moveAxisEntry(grid, axis, index, to)) return;
    await tick();
    tableEl?.querySelectorAll<HTMLElement>(`[data-axis-grip="${axis}"]`)[to]?.focus();
  }

  /**
   * The touch path: an arrow button moves its entry one step. Focus follows the entry to the same
   * button at its new place, or to the other one once that end of the axis is reached (a disabled
   * button cannot hold focus).
   */
  async function moveByButton(axis: ProductGridAxis, index: number, step: -1 | 1) {
    const to = index + step;
    if (!moveAxisEntry(grid, axis, index, to)) return;
    await tick();
    const atEnd = step < 0 ? to === 0 : to === grid[axis].length - 1;
    const side = (atEnd ? -step : step) < 0 ? 'back' : 'forward';
    tableEl?.querySelectorAll<HTMLElement>(`[data-axis-move="${axis}:${side}"]`)[to]?.focus();
  }

  /** The arrow buttons show where no drag works: a coarse pointer, or a phone-width page. */
  const moveButtonClass =
    'ui-icon-button text-text-muted hover:text-text-main hidden rounded-lg hover:bg-black/5 disabled:opacity-25 max-sm:inline-flex pointer-coarse:inline-flex dark:hover:bg-white/10';

  // Categories: off, or one profile criterion.
  const tiered = $derived(grid.pricing.tiers !== null);
  const cotisationAvailable = $derived(tiers.length > 0);

  function startTiers(kind: 'cotisation' | 'promo' | 'formation') {
    const dimension = newDimension(kind) as ProductGridTierDimension;
    setTiers(grid, dimension);
  }

  function copyFormTiers() {
    if (!formTiers) return;
    setTiers(grid, JSON.parse(JSON.stringify(formTiers)) as ProductGridTierDimension);
  }

  function stopTiers() {
    setTiers(grid, null);
    selectedTier = PRODUCT_GRID_ALL_TIER;
  }

  function addBucket(bucket: Bucket) {
    if (!grid.pricing.tiers) return;
    grid.pricing.tiers.buckets = [...grid.pricing.tiers.buckets, bucket];
    syncTierLists(grid);
  }

  function removeBucket(bucketId: string) {
    if (!grid.pricing.tiers) return;
    grid.pricing.tiers.buckets = grid.pricing.tiers.buckets.filter((b) => b.id !== bucketId);
  }

  // The preview: the respondent's component on what the payload would send, at the tab's prices.
  let previewLayout = $state<'desktop' | 'phone'>('desktop');
  const previewGrid = $derived(editorGridView(grid));
  const previewPrices = $derived(
    editorViewerPrices(grid, activeTier, tierIds.length > 1 ? tierName(activeTier) : null)
  );

  const TIER_KINDS = ['cotisation', 'promo', 'formation'] as const;
  /** Ids for the two labelled groups, unique per editor on the page. */
  const domKey = crypto.randomUUID();
  /** A question of its own id, so the preview's card never shares an element id with the page. */
  const previewItem = $derived<FormItem>({
    id: `preview-${domKey}`,
    label: title,
    required: true,
    type: PRODUCT_GRID_TYPE,
  });
  const singleKey = PRODUCT_GRID_SINGLE_KEY;
  const segmentClass = (on: boolean) =>
    `tap-target min-h-9 rounded-full px-3.5 text-sm transition-colors ${
      on ? 'bg-cn-surface text-text-main font-bold shadow-sm' : 'text-text-muted font-medium'
    }`;
  const priceBoxClass =
    'border-cn-border bg-cn-surface focus-within:border-cn-yellow flex items-center rounded-lg border px-2';
  const priceInputClass =
    'text-text-main min-h-9 pointer-coarse:min-h-11 w-14 min-w-0 border-0 bg-transparent text-right text-sm font-bold outline-none';
</script>

<div class="space-y-4" data-testid="product-grid-editor">
  <!-- Settings bar: price mode, cap per cell, paste a list. -->
  <div class="bg-cn-surface-alt flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg p-4">
    <div class="flex flex-col gap-1.5">
      <span id="pg-mode-{domKey}" class="text-text-main text-xs font-bold"
        >{m.form_pgrid_mode_label()}</span
      >
      <div
        role="group"
        aria-labelledby="pg-mode-{domKey}"
        class="bg-cn-border/60 flex flex-wrap gap-1 rounded-full p-1"
      >
        {#each MODES as option (option.value)}
          <button
            type="button"
            aria-pressed={mode === option.value}
            onclick={() => setPriceMode(grid, option.value)}
            class={segmentClass(mode === option.value)}>{option.label()}</button
          >
        {/each}
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      <span id="pg-max-{domKey}" class="text-text-main text-xs font-bold"
        >{m.form_pgrid_max_label()}</span
      >
      <div
        role="group"
        aria-labelledby="pg-max-{domKey}"
        class="bg-cn-surface flex items-center gap-1 rounded-full p-0.5"
      >
        <button
          type="button"
          class="ui-icon-button text-text-main rounded-full hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
          aria-label={m.form_pgrid_max_decrease()}
          disabled={grid.maxPerCell <= PRODUCT_GRID_MIN_PER_CELL}
          onclick={() => setMaxPerCell(grid, grid.maxPerCell - 1)}><Minus size={16} /></button
        >
        <span
          class="text-text-main min-w-6 text-center text-sm font-bold tabular-nums"
          aria-live="polite"
          data-testid="max-per-cell">{grid.maxPerCell}</span
        >
        <button
          type="button"
          class="ui-icon-button text-text-main rounded-full hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
          aria-label={m.form_pgrid_max_increase()}
          disabled={grid.maxPerCell >= PRODUCT_GRID_MAX_PER_CELL}
          onclick={() => setMaxPerCell(grid, grid.maxPerCell + 1)}><Plus size={16} /></button
        >
      </div>
    </div>
    <p class="text-text-muted max-w-52 pb-1 text-xs">
      {grid.maxPerCell === 1
        ? m.form_pgrid_max_hint_checkbox()
        : m.form_pgrid_max_hint_stepper({ max: grid.maxPerCell })}
    </p>

    <button
      type="button"
      aria-expanded={pasteOpen}
      onclick={() => {
        pasteOpen = !pasteOpen;
        pasteFeedback = '';
      }}
      class="bg-cn-surface text-text-main ml-auto inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-bold"
    >
      <ClipboardPaste size={18} />
      {m.form_pgrid_paste_button()}
    </button>
  </div>

  {#if pasteOpen}
    <div
      class="border-cn-border flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start"
    >
      <label class="flex min-w-0 flex-1 flex-col gap-1.5">
        <span class="text-text-main text-sm font-bold">{m.form_pgrid_paste_label()}</span>
        <textarea
          rows="4"
          bind:value={pasteText}
          placeholder={m.form_pgrid_paste_placeholder()}
          class="border-cn-border text-text-main focus:border-cn-yellow bg-cn-surface resize-y rounded-lg border px-3 py-2.5 text-sm outline-none"
        ></textarea>
      </label>
      <div class="flex flex-col gap-2 sm:pt-6">
        <button
          type="button"
          onclick={() => pasteAs('rows')}
          class="bg-cn-yellow text-cn-ink min-h-11 rounded-lg px-4 text-sm font-bold"
          >{m.form_pgrid_paste_as_rows()}</button
        >
        <button
          type="button"
          onclick={() => pasteAs('columns')}
          class="bg-cn-border/60 text-text-main min-h-11 rounded-lg px-4 text-sm font-bold"
          >{m.form_pgrid_paste_as_columns()}</button
        >
      </div>
    </div>
  {/if}
  {#if pasteFeedback}
    <p class="text-red-err text-xs font-semibold" role="status">{pasteFeedback}</p>
  {/if}

  <!-- Categories: one price list each, "Autres" always last. -->
  <div class="space-y-3">
    <Toggle
      label={m.form_pgrid_tiers_toggle()}
      bind:checked={
        () => tiered,
        (on) => {
          if (!on) stopTiers();
          else if (formTiers) copyFormTiers();
          else startTiers(cotisationAvailable ? 'cotisation' : 'promo');
        }
      }
    />
    {#if grid.pricing.tiers}
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-text-main text-sm font-bold">{m.form_pgrid_tiers_by()}</span>
        <div
          role="group"
          aria-label={m.form_pgrid_tiers_by()}
          class="bg-cn-border/60 flex gap-1 rounded-full p-1"
        >
          {#each TIER_KINDS as kind (kind)}
            {#if kind !== 'cotisation' || cotisationAvailable}
              <button
                type="button"
                aria-pressed={grid.pricing.tiers.kind === kind}
                onclick={() => {
                  if (grid.pricing.tiers?.kind !== kind) startTiers(kind);
                }}
                class={segmentClass(grid.pricing.tiers.kind === kind)}
                >{kind === 'cotisation'
                  ? m.form_criterion_cotisation()
                  : kind === 'promo'
                    ? m.form_criterion_promo()
                    : m.form_criterion_formation()}</button
              >
            {/if}
          {/each}
        </div>
        {#if formTiers}
          <button
            type="button"
            onclick={copyFormTiers}
            class="text-text-muted hover:text-text-main min-h-11 px-2 text-xs font-bold underline"
            >{m.form_pgrid_tiers_copy_form()}</button
          >
        {/if}
      </div>
      <CriterionEditor
        dimension={grid.pricing.tiers}
        axisLabel={m.form_pgrid_tiers_badge()}
        sources={{ tiers, formations, items: [] }}
        onAddBucket={addBucket}
        onRemoveBucket={removeBucket}
        onRemove={stopTiers}
        onChange={() => syncTierLists(grid)}
      />
    {/if}
  </div>

  <div>
    {#if tierIds.length > 1}
      <div class="flex flex-wrap items-end gap-x-4 border-b border-black/10 dark:border-white/10">
        <!-- Not a tablist: the categories are as many as the criterion holds, and a tab row is the
             SegmentedControl's alone (2 or 3 fixed entries). One pressed button per category. -->
        <div role="group" aria-label={m.form_pgrid_tiers_tabs_aria()} class="flex flex-wrap gap-1">
          {#each tierIds as tierId (tierId)}
            <button
              type="button"
              aria-pressed={activeTier === tierId}
              data-tier-tab={tierId}
              onclick={() => (selectedTier = tierId)}
              class="min-h-11 border-b-3 px-4 text-sm {activeTier === tierId
                ? 'border-cn-yellow text-text-main font-bold'
                : 'text-text-muted border-transparent font-semibold'}">{tierName(tierId)}</button
            >
          {/each}
        </div>
        <span class="text-text-muted pb-3 text-xs">
          {isPublic ? m.form_pgrid_tiers_hint_public() : m.form_pgrid_tiers_hint()}
        </span>
      </div>
    {/if}

    {#if mode === 'single'}
      <label class="flex items-center gap-3 pt-4 pb-1">
        <span class="text-text-main text-sm font-bold"
          >{tierIds.length > 1
            ? m.form_pgrid_single_price_tier({ tier: tierName(activeTier) })
            : m.form_pgrid_single_price()}</span
        >
        <span class={priceBoxClass}>
          <input
            inputmode="decimal"
            class={priceInputClass}
            value={priceText(singleKey)}
            onchange={(e) => commitPrice(singleKey, e)}
            data-testid="price-single"
          />
          <span class="text-text-muted pl-1 text-sm" aria-hidden="true">{m.form_pgrid_euro()}</span>
        </span>
      </label>
    {/if}

    <!-- The table: the editor and its own preview. -->
    <div class="overflow-x-auto pt-3" bind:this={tableEl}>
      <table class="border-separate border-spacing-0">
        <thead>
          <tr>
            <th
              scope="col"
              class="text-text-muted w-56 min-w-44 pr-2 pb-2 text-left text-xs font-bold"
              >{m.form_pgrid_corner()}</th
            >
            {#if mode === 'per_row'}
              <th scope="col" class="text-text-muted w-24 px-1.5 pb-2 text-left text-xs font-bold"
                >{m.form_pgrid_price_header()}</th
              >
            {/if}
            {#each grid.columns as column, ci (column.id)}
              <th
                scope="col"
                class="w-26 px-1 pb-2 align-bottom"
                ondragover={(e) => onEntryDragOver(e, 'columns')}
                ondrop={(e) => onEntryDrop(e, 'columns', ci)}
              >
                <span
                  class="bg-cn-border/60 flex items-center justify-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-1 {duplicateColumns.has(
                    productGridLabelKey(column.label)
                  )
                    ? 'ring-red-err ring-2'
                    : ''}"
                >
                  <button
                    type="button"
                    draggable="true"
                    data-axis-grip="columns"
                    ondragstart={(e) => onGripDragStart(e, 'columns', ci)}
                    ondragend={endDrag}
                    onkeydown={(e) => onGripKeydown(e, 'columns', ci)}
                    aria-label={m.form_pgrid_move_column({ label: column.label || ci + 1 })}
                    class="text-text-muted flex h-8 w-4 shrink-0 cursor-grab items-center justify-center pointer-coarse:hidden"
                    ><GripVertical size={12} /></button
                  >
                  <input
                    data-axis-input="columns"
                    bind:value={column.label}
                    aria-label={m.form_pgrid_column_label({ n: ci + 1 })}
                    aria-invalid={duplicateColumns.has(productGridLabelKey(column.label)) ||
                      !column.label.trim()}
                    placeholder={m.form_pgrid_column_placeholder()}
                    maxlength={100}
                    class="text-text-main placeholder:text-text-muted/60 min-h-8 w-12 min-w-0 border-0 bg-transparent text-center text-sm font-bold outline-none"
                  />
                  <button
                    type="button"
                    onclick={() => removeEntry('columns', column.id)}
                    disabled={grid.columns.length <= 1}
                    aria-label={m.form_pgrid_remove_column({ label: column.label || ci + 1 })}
                    class="text-text-muted hover:text-red-err tap-target flex h-8 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
                    ><X size={12} /></button
                  >
                </span>
                <span class="mt-1 hidden justify-center gap-0.5 max-sm:flex pointer-coarse:flex">
                  <button
                    type="button"
                    data-axis-move="columns:back"
                    onclick={() => moveByButton('columns', ci, -1)}
                    disabled={ci === 0}
                    aria-label={m.form_pgrid_move_column_left({ label: column.label || ci + 1 })}
                    class={moveButtonClass}><ArrowLeft size={16} /></button
                  >
                  <button
                    type="button"
                    data-axis-move="columns:forward"
                    onclick={() => moveByButton('columns', ci, 1)}
                    disabled={ci === grid.columns.length - 1}
                    aria-label={m.form_pgrid_move_column_right({ label: column.label || ci + 1 })}
                    class={moveButtonClass}><ArrowRight size={16} /></button
                  >
                </span>
              </th>
            {/each}
            <th class="pb-2 pl-1 align-bottom">
              <button
                type="button"
                onclick={() => addEntry('columns')}
                aria-label={m.form_pgrid_add_column()}
                title={m.form_pgrid_add_column()}
                class="ui-icon-button border-cn-border bg-cn-surface text-text-main rounded-full border"
                ><Plus size={16} /></button
              >
            </th>
          </tr>
          {#if mode === 'per_column'}
            <tr>
              <th scope="row" class="text-text-main pr-2 pb-2 text-left text-xs font-bold"
                >{m.form_pgrid_price_header()}</th
              >
              {#each grid.columns as column (column.id)}
                <td class="px-1 pb-2">
                  <span class="{priceBoxClass} justify-center">
                    <input
                      inputmode="decimal"
                      class={priceInputClass}
                      aria-label={m.form_pgrid_price_column({ label: column.label || '-' })}
                      value={priceText(column.id)}
                      onchange={(e) => commitPrice(column.id, e)}
                    />
                    <span class="text-text-muted text-xs" aria-hidden="true"
                      >{m.form_pgrid_euro()}</span
                    >
                  </span>
                </td>
              {/each}
              <td></td>
            </tr>
          {/if}
        </thead>
        <tbody>
          {#each grid.rows as row, ri (row.id)}
            <tr
              ondragover={(e) => onEntryDragOver(e, 'rows')}
              ondrop={(e) => onEntryDrop(e, 'rows', ri)}
            >
              <th scope="row" class="py-0.5 pr-2 text-left font-normal">
                <span class="flex items-center gap-1">
                  <button
                    type="button"
                    draggable="true"
                    data-axis-grip="rows"
                    ondragstart={(e) => onGripDragStart(e, 'rows', ri)}
                    ondragend={endDrag}
                    onkeydown={(e) => onGripKeydown(e, 'rows', ri)}
                    aria-label={m.form_pgrid_move_row({ label: row.label || ri + 1 })}
                    class="ui-icon-button text-text-muted cursor-grab rounded-lg pointer-coarse:hidden"
                    ><GripVertical size={14} /></button
                  >
                  <button
                    type="button"
                    data-axis-move="rows:back"
                    onclick={() => moveByButton('rows', ri, -1)}
                    disabled={ri === 0}
                    aria-label={m.form_pgrid_move_row_up({ label: row.label || ri + 1 })}
                    class={moveButtonClass}><ArrowUp size={16} /></button
                  >
                  <button
                    type="button"
                    data-axis-move="rows:forward"
                    onclick={() => moveByButton('rows', ri, 1)}
                    disabled={ri === grid.rows.length - 1}
                    aria-label={m.form_pgrid_move_row_down({ label: row.label || ri + 1 })}
                    class={moveButtonClass}><ArrowDown size={16} /></button
                  >
                  <input
                    data-axis-input="rows"
                    bind:value={row.label}
                    aria-label={m.form_pgrid_row_label({ n: ri + 1 })}
                    aria-invalid={duplicateRows.has(productGridLabelKey(row.label)) ||
                      !row.label.trim()}
                    placeholder={m.form_pgrid_row_placeholder()}
                    maxlength={100}
                    class="text-text-main placeholder:text-text-muted/60 focus:border-cn-yellow min-h-10 min-w-0 flex-1 border-0 border-b bg-transparent px-1 text-sm font-semibold outline-none {duplicateRows.has(
                      productGridLabelKey(row.label)
                    )
                      ? 'border-red-err'
                      : 'border-cn-border'}"
                  />
                  <button
                    type="button"
                    onclick={() => removeEntry('rows', row.id)}
                    disabled={grid.rows.length <= 1}
                    aria-label={m.form_pgrid_remove_row({ label: row.label || ri + 1 })}
                    class="ui-icon-button text-text-muted hover:text-red-err shrink-0 rounded-full disabled:opacity-30"
                    ><X size={14} /></button
                  >
                </span>
              </th>
              {#if mode === 'per_row'}
                <td class="px-1.5 py-0.5">
                  <span class={priceBoxClass}>
                    <input
                      inputmode="decimal"
                      class={priceInputClass}
                      aria-label={m.form_pgrid_price_row({ label: row.label || '-' })}
                      value={priceText(row.id)}
                      onchange={(e) => commitPrice(row.id, e)}
                    />
                    <span class="text-text-muted pl-0.5 text-xs" aria-hidden="true"
                      >{m.form_pgrid_euro()}</span
                    >
                  </span>
                </td>
              {/if}
              {#each grid.columns as column (column.id)}
                {@const closed = isCellClosed(grid, row.id, column.id)}
                <td class="px-1 py-0.5">
                  <button
                    type="button"
                    aria-pressed={closed}
                    data-cell="{row.id}:{column.id}"
                    onclick={() => {
                      tableFeedback = '';
                      toggleClosedCell(grid, row.id, column.id);
                    }}
                    aria-label={closed
                      ? m.form_pgrid_cell_closed_aria({ row: row.label, column: column.label })
                      : m.form_pgrid_cell_open_aria({ row: row.label, column: column.label })}
                    title={closed
                      ? m.form_pgrid_cell_reopen_title()
                      : m.form_pgrid_cell_close_title()}
                    class="h-11 w-full min-w-18 rounded-lg text-xs transition-colors {closed
                      ? 'border-text-muted bg-cn-surface-alt text-text-main border border-dashed font-bold line-through'
                      : 'bg-cn-surface text-text-muted hover:bg-cn-yellow/15 border border-black/10 font-semibold dark:border-white/10'}"
                    >{closed
                      ? m.form_pgrid_cell_closed()
                      : cellPriceLabel(row.id, column.id)}</button
                  >
                </td>
              {/each}
              <td></td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td class="pt-1.5" colspan={grid.columns.length + 3}>
              <button
                type="button"
                onclick={() => addEntry('rows')}
                class="text-text-muted hover:text-text-main inline-flex min-h-11 items-center gap-2 px-1 text-sm font-bold"
              >
                <Plus size={16} />
                {m.form_pgrid_add_row()}
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="text-text-muted pt-1 text-xs">{m.form_pgrid_close_hint()}</p>
    {#if tableFeedback}
      <p class="text-red-err pt-1 text-xs font-semibold" role="status" data-testid="table-feedback">
        {tableFeedback}
      </p>
    {/if}
    {#if duplicateRows.size > 0 || duplicateColumns.size > 0}
      <p class="text-red-err pt-1 text-xs font-semibold" role="alert">
        {m.form_pgrid_refusal_duplicate_label()}
      </p>
    {/if}
    {#if problem}
      <p class="text-red-err pt-1 text-xs font-semibold" role="alert" data-testid="grid-problem">
        {problem}
      </p>
    {/if}
  </div>

  <!-- What a buyer sees: the fill page's own component, forced to one drawing, at the prices of
       the tab on screen. Inert - a preview takes no order. -->
  <section
    class="space-y-3 border-t border-black/10 pt-4 dark:border-white/10"
    aria-label={m.form_pgrid_preview_aria()}
  >
    <div class="flex flex-wrap items-center gap-3">
      <span class="text-text-main flex-1 text-sm font-bold">
        {tierIds.length > 1
          ? m.form_pgrid_preview_title_tier({ tier: tierName(activeTier) })
          : m.form_pgrid_preview_title()}
      </span>
      <SegmentedControl
        label={m.form_pgrid_preview_size_aria()}
        value={previewLayout}
        onSelect={(key) => (previewLayout = key)}
        items={[
          { key: 'desktop', label: m.form_pgrid_preview_desktop(), icon: Monitor },
          { key: 'phone', label: m.form_pgrid_preview_phone(), icon: Smartphone },
        ]}
        class="w-full sm:w-64"
      />
    </div>
    <div
      class="bg-cn-bg rounded-lg p-4 {previewLayout === 'phone' ? 'mx-auto max-w-sm' : ''}"
      inert
      data-testid="grid-preview-{previewLayout}"
    >
      <ProductGridQuestion
        item={previewItem}
        grid={previewGrid}
        value={{}}
        disabled={false}
        prices={previewPrices}
        layout={previewLayout}
      />
    </div>
  </section>
</div>
