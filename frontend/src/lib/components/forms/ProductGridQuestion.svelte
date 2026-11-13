<script lang="ts">
  import type { FormItem } from '$lib/forms/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import {
    cellQuantity,
    cellUnitCents,
    isCellClosed,
    lowestUnitCents,
    withCellQuantity,
  } from '$lib/forms/productGridFill';
  import {
    productGridCellKey,
    type ProductGridAxisEntry,
    type ProductGridView,
    type ProductGridViewerPrices,
  } from '$lib/forms/productGridContract';
  import { tick } from 'svelte';
  import { CircleAlert, Minus, Plus } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * A PRICED GRID BEING FILLED IN (`product_grid`, WP-G2) - one product, rows x columns of
   * quantities, at the prices of the viewer's category.
   *
   * Two drawings of ONE answer, chosen by the width alone (`sm`, 640px), so nothing scrolls sideways
   * on a phone: from 640px a table (a "+" per cell that becomes a - n + stepper, a checkbox when
   * `maxPerCell` is 1), below it a card per row whose sizes are pills (a tapped pill becomes
   * "M x1" with - and +). Closed cells are drawn struck through and take no click; a grid of one
   * row has no row label. The design is the owner's mockup of 2026-11-06 (`Fill-Desktop`,
   * `Fill-Mobile`), drawn with the app's tokens.
   *
   * The answer is `{ "rowId:colId": quantity }`, holding only the cells ordered
   * (`withCellQuantity`), and each change writes a NEW object so the page's `bind:value` sees it.
   * The prices shown are the ones the server resolved for this viewer; the server charges its own.
   */
  interface Props {
    item: FormItem;
    /** The grid itself (`item.productGrid`), handed apart so the type says it is present. */
    grid: ProductGridView;
    /** The answer, bound: `"rowId:colId"` -> quantity. */
    value: unknown;
    disabled: boolean;
    /** This viewer's prices on this grid; absent only on a server older than the priced grid. */
    prices?: ProductGridViewerPrices;
    currency?: string;
    /** Why the page refused to send - said under the grid, which is drawn in the error colour. */
    error?: string | null;
    /**
     * Which drawing shows: by the width (`responsive`, the fill pages), or one of the two forced -
     * the editor's preview (`ProductGridEditor.svelte`) shows either at any width.
     */
    layout?: 'responsive' | 'desktop' | 'phone';
  }

  let {
    item,
    grid,
    value = $bindable(),
    disabled,
    prices,
    currency = 'eur',
    error = null,
    layout = 'responsive',
  }: Props = $props();

  /** The classes that show or hide each drawing, by `layout`. */
  const desktopShown = $derived(
    layout === 'responsive' ? 'hidden sm:block' : layout === 'desktop' ? 'block' : 'hidden'
  );
  const phoneShown = $derived(
    layout === 'responsive' ? 'flex sm:hidden' : layout === 'phone' ? 'flex' : 'hidden'
  );
  const hintDesktopShown = $derived(
    layout === 'responsive' ? 'hidden sm:inline' : layout === 'desktop' ? 'inline' : 'hidden'
  );
  const hintPhoneShown = $derived(
    layout === 'responsive' ? 'sm:hidden' : layout === 'phone' ? 'inline' : 'hidden'
  );

  const multiRow = $derived(grid.rows.length > 1);
  const checkbox = $derived(grid.maxPerCell === 1);
  const mode = $derived(grid.pricing.mode);
  const hasClosed = $derived((grid.closedCells ?? []).length > 0);
  const headingId = $derived(`pg-${item.id}`);

  /** The header's price: the one price, or "from" the lowest when rows or sizes differ. */
  const headerPrice = $derived.by(() => {
    const lowest = lowestUnitCents(grid, prices);
    if (lowest === null) return null;
    const uniform = grid.rows.every((row) =>
      grid.columns.every(
        (col) =>
          isCellClosed(grid, row.id, col.id) ||
          cellUnitCents(grid, prices, row.id, col.id) === lowest
      )
    );
    const amount = formatAmount(lowest, currency);
    return uniform ? amount : m.form_grid_price_from({ amount });
  });

  /** The price written on an axis entry (a row in `per_row`, a column in `per_column`), or ''. */
  function axisPrice(axis: 'row' | 'column', entry: ProductGridAxisEntry): string {
    if ((axis === 'row' && mode !== 'per_row') || (axis === 'column' && mode !== 'per_column')) {
      return '';
    }
    const cents = prices?.prices[entry.id];
    return cents === undefined ? '' : formatAmount(cents, currency);
  }

  /** What a cell is called aloud: "Sweat capuche Noir M" (no row in a one-row grid). */
  function cellName(row: ProductGridAxisEntry, col: ProductGridAxisEntry): string {
    return [item.label, multiRow ? row.label : null, col.label].filter(Boolean).join(' ');
  }

  /**
   * Sets one cell. `event` is the click that asked: when the cell crosses 0 the control pressed is
   * replaced (a "+" becomes a stepper, a stepper at 1 goes back to a "+"), so keyboard focus follows
   * to the replacement's entry control (`data-cell-entry`) in the same drawing rather than falling
   * to the page body.
   */
  async function setQuantity(
    row: ProductGridAxisEntry,
    col: ProductGridAxisEntry,
    quantity: number,
    event?: Event
  ) {
    if (disabled || isCellClosed(grid, row.id, col.id)) return;
    Log.d('ProductGridQuestion', `${item.id} ${row.id}:${col.id} -> ${quantity}`);
    const pressed = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const drawing = pressed?.closest('[data-grid-desktop], [data-grid-phone]');
    value = withCellQuantity(value, grid, row.id, col.id, quantity);
    if (!pressed || !drawing) return;
    await tick();
    if (pressed.isConnected) return;
    const key = productGridCellKey(row.id, col.id);
    const entry = drawing.querySelector<HTMLElement>(`[data-cell-entry="${key}"]`);
    Log.d('ProductGridQuestion', `${item.id} ${key}: focus follows (${entry ? 'found' : 'none'})`);
    entry?.focus();
  }
</script>

<!-- One cell of the desktop table: struck through when closed, a checkbox at a cap of 1, else a
     "+" that becomes a - n + stepper. -->
{#snippet tableCell(row: ProductGridAxisEntry, col: ProductGridAxisEntry)}
  {@const qty = cellQuantity(value, row.id, col.id)}
  {@const name = cellName(row, col)}
  {#if isCellClosed(grid, row.id, col.id)}
    <span
      data-cell-closed
      role="img"
      aria-label={m.form_grid_cell_closed_aria({ name })}
      class="border-text-muted/60 bg-cn-border/30 text-text-muted text-2xs mx-auto flex h-8 w-11 items-center justify-center rounded-lg border border-dashed line-through"
      >{col.label}</span
    >
  {:else if checkbox}
    <label class="mx-auto flex h-11 w-11 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        class="accent-accent h-5 w-5"
        checked={qty > 0}
        aria-label={name}
        {disabled}
        onchange={() => setQuantity(row, col, qty > 0 ? 0 : 1)}
      />
    </label>
  {:else if qty === 0}
    <button
      type="button"
      data-cell-add
      class="ui-icon-button border-cn-border text-text-main hover:bg-cn-border/40 mx-auto rounded-full border bg-(--cn-surface) transition-colors disabled:opacity-50"
      aria-label={m.form_grid_add_cell({ name })}
      data-cell-entry={productGridCellKey(row.id, col.id)}
      {disabled}
      onclick={(event) => setQuantity(row, col, 1, event)}
    >
      <Plus size={16} strokeWidth={2.5} />
    </button>
  {:else}
    <span
      role="group"
      aria-label={name}
      data-cell-stepper
      class="border-accent-icon bg-accent/20 text-text-main mx-auto flex w-fit items-center rounded-full border"
    >
      <button
        type="button"
        class="flex h-11 w-8 items-center justify-center disabled:opacity-50"
        aria-label={m.form_grid_remove_one({ name })}
        {disabled}
        onclick={(event) => setQuantity(row, col, qty - 1, event)}
      >
        <Minus size={14} strokeWidth={2.5} />
      </button>
      <span aria-live="polite" class="min-w-4 text-center font-bold tabular-nums">{qty}</span>
      <button
        type="button"
        class="flex h-11 w-8 items-center justify-center disabled:opacity-35"
        aria-label={m.form_grid_add_one({ name })}
        data-cell-entry={productGridCellKey(row.id, col.id)}
        disabled={disabled || qty >= grid.maxPerCell}
        onclick={(event) => setQuantity(row, col, qty + 1, event)}
      >
        <Plus size={14} strokeWidth={2.5} />
      </button>
    </span>
  {/if}
{/snippet}

<!-- One size of a phone card: a pill, a toggled pill at a cap of 1, or "M x2" with - and +. -->
{#snippet pill(row: ProductGridAxisEntry, col: ProductGridAxisEntry)}
  {@const qty = cellQuantity(value, row.id, col.id)}
  {@const name = cellName(row, col)}
  {@const price = axisPrice('column', col)}
  {#if isCellClosed(grid, row.id, col.id)}
    <span
      data-cell-closed
      role="img"
      aria-label={m.form_grid_cell_closed_aria({ name })}
      class="border-text-muted/60 text-text-muted flex h-11 min-w-12 items-center justify-center rounded-full border border-dashed px-3 text-xs line-through"
      >{col.label}</span
    >
  {:else if checkbox || qty === 0}
    <button
      type="button"
      data-cell-pill
      class="flex h-11 min-w-12 items-center justify-center gap-1.5 rounded-full border px-3 font-bold transition-colors disabled:opacity-50 {qty >
      0
        ? 'border-accent-icon bg-accent/20 text-text-main'
        : 'border-cn-border text-text-main bg-(--cn-surface)'}"
      aria-label={checkbox ? name : m.form_grid_add_cell({ name })}
      aria-pressed={checkbox ? qty > 0 : undefined}
      data-cell-entry={productGridCellKey(row.id, col.id)}
      {disabled}
      onclick={(event) => setQuantity(row, col, checkbox && qty > 0 ? 0 : 1, event)}
    >
      {col.label}
      {#if price}<span class="text-text-muted text-2xs font-semibold">{price}</span>{/if}
    </button>
  {:else}
    <!-- The - and + are h-11 themselves, never h-full: the pill's 1px border leaves 42px inside it,
         and the centred buttons overlap that border to keep the 44px touch target. -->
    <span
      role="group"
      aria-label={name}
      data-cell-stepper
      class="border-accent-icon bg-accent/20 text-text-main flex h-11 items-center rounded-full border"
    >
      <button
        type="button"
        class="flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-50"
        aria-label={m.form_grid_remove_one({ name })}
        {disabled}
        onclick={(event) => setQuantity(row, col, qty - 1, event)}
      >
        <Minus size={14} strokeWidth={2.5} />
      </button>
      <span aria-live="polite" class="font-bold whitespace-nowrap tabular-nums"
        >{m.form_grid_pill_quantity({ size: col.label, quantity: qty })}</span
      >
      <button
        type="button"
        class="flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-35"
        aria-label={m.form_grid_add_one({ name })}
        data-cell-entry={productGridCellKey(row.id, col.id)}
        disabled={disabled || qty >= grid.maxPerCell}
        onclick={(event) => setQuantity(row, col, qty + 1, event)}
      >
        <Plus size={14} strokeWidth={2.5} />
      </button>
    </span>
  {/if}
{/snippet}

<section
  id={`q-${item.id}`}
  aria-labelledby={headingId}
  data-product-grid
  class="overflow-hidden rounded-2xl bg-(--cn-surface) shadow-sm {error
    ? 'border-red-err border-2'
    : 'border-cn-border border'}"
>
  {#if item.imageUrl}
    <img
      src={item.imageUrl}
      alt=""
      class="bg-cn-bg h-auto max-h-96 w-full object-contain"
      loading="lazy"
    />
  {/if}
  <div class="flex flex-col gap-3 p-4 sm:px-6 sm:py-5">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <!-- The asterisk of a grid switched "Obligatoire" (owner, 2026-11-13), as every question's. -->
      <h2
        id={headingId}
        class="text-text-main flex-1 text-sm font-bold whitespace-pre-line sm:text-base"
      >
        {item.label}
        {#if item.required}<span class="text-red-err ml-0.5" aria-hidden="true">*</span>{/if}
      </h2>
      {#if headerPrice}
        <span class="text-text-main text-sm font-bold sm:text-base" data-grid-price
          >{headerPrice}</span
        >
      {/if}
    </div>
    {#if item.description}
      <p class="text-text-muted -mt-2 text-xs whitespace-pre-line italic sm:text-sm">
        {item.description}
      </p>
    {/if}

    <!-- From 640px: a table. Scrolls sideways only past what the column holds (15 sizes). -->
    <div class="overflow-x-auto {desktopShown}" data-grid-desktop>
      <table class="w-full table-fixed border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {#if multiRow}<td class="w-28"></td>{/if}
            {#each grid.columns as col (col.id)}
              <th scope="col" class="text-text-main w-20 px-1 py-1.5 text-center text-xs font-bold">
                {col.label}
                {#if axisPrice('column', col)}
                  <span class="text-text-muted text-2xs block font-semibold"
                    >{axisPrice('column', col)}</span
                  >
                {/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each grid.rows as row, ri (row.id)}
            {@const striped = ri % 2 === 0 ? 'bg-cn-bg/70' : ''}
            <tr>
              {#if multiRow}
                <th
                  scope="row"
                  class="text-text-main rounded-l-lg px-3 py-1.5 text-left align-middle font-semibold {striped}"
                >
                  {row.label}
                  {#if axisPrice('row', row)}
                    <span class="text-text-muted block text-xs font-normal"
                      >{axisPrice('row', row)}</span
                    >
                  {/if}
                </th>
              {/if}
              {#each grid.columns as col, ci (col.id)}
                <td
                  class="h-14 px-1 text-center align-middle {striped} {!multiRow && ci === 0
                    ? 'rounded-l-lg'
                    : ''} {ci === grid.columns.length - 1 ? 'rounded-r-lg' : ''}"
                >
                  {@render tableCell(row, col)}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Below 640px: a card per row, its sizes as pills that wrap - never a sideways scroll. -->
    <div class="flex-col gap-2 {phoneShown}" data-grid-phone>
      {#each grid.rows as row, ri (row.id)}
        <div
          role="group"
          aria-label={multiRow ? `${item.label} ${row.label}` : item.label}
          class="flex flex-col gap-2 rounded-2xl {multiRow ? 'p-3' : ''} {multiRow && ri % 2 === 0
            ? 'bg-cn-bg/70'
            : ''}"
        >
          {#if multiRow}
            <div class="text-text-main flex justify-between gap-2 font-bold">
              <span>{row.label}</span>
              {#if axisPrice('row', row)}
                <span class="text-text-muted font-semibold">{axisPrice('row', row)}</span>
              {/if}
            </div>
          {/if}
          <div class="flex flex-wrap gap-1.5">
            {#each grid.columns as col (col.id)}
              {@render pill(row, col)}
            {/each}
          </div>
        </div>
      {/each}
    </div>

    {#if !disabled}
      <p class="text-text-muted text-xs">
        <span class={hintDesktopShown}>
          {checkbox
            ? m.form_grid_hint_desktop_single()
            : m.form_grid_hint_desktop({ max: grid.maxPerCell })}
        </span>
        <span class={hintPhoneShown}>
          {checkbox ? m.form_grid_hint_phone_single() : m.form_grid_hint_phone()}
        </span>
        {#if hasClosed}{m.form_grid_hint_closed()}{/if}
      </p>
    {/if}

    {#if error}
      <p role="alert" class="text-red-err flex items-center gap-2 text-xs font-bold">
        <CircleAlert size={16} class="shrink-0" />{error}
      </p>
    {/if}
  </div>
</section>
