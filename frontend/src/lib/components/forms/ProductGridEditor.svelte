<script lang="ts">
  import { Minus, Monitor, Plus, Smartphone, X } from '@lucide/svelte';
  import CriterionEditor from '$lib/components/pricing/CriterionEditor.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import InfoTip from '$lib/components/ui/InfoTip.svelte';
  import GridAxesTable from './GridAxesTable.svelte';
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
    tierSwitchLosesInput,
    syncTierLists,
    toggleClosedCell,
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
   * where no drag reaches it, two arrow buttons per entry do. Below `sm` the table is drawn to fit
   * a phone: the row labels narrow and wrap, a row's arrows sit under its label, a column's chip
   * stacks its controls, and a cell shows its state without its price - six sizes fit at 390px. A
   * wider grid scrolls inside its own box, the row labels sticky. Clicking a cell closes the combination
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
    /**
     * Only what a new grid cannot do without - its rows, columns and prices - as the add wizard's
     * second step draws it; the cap per cell and the buyer's preview stay in the question card.
     */
    essentials?: boolean;
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
    essentials = false,
  }: Props = $props();

  const TAG = 'ProductGridEditor';

  const tierIds = $derived(editorTierIds(grid));
  let selectedTier = $state<string>(PRODUCT_GRID_ALL_TIER);
  /** The tab on screen; falls back to the first category when the chosen one is gone. */
  const activeTier = $derived(tierIds.includes(selectedTier) ? selectedTier : tierIds[0]);
  const mode = $derived(grid.pricing.mode);

  /** Why the last removal was refused, said under the table where the gesture was made. */
  let tableFeedback = $state('');

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

  /**
   * Appends a pasted list. The one blank entry a new grid starts with gives way to it rather than
   * stay beside it (an axis is never left empty: the list is appended in the same step).
   */
  function addPasted(axis: ProductGridAxis, labels: string[]) {
    const list = grid[axis];
    if (list.length === 1 && !list[0].label.trim()) {
      grid[axis] = [];
      Log.d(TAG, `the blank ${axis} starter gives way to a pasted list`);
    }
    return addAxisEntries(grid, axis, labels);
  }

  function renameEntry(axis: ProductGridAxis, id: string, label: string) {
    const entry = grid[axis].find((e) => e.id === id);
    if (entry) entry.label = label;
  }

  // Categories: off, or one profile criterion.
  const tiered = $derived(grid.pricing.tiers !== null);
  const cotisationAvailable = $derived(tiers.length > 0);

  /**
   * Runs `leave` - a switch of criterion, the registration grid's copy, or one price for everybody -
   * once the manager agrees to lose the groups or prices they entered (owner, 2026-11-07: "il
   * faudrait m'avertir que tout ce que j'ai rentre va etre efface"). A criterion still as it
   * started loses nothing: it is left at once, with no question.
   */
  function leaveTiers(leave: () => void) {
    if (!tierSwitchLosesInput(grid)) {
      leave();
      return;
    }
    Log.d(TAG, 'leaving the criterion would erase entered groups or prices: asking first');
    void showConfirm(m.form_pgrid_tiers_switch_confirm(), {
      danger: true,
      confirmLabel: m.form_pgrid_tiers_switch_confirm_button(),
    }).then((ok) => {
      if (ok) leave();
      else Log.d(TAG, 'criterion switch cancelled: the entered groups and prices stay');
    });
  }

  function startTiers(kind: 'cotisation' | 'promo' | 'formation') {
    leaveTiers(() => setTiers(grid, newDimension(kind) as ProductGridTierDimension));
  }

  function copyFormTiers() {
    const source = formTiers;
    if (!source) return;
    leaveTiers(() =>
      setTiers(grid, JSON.parse(JSON.stringify(source)) as ProductGridTierDimension)
    );
  }

  function stopTiers() {
    leaveTiers(() => {
      setTiers(grid, null);
      selectedTier = PRODUCT_GRID_ALL_TIER;
    });
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
  <!-- Settings bar: price mode and cap per cell (the cap stays in the card, never in the wizard). -->
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

    {#if !essentials}
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
    {/if}
  </div>

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
        <!-- One criterion only, said where it is chosen (owner, 2026-11-07). -->
        <InfoTip label={m.form_pgrid_tiers_info_aria()} text={m.form_pgrid_tiers_info()} />
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

    <!-- The table: the shared rows-and-columns editor, the cells and prices drawn here. -->
    <GridAxesTable
      rows={grid.rows}
      columns={grid.columns}
      isDuplicate={(axis, label) =>
        (axis === 'rows' ? duplicateRows : duplicateColumns).has(productGridLabelKey(label))}
      onRename={renameEntry}
      onAddBlank={(axis) => addBlankEntry(grid, axis)}
      onAddMany={addPasted}
      onMove={(axis, from, to) => moveAxisEntry(grid, axis, from, to)}
      onRemove={removeEntry}
      maxOf={axisMax}
      rowPlaceholder={m.form_pgrid_row_placeholder()}
      columnPlaceholder={m.form_pgrid_column_placeholder()}
    >
      {#snippet afterCornerHeader()}
        {#if mode === 'per_row'}
          <th scope="col" class="text-text-muted w-24 px-1.5 pb-2 text-left text-xs font-bold"
            >{m.form_pgrid_price_header()}</th
          >
        {/if}
      {/snippet}
      {#snippet headerRow()}
        {#if mode === 'per_column'}
          <tr>
            <th
              scope="row"
              class="text-text-main bg-cn-surface sticky left-0 z-1 pr-2 pb-2 text-left text-xs font-bold"
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
      {/snippet}
      {#snippet afterRowLabel(row)}
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
      {/snippet}
      {#snippet cell(row, column)}
        {@const closed = isCellClosed(grid, row.id, column.id)}
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
          title={closed ? m.form_pgrid_cell_reopen_title() : m.form_pgrid_cell_close_title()}
          class="flex h-11 w-full min-w-18 items-center justify-center rounded-lg text-xs transition-colors max-sm:min-w-0 {closed
            ? 'border-text-muted bg-cn-surface-alt text-text-main border border-dashed font-bold line-through'
            : 'bg-cn-surface text-text-muted hover:bg-cn-yellow/15 border border-black/10 font-semibold dark:border-white/10'}"
          ><span class="max-sm:hidden"
            >{closed ? m.form_pgrid_cell_closed() : cellPriceLabel(row.id, column.id)}</span
          >{#if closed}<X size={14} class="sm:hidden" aria-hidden="true" />{/if}</button
        >
      {/snippet}
    </GridAxesTable>
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
  {#if !essentials}
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
  {/if}
</div>
